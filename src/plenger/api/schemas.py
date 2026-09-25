"""Request bodies accepted by the local API; unknown fields are rejected."""

from typing import Literal, cast

from pydantic import Field

from plenger.domain.base import StrictModel
from plenger.policy.active import BudgetSpec, PlanSpec, TargetSpec


class PairBody(StrictModel):
    code: str = Field(min_length=16, max_length=128)


class ScanBody(StrictModel):
    # Omitted profile means the project's configured profile.
    profile: Literal["deterministic", "baseline"] | None = None
    fixture: bool = False


class FindingLifecycleBody(StrictModel):
    lifecycle_state: Literal["open", "acknowledged", "suppressed", "resolved"]
    reason: str = Field(min_length=1, max_length=1000)
    expected_revision: int = Field(ge=0)
    actor: str = Field(default="local-user", min_length=1, max_length=128)
    expiry_days: int = Field(default=30, ge=1, le=365)


class PlanBody(StrictModel):
    target: TargetSpec
    case_ids: list[str] = Field(min_length=1, max_length=40)
    snapshot_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    auth_identity: str = Field(min_length=1, max_length=128)
    data_classes: list[Literal["metadata", "code_excerpt", "prompt", "response", "trace"]] = Field(
        default_factory=list, max_length=5
    )
    budget: BudgetSpec = Field(default_factory=BudgetSpec)

    def to_plan(self) -> PlanSpec:
        return PlanSpec(
            target=self.target,
            case_ids=self.case_ids,
            snapshot_digest=self.snapshot_digest,
            auth_identity=self.auth_identity,
            data_classes=self.data_classes,
            budget=self.budget,
        )


class ApprovalBody(StrictModel):
    actor: str = Field(min_length=1, max_length=128)
    acknowledgment: Literal["I_AUTHORIZE_THIS_EXPLICIT_SCOPE"]
    ttl_minutes: int = Field(default=30, ge=1, le=30)


class PlanRunBody(StrictModel):
    approval_id: str = Field(min_length=36, max_length=36)


class AssessmentBody(StrictModel):
    finding_id: str = Field(min_length=64, max_length=64)
    provider: Literal["deterministic", "manual", "jev"] = "deterministic"
    consent: bool = False
    # Granting durable hosted consent inline needs the same explicit acknowledgment
    # as the dedicated consent endpoint.
    acknowledgment: Literal["I_AUTHORIZE_HOSTED_ASSESSMENT"] | None = None
    data_classes: list[Literal["metadata", "code_excerpt", "prompt", "response", "trace"]] = Field(
        default_factory=list, max_length=5
    )


class AssessmentConsentBody(StrictModel):
    provider: Literal["jev"] = "jev"
    data_classes: list[Literal["metadata", "code_excerpt", "prompt", "response", "trace"]] = Field(
        default_factory=lambda: cast(
            list[Literal["metadata", "code_excerpt", "prompt", "response", "trace"]],
            ["metadata", "code_excerpt", "response"],
        ),
        max_length=5,
    )
    acknowledgment: Literal["I_AUTHORIZE_HOSTED_ASSESSMENT"]


class ExportBody(StrictModel):
    format: Literal["json", "html"]
