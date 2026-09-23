# ADR 0014 — Typed Jev assessment boundary

Status: accepted and implemented with mock HTTP verification; live verification
remains unavailable.

Jev is an optional assessment provider, never an execution authority. The adapter
uses the documented TypeSafe System One HTTP shape (`state`, `model`, `questions`)
and validates the returned model, usage, and typed answers before persistence:
Choice probabilities must match the declared choices, Score answers must respect
their legend and range, and Noul answers intentionally have no confidence field.
See the [TypeSafe API documentation](https://docs.typesafe.ai/api).

State is redacted and bounded before the call. Missing key, timeout/network,
authentication, provider-schema, rate-limit, and invalid-response conditions
produce an abstention with a safe reason code. Only bounded retries for 429/529
are allowed. Requested/resolved model, rubric digest, input digest, redaction
version, and usage are retained for audit. The adapter never changes finding
severity, lifecycle, suppression, plan scope, or run state.

The repository keeps its model default pinned to `jev-1.13.0` for reproducibility;
availability of that pin and live accuracy have not been verified in this
environment. A real key, explicit hosted consent, and a separately labeled
120-case evaluation are required before claiming live integration or accuracy.
