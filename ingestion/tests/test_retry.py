"""Retry with exponential backoff + jitter, and dead-letter behaviour."""

from __future__ import annotations

import random

import pytest

from trialpulse_ingest.retry import (
    PermanentError,
    TransientError,
    classify_exception,
    with_retry,
)


class _FakeHttpError(Exception):
    def __init__(self, status_code: int) -> None:
        super().__init__(f"HTTP {status_code}")
        self.status_code = status_code


def test_classify_transient_http_statuses() -> None:
    for status in (408, 429, 500, 502, 503, 504):
        assert classify_exception(_FakeHttpError(status)) == "transient"


def test_classify_permanent_http_statuses() -> None:
    for status in (400, 401, 403, 404, 409, 410, 422):
        assert classify_exception(_FakeHttpError(status)) == "permanent"


def test_classify_timeout_is_transient() -> None:
    assert classify_exception(TimeoutError("timed out")) == "transient"


def test_classify_unknown_exception_is_permanent() -> None:
    assert classify_exception(ValueError("boom")) == "permanent"


def test_classify_marker_exceptions() -> None:
    assert classify_exception(TransientError("x")) == "transient"
    assert classify_exception(PermanentError("x")) == "permanent"


def test_succeeds_on_first_attempt_no_sleep() -> None:
    calls = []
    sleeps: list[float] = []

    def fn() -> str:
        calls.append(1)
        return "ok"

    outcome = with_retry(fn, operation="test_op", sleep=sleeps.append)
    assert outcome.succeeded is True
    assert outcome.result == "ok"
    assert outcome.attempts == 1
    assert outcome.dead_letter is None
    assert sleeps == []


def test_retries_transient_then_succeeds() -> None:
    attempts_made = {"n": 0}
    sleeps: list[float] = []

    def fn() -> str:
        attempts_made["n"] += 1
        if attempts_made["n"] < 3:
            raise TransientError("temporary blip")
        return "recovered"

    outcome = with_retry(
        fn,
        operation="test_op",
        max_attempts=3,
        sleep=sleeps.append,
        rng=random.Random(42),
    )
    assert outcome.succeeded is True
    assert outcome.result == "recovered"
    assert outcome.attempts == 3
    assert outcome.dead_letter is None
    # Two retries happened (after attempt 1 and attempt 2), so two sleeps.
    assert len(sleeps) == 2
    assert all(delay >= 0 for delay in sleeps)


def test_exhausts_retries_and_dead_letters_transient_failure() -> None:
    sleeps: list[float] = []

    def always_fails() -> None:
        raise TransientError("always broken")

    outcome = with_retry(
        always_fails,
        operation="ingest_document",
        context={"document_id": "sp-prot-0001"},
        max_attempts=3,
        sleep=sleeps.append,
        rng=random.Random(1),
    )
    assert outcome.succeeded is False
    assert outcome.result is None
    assert outcome.attempts == 3
    assert len(sleeps) == 2  # backoff before attempt 2 and attempt 3, none after the final failure
    assert outcome.dead_letter is not None
    assert outcome.dead_letter.operation == "ingest_document"
    assert outcome.dead_letter.attempts == 3
    assert outcome.dead_letter.error_class == "transient"
    assert outcome.dead_letter.last_error_type == "TransientError"
    assert outcome.dead_letter.context == {"document_id": "sp-prot-0001"}
    assert outcome.dead_letter.failed_at  # non-empty ISO timestamp


def test_permanent_failure_does_not_retry() -> None:
    calls = {"n": 0}
    sleeps: list[float] = []

    def fails_permanently() -> None:
        calls["n"] += 1
        raise PermanentError("malformed payload")

    outcome = with_retry(fails_permanently, operation="ingest_document", sleep=sleeps.append)
    assert outcome.succeeded is False
    assert outcome.attempts == 1
    assert calls["n"] == 1
    assert sleeps == []
    assert outcome.dead_letter is not None
    assert outcome.dead_letter.error_class == "permanent"


def test_backoff_delays_grow_and_respect_jitter_bounds() -> None:
    sleeps: list[float] = []

    def always_fails() -> None:
        raise TransientError("still broken")

    outcome = with_retry(
        always_fails,
        operation="op",
        max_attempts=4,
        base_delay_seconds=1.0,
        max_delay_seconds=30.0,
        sleep=sleeps.append,
        rng=random.Random(7),
    )
    assert outcome.attempts == 4
    assert len(sleeps) == 3
    # Equal-jitter backoff: delay for attempt n is in [d/2, d] where
    # d = min(max_delay, base * 2**(n-1)).
    expected_caps = [1.0, 2.0, 4.0]
    for delay, cap in zip(sleeps, expected_caps, strict=True):
        assert cap / 2 <= delay <= cap


@pytest.mark.parametrize("status", [500, 429])
def test_http_style_exception_end_to_end(status: int) -> None:
    def fn() -> None:
        raise _FakeHttpError(status)

    outcome = with_retry(fn, operation="op", max_attempts=2, sleep=lambda _: None)
    assert outcome.attempts == 2
    assert outcome.dead_letter is not None
    assert outcome.dead_letter.error_class == "transient"
