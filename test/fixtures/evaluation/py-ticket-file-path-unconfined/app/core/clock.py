from datetime import UTC, datetime, timedelta


def utcnow() -> datetime:
    return datetime.now(UTC)


def minutes_from(start: datetime, minutes: int) -> datetime:
    return start + timedelta(minutes=minutes)


def overdue(deadline: datetime | None, now: datetime | None = None) -> bool:
    return deadline is not None and deadline < (now or utcnow())
