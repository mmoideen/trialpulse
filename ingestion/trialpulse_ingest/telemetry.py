"""OpenTelemetry spans + structured logging for the ingestion pipeline.

PRD 8.4: "OpenTelemetry tracing across all Functions" with custom
dimensions on every span. This module provides a single `traced_span`
context manager the rest of the pipeline uses so every stage (extract,
chunk, embed, index) reports consistently, plus a JSON structured logger.

`opentelemetry-api` (not the SDK) is a required dependency -- with no SDK
configured, its tracer is a documented, safe no-op, so creating spans here
never requires a configured exporter or network access. Production wires up
`opentelemetry-sdk` + the Azure Monitor exporter at the Azure Functions
host level; this module only needs the API.
"""

from __future__ import annotations

import json
import logging
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from opentelemetry import trace

_tracer = trace.get_tracer("trialpulse.ingestion")


@contextmanager
def traced_span(name: str, **attributes: Any) -> Iterator[trace.Span]:
    """Start a span named `name` with the given custom-dimension attributes.

    Records the exception (if any) on the span before letting it propagate,
    so failures are visible in traces even though this module never
    swallows errors itself.
    """
    with _tracer.start_as_current_span(name) as span:
        for key, value in attributes.items():
            span.set_attribute(key, value if isinstance(value, (str, bool, int, float)) else str(value))
        try:
            yield span
        except BaseException as exc:  # noqa: BLE001 -- re-raised immediately; recording is the only side effect
            span.record_exception(exc)
            span.set_attribute("error", True)
            raise


class _JsonFormatter(logging.Formatter):
    """Renders each log record as a single JSON line for log-analytics ingestion."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        extra = getattr(record, "trialpulse_fields", None)
        if isinstance(extra, dict):
            payload.update(extra)
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def get_logger(name: str = "trialpulse.ingestion") -> logging.Logger:
    """A structured (JSON-line) logger, configured once per process."""
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler(stream=sys.stdout)
        handler.setFormatter(_JsonFormatter())
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False
    return logger


def log_event(logger: logging.Logger, message: str, /, **fields: Any) -> None:
    """Log `message` with structured `fields` attached (role, document_id,
    chunk counts, latency_ms, etc. -- whatever the caller's stage cares
    about), matching PRD 8.4's "custom dimensions on every span"."""
    logger.info(message, extra={"trialpulse_fields": fields})
