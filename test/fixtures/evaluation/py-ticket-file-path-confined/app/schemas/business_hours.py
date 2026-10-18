from datetime import date

from pydantic import BaseModel, Field, field_validator


class BusinessHoursOut(BaseModel):
    timezone: str
    schedule: dict[str, list[list[int]]]
    holidays: list[str]


class BusinessHoursUpdate(BaseModel):
    timezone: str = Field(max_length=64)
    schedule: dict[str, list[list[int]]]
    holidays: list[date] = Field(default_factory=list, max_length=60)

    @field_validator("schedule")
    @classmethod
    def check_schedule(cls, schedule: dict[str, list[list[int]]]) -> dict[str, list[list[int]]]:
        for weekday, windows in schedule.items():
            if weekday not in {"0", "1", "2", "3", "4", "5", "6"}:
                raise ValueError(f"unknown weekday {weekday}")
            for window in windows:
                if len(window) != 2 or not 0 <= window[0] < window[1] <= 24 * 60:
                    raise ValueError(f"invalid window {window} on weekday {weekday}")
        return schedule
