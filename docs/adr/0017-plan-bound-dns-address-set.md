# ADR 0017 — Bind approved plans to the resolved DNS address set

Status: accepted and implemented for local loopback and staging HTTPS transport
contracts; live staging rebinding acceptance remains a release gate.

## Context

Binding an approval only to a hostname and URL scope is insufficient when the
hostname can resolve to a different address between plan creation and dispatch.
URL validation also cannot establish that every address returned by DNS is safe:
a mixed A/AAAA answer or a later rebinding could bypass the address policy while
the visible hostname remains unchanged.

## Decision

When a project plan is created, plenger resolves the complete TCP DNS A/AAAA
set for the registered target. It validates that every address is loopback for a
local target or globally routable for a staging target, canonicalizes and sorts
the set, and stores it as `target.allowed_ips`. The set participates in the
target revision, plan digest, scope digest, approval preview, and persisted plan
payload so the user approves the same network boundary the runner will use.

The broker resolves the hostname again before every dispatch and requires an
exact match with the bound canonical set. Any DNS failure, empty answer,
unsafe/mixed answer, or set change fails closed and requires a new plan. The
broker connects directly to a selected bound address while preserving the
registered hostname for Host/SNI and disabling proxy inheritance. Stored plans
without an address binding are rejected during approval or execution rather
than being silently upgraded.

## Consequences

Multi-address targets are supported only when the complete validated set remains
stable. Normal DNS rotation, failover, or provider changes intentionally require
re-planning and a fresh approval. This may be conservative for short-lived DNS
answers, but it keeps the approved scope and the actual network boundary
identical. Direct broker unit callers may still exercise dynamic resolution when
they construct a target without a binding; project-created plans never use that
compatibility path.

The control protects against the class of DNS rebinding addressed by the local
broker contract; it is not a claim of protection against a compromised host,
production sidecar, or a live staging environment that has not been authorized
and tested. Canonicalization, persistence, legacy-plan rejection, and dispatch
set-change rejection are covered by the active policy, API, broker, and browser
evidence.
