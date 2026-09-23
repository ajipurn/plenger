"""Declarative active-test policy; this module never dispatches network requests."""

from __future__ import annotations

import ipaddress
import json
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

from pydantic import Field, field_validator, model_validator

from plenger.assessment_rubric import ACTIVE_RUBRIC_HASH
from plenger.domain import StrictModel
from plenger.domain.digests import digest


class PolicyViolation(ValueError):
    pass


class TargetSpec(StrictModel):
    target_ref: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    base_url: str = Field(min_length=8, max_length=512)
    environment: Literal["local", "staging"]
    allowed_paths: list[str] = Field(min_length=1, max_length=32)
    allowed_methods: list[Literal["GET", "POST", "PUT", "PATCH", "DELETE"]] = Field(
        min_length=1, max_length=5
    )
    allowed_ips: list[str] = Field(default_factory=list, max_length=32)
    auth_profile_ref: str | None = Field(default=None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    max_response_bytes: int = Field(default=1048576, ge=1, le=1048576)
    observability: Literal["none", "trace"] = "none"
    output_path: str = Field(default="output_text", min_length=1, max_length=128)
    trace_path: str | None = Field(default="trace", max_length=128)

    @field_validator("allowed_ips")
    @classmethod
    def canonical_allowed_ips(cls, value: list[str]) -> list[str]:
        try:
            addresses = tuple(ipaddress.ip_address(item) for item in value)
        except ValueError:
            raise ValueError("invalid_allowed_ip") from None
        if len(set(addresses)) != len(addresses):
            raise ValueError("duplicate_allowed_ip")
        return [
            str(address)
            for address in sorted(addresses, key=lambda address: (address.version, int(address)))
        ]

    @model_validator(mode="after")
    def validate_url(self) -> TargetSpec:
        parsed = urlsplit(self.base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("invalid_target_url")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("target_url_must_not_contain_credentials_or_query")
        if parsed.path not in {"", "/"}:
            raise ValueError("target_base_path_must_be_root")
        try:
            port = parsed.port
        except ValueError:
            raise ValueError("invalid_target_port") from None
        if port == 0:
            raise ValueError("invalid_target_port")
        if self.environment == "local" and port is None:
            raise ValueError("local_target_requires_explicit_port")
        host = parsed.hostname.lower()
        if "*" in host or host.endswith("."):
            raise ValueError("wildcard_or_absolute_target_host_forbidden")
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if self.environment == "local":
            if parsed.scheme != "http":
                raise ValueError("local_target_must_use_http_fixture")
            if host not in {"localhost", "127.0.0.1", "::1"} and not (
                address and address.is_loopback
            ):
                raise ValueError("local_target_must_be_loopback")
        elif parsed.scheme != "https":
            raise ValueError("staging_target_requires_https")
        if address and (
            address.is_unspecified
            or address.is_multicast
            or address.is_link_local
            or address.is_reserved
            or (self.environment == "staging" and (address.is_private or address.is_loopback))
        ):
            raise ValueError("unsafe_target_address")
        for path in self.allowed_paths:
            if not path.startswith("/") or "?" in path or "#" in path or ".." in path.split("/"):
                raise ValueError("invalid_allowed_path")
        if len(set(self.allowed_paths)) != len(self.allowed_paths):
            raise ValueError("duplicate_allowed_path")
        if len(set(self.allowed_methods)) != len(self.allowed_methods):
            raise ValueError("duplicate_allowed_method")
        allowed_addresses = tuple(ipaddress.ip_address(value) for value in self.allowed_ips)
        if self.environment == "local" and any(
            not address.is_loopback for address in allowed_addresses
        ):
            raise ValueError("allowed_ip_not_loopback")
        if self.environment == "staging" and any(
            not address.is_global for address in allowed_addresses
        ):
            raise ValueError("allowed_ip_not_public")
        return self

    @field_validator("output_path", "trace_path")
    @classmethod
    def safe_response_path(cls, value: str | None) -> str | None:
        if value is None:
            return None
        parts = value.split(".")
        if not 1 <= len(parts) <= 8 or any(
            not part or not part.replace("_", "").replace("-", "").isalnum() for part in parts
        ):
            raise ValueError("invalid_response_path")
        return value

    def digest(self) -> str:
        return digest(self.model_dump())


class BudgetSpec(StrictModel):
    max_cases: int = Field(default=40, ge=1, le=40)
    max_attempts: int = Field(default=80, ge=1, le=80)
    concurrency: int = Field(default=2, ge=1, le=2)
    request_timeout_seconds: int = Field(default=30, ge=1, le=30)
    wall_time_seconds: int = Field(default=600, ge=1, le=600)
    cost_guard: Literal["strict", "request_only"] = "strict"
    cost_acknowledged: bool = False

    @model_validator(mode="after")
    def cost_guard_requires_ack(self) -> BudgetSpec:
        if self.cost_guard == "request_only" and not self.cost_acknowledged:
            raise ValueError("request_only_cost_ack_required")
        return self


class PlanSpec(StrictModel):
    target: TargetSpec
    profile: Literal["owasp-llm-2025-core"] = "owasp-llm-2025-core"
    rubric_hash: str = Field(default=ACTIVE_RUBRIC_HASH, pattern=r"^[a-f0-9]{64}$")
    case_ids: list[str] = Field(min_length=1, max_length=40)
    snapshot_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    auth_identity: str = Field(min_length=1, max_length=128)
    data_classes: list[Literal["metadata", "code_excerpt", "prompt", "response", "trace"]] = Field(
        default_factory=list, max_length=5
    )
    budget: BudgetSpec = Field(default_factory=BudgetSpec)

    @field_validator("case_ids")
    @classmethod
    def unique_cases(cls, value: list[str]) -> list[str]:
        if any(not item or len(item) > 128 for item in value) or len(set(value)) != len(value):
            raise ValueError("invalid_case_ids")
        return value

    @model_validator(mode="after")
    def fit_case_budget(self) -> PlanSpec:
        if len(self.case_ids) > self.budget.max_cases:
            raise ValueError("case_budget_exceeded")
        if len(self.case_ids) > self.budget.max_attempts:
            raise ValueError("attempt_budget_exceeded")
        return self

    def digest(self, project_id: str) -> str:
        return digest({"project_id": project_id, **self.model_dump()})

    def profile_digest(self) -> str:
        return digest({"profile": self.profile, "case_ids": self.case_ids})

    def scope_digest(self, project_id: str) -> str:
        return digest(
            {
                "project_id": project_id,
                "profile_digest": self.profile_digest(),
                "rubric_hash": self.rubric_hash,
                "target": self.target.model_dump(),
                "cases": self.case_ids,
                "snapshot_digest": self.snapshot_digest,
                "auth_identity": self.auth_identity,
                "data_classes": self.data_classes,
                "budget": self.budget.model_dump(),
            }
        )


def dispatch_url(target: TargetSpec, method: str, path: str) -> str:
    """Validate one fixed path before a future broker resolves/dispatches it."""

    if method not in target.allowed_methods or path not in target.allowed_paths:
        raise PolicyViolation("target_scope_denied")
    if not path.startswith("/") or "?" in path or "#" in path or ".." in path.split("/"):
        raise PolicyViolation("invalid_dispatch_path")
    parsed = urlsplit(target.base_url)
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def preview(plan: PlanSpec, project_id: str) -> dict[str, object]:
    """Return the minimum user-visible consent preview; never include secret values."""

    parsed_origin = urlsplit(plan.target.base_url)
    return {
        "project_id": project_id,
        "plan_digest": plan.digest(project_id),
        "scope_digest": plan.scope_digest(project_id),
        "profile": plan.profile,
        "profile_digest": plan.profile_digest(),
        "rubric_hash": plan.rubric_hash,
        "target_ref": plan.target.target_ref,
        "target_revision": plan.target.digest(),
        "environment": plan.target.environment,
        "base_origin": f"{parsed_origin.scheme}://{parsed_origin.netloc}",
        "allowed_ips": plan.target.allowed_ips,
        "allowed_paths": plan.target.allowed_paths,
        "allowed_methods": plan.target.allowed_methods,
        "auth_profile_ref": plan.target.auth_profile_ref,
        "max_response_bytes": plan.target.max_response_bytes,
        "observability": plan.target.observability,
        "output_path": plan.target.output_path,
        "trace_path": plan.target.trace_path,
        "case_ids": plan.case_ids,
        "snapshot_digest": plan.snapshot_digest,
        "auth_identity": plan.auth_identity,
        "data_classes": plan.data_classes,
        "case_count": len(plan.case_ids),
        "budget": json.loads(json.dumps(plan.budget.model_dump())),
    }
