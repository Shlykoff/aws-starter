"""Timestamps. Everything is UTC, written with a trailing Z as reply.xsd's xs:dateTime wants."""

from datetime import UTC, datetime


def utc_now() -> datetime:
    return datetime.now(UTC)


def format_utc(moment: datetime) -> str:
    """2026-09-21T10:11:12.123Z: millisecond precision, always UTC."""
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
