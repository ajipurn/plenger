"""Validate every field crossing the scanner process boundary."""

from typing import Annotated, Literal

from pydantic import Field, field_validator, model_validator

from plenger.domain.base import StrictModel

Identifier = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
Text = Annotated[str, Field(max_length=4096)]


class SourceRef(StrictModel):
    path: Text
    line: int = Field(ge=1)

    @field_validator("path")
    @classmethod
    def relative_path(cls, value: str) -> str:
        if (
            not value
            or value.startswith("/")
            or "\\" in value
            or any(part in {"", ".", ".."} for part in value.split("/"))
        ):
            raise ValueError("invalid_source_path")
        return value


class Node(StrictModel):
    id: Identifier
    kind: Literal[
        "file",
        "symbol",
        "endpoint",
        "agent",
        "llm_call",
        "prompt_template",
        "retriever",
        "tool",
        "data_store",
        "dependency",
    ]
    label: Text
    source_ref: SourceRef
    provenance: Literal["observed_static", "inferred"]
    attributes: dict[str, Text] = Field(default_factory=dict)


class Edge(StrictModel):
    id: Identifier
    source: Identifier
    target: Identifier
    kind: Literal[
        "defines",
        "calls",
        "invokes_tool",
        "retrieves_from",
        "reads_from",
        "writes_to",
        "guarded_by",
    ]
    source_ref: SourceRef
    provenance: Literal["observed_static"]


class Evidence(StrictModel):
    id: Identifier
    source: Literal["python-ast-v2"]
    observed: Text
    redaction_version: Literal["metadata-only-v1"]


class Finding(StrictModel):
    id: Identifier
    fingerprint: Identifier
    rule_id: Literal["WK-PY-001"]
    kind: Literal["dynamic_code_execution"]
    severity: Literal["high"]
    severity_source: Literal["plenger-rule", "wonderkit-rule"]
    validation_state: Literal["candidate"]
    lifecycle_state: Literal["open"]
    assessment_state: Literal["needs_review"]
    title: Text
    source_ref: SourceRef
    evidence: Evidence


class ParseError(StrictModel):
    path: Text
    reason: Literal["parse_error", "analysis_depth_limit"]


class ParserResult(StrictModel):
    nodes: list[Node] = Field(max_length=100000)
    edges: list[Edge] = Field(max_length=100000)
    findings: list[Finding] = Field(max_length=50000)
    errors: list[ParseError] = Field(max_length=50000)
    limitations: list[Text] = Field(max_length=100)

    @model_validator(mode="after")
    def references_exist(self) -> "ParserResult":
        ids = {node.id for node in self.nodes}
        if len(ids) != len(self.nodes) or any(
            edge.source not in ids or edge.target not in ids for edge in self.edges
        ):
            raise ValueError("invalid_graph_references")
        return self
