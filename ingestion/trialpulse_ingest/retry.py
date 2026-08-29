"""Retry with exponential backoff + jitter, and dead-lettering.

PRD workflow 3.3.1: "Retry policy: Exponential backoff with 3 retries for
transient failures; dead-letter queue after final failure." Transient
failures (429 rate limit, 5xx, timeouts) are retried; permanent failures
(404, 401, malformed payloads) are not -- retrying a 404 just wastes time
and delays the dead-letter signal that something needs a human.
"""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Generic, Literal, TypeVar

from trialpulse_ingest.constants import (
    MAX_RETRY_ATTEMPTS,
    RETRY_BASE_DELAY_SECONDS,
    RETRY_MAX_DELAY_SECONDS,
)

T = TypeVar("T")

ErrorClass = Literal["transient", "permanent"]

#: HTTP status codes treated as transient: rate limiting and server-side errors.
TRANSIENT_HTTP_STATUS_CODES = frozenset({408, 429, 500, 502, 503, 504})

#: HTTP status codes treated as permanent: the request itself is the problem.
PERMANENT_HTTP_STATUS_CODES = frozenset({400, 401, 403, 404, 409, 410, 422})


class TransientError(Exception):
    """Raised (or wrapped) for failures worth retrying: 429/5xx/timeouts."""


class PermanentError(Exception):
    """Raised (or wrapped) for failures that will never succeed on retry."""


def classify_exception(exc: BaseException) -> ErrorClass:
    """Classify an exception as transient (retry) or permanent (dead-letter now).

    Checked in order:
    1. Our own `TransientError`/`PermanentError` markers.
    2. A `status_code` attribute (as httpx/requests HTTPStatusError-style
       exceptions expose), matched against known transient/permanent sets.
    3. `TimeoutError` (and subclasses, e.g. `asyncio.TimeoutError`) -> transient.
    4. Anything else is treated as permanent. This is a deliberate,
       documented choice: an unrecognised exception (e.g. a bug in our own
       code, a malformed payload) is far more likely to fail again
       identically than to be a transient blip, so we fail fast to the
       dead-letter queue rather than burning 3 retries and delaying
       visibility into a real problem.
    """
    if isinstance(exc, TransientError):
        return "transient"
    if isinstance(exc, PermanentError):
        return "permanent"

    status_code = getattr(exc, "status_code", None)
    if status_code is None:
        response = getattr(exc, "response", None)
        status_code = getattr(response, "status_code", None)
    if isinstance(status_code, int):
        if status_code in TRANSIENT_HTTP_STATUS_CODES:
            return "transient"
        if status_code in PERMANENT_HTTP_STATUS_CODES:
            return "permanent"
        # Unknown 4xx/5xx: treat >=500 as transient, everything else permanent.
        return "transient" if status_code >= 500 else "permanent"

    if isinstance(exc, TimeoutError):
        return "transient"

    return "permanent"


@dataclass(frozen=True, slots=True)
class DeadLetterRecord:
    """Full failure context recorded when retries are exhausted (or a
    permanent error is hit on the first attempt)."""

    operation: str
    attempts: int
    error_class: ErrorClass
    last_error_type: str
    last_error_message: str
    context: dict[str, Any]
    failed_at: str


@dataclass(frozen=True, slots=True)
class RetryOutcome(Generic[T]):
    succeeded: bool
    result: T | None
    attempts: int
    dead_letter: DeadLetterRecord | None
    delays: list[float] = field(default_factory=list)
    """Delay (seconds) actually used before each retry attempt, for testing."""


def _equal_jitter_delay(attempt: int, *, base_delay: float, max_delay: float, rng: random.Random) -> float:
    """Equal-jitter exponential backoff: half fixed, half random.

    `attempt` is 1-based (the attempt number that just failed). Equal jitter
    (as opposed to full jitter) guarantees a minimum backoff of delay/2,
    which avoids a thundering-herd retry storm hammering a struggling
    dependency with near-zero-delay retries while still spreading retries
    out to avoid synchronized bursts.
    """
    delay = min(max_delay, base_delay * (2 ** (attempt - 1)))
    return delay / 2 + rng.uniform(0, delay / 2)


def with_retry(
    fn: Callable[[], T],
    *,
    operation: str,
    context: dict[str, Any] | None = None,
    max_attempts: int = MAX_RETRY_ATTEMPTS,
    base_delay_seconds: float = RETRY_BASE_DELAY_SECONDS,
    max_delay_seconds: float = RETRY_MAX_DELAY_SECONDS,
    classify: Callable[[BaseException], ErrorClass] = classify_exception,
    sleep: Callable[[float], None] = time.sleep,
    rng: random.Random | None = None,
) -> RetryOutcome[T]:
    """Call `fn()`, retrying transient failures with exponential backoff + jitter.

    Permanent failures are not retried at all. `sleep` and `rng` are
    injectable so tests never actually wait in real time or depend on
    non-deterministic timing.
    """
    rng = rng if rng is not None else random.Random()
    context = context or {}
    delays: list[float] = []
    last_exc: BaseException | None = None
    error_class: ErrorClass = "permanent"
    attempts = 0

    while attempts < max_attempts:
        attempts += 1
        try:
            result = fn()
        except BaseException as exc:  # noqa: BLE001 -- must classify *any* failure, re-raising is not an option here
            last_exc = exc
            error_class = classify(exc)
            if error_class == "permanent" or attempts >= max_attempts:
                break
            delay = _equal_jitter_delay(
                attempts, base_delay=base_delay_seconds, max_delay=max_delay_seconds, rng=rng
            )
            delays.append(delay)
            sleep(delay)
            continue
        else:
            return RetryOutcome(succeeded=True, result=result, attempts=attempts, dead_letter=None, delays=delays)

    assert last_exc is not None, "with_retry exited its loop without ever calling fn()"
    dead_letter = DeadLetterRecord(
        operation=operation,
        attempts=attempts,
        error_class=error_class,
        last_error_type=type(last_exc).__name__,
        last_error_message=str(last_exc),
        context=context,
        failed_at=datetime.now(UTC).isoformat(),
    )
    return RetryOutcome(succeeded=False, result=None, attempts=attempts, dead_letter=dead_letter, delays=delays)
