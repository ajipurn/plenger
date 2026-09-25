"""Validated `plenger.yaml` project configuration."""

from typing import Any, Literal

from pydantic import Field, field_validator

from plenger.domain.base import StrictModel


class ProjectConfig(StrictModel):
    schema_version: Literal[1] = 1
    profile: Literal["deterministic", "baseline"] = "deterministic"
    # Defaults follow the SPEC; users may raise per-file and file-count limits
    # explicitly. The total stays bounded by the parser worker's input budget.
    max_files: int = Field(default=50000, ge=1, le=200000)
    max_file_bytes: int = Field(default=2097152, ge=1, le=16777216)
    max_total_bytes: int = Field(default=524288000, ge=1, le=524288000)

    @field_validator("schema_version", mode="before")
    @classmethod
    def integer_version(cls, value: Any) -> int:
        if type(value) is not int:
            raise ValueError("schema_version_requires_integer")
        return value

    # Config cannot grant consent, configure commands, or enable active/hosted work.
