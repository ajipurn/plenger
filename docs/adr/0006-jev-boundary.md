# ADR 0006 — Hosted evaluator cannot authorize

Status: boundary accepted; typed adapter implemented, live integration unavailable.

The Jev provider is inert without an explicit key and hosted consent. Offline
analysis works without a key. No fake model result substitutes for a missing live
integration. The provider posts only the bounded, redacted assessment payload to
the documented TypeSafe endpoint and never grants execution authority.

Typed Choice/Score/Noul parsing, bounded retries, auth/schema handling, usage
capture, rubric/input digests and explicit minimized-payload consent are covered by
mock HTTP tests. Model recommendations never grant scope, budget, severity,
confirmed/resolved states or suppression. Live testing requires separate actual
credentials/consent; no live verification or benchmark accuracy is claimed here.
