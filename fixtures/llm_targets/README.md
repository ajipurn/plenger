# Local active-target fixture families

The active integration tests use a loopback-only HTTP target with two explicit
modes: `vulnerable` and `fixed`. The native matrix covers one bounded case for
each OWASP LLM 2025 category:

- direct policy prompt injection (LLM01);
- synthetic disclosure marker (LLM02);
- untrusted supply-chain component marker (LLM03);
- poisoned data/model instruction marker (LLM04);
- unsafe generated output marker (LLM05);
- tool authorization and a local effect ledger (LLM06);
- system prompt leakage marker (LLM07);
- cross-tenant retrieval with tenant-specific document IDs (LLM08);
- unverified claim marker (LLM09); and
- unbounded consumption marker (LLM10).

LLM01, LLM02, LLM06, and LLM08 write independent observer events bound to the
suite run, attempt, and sequence. LLM01/LLM02 still use the exact response
marker as their result oracle; their observer event adds corroborating digest
evidence and is not required to classify the response. LLM06 uses a synthetic
local effect ledger, and LLM08 records synthetic tenant-specific document IDs.
Wrong-run observer events are rejected. The other six cases remain bounded
response-marker contracts; they do not claim production recall or replace
category-specific application ground truth. The fixed-mode responses and
observer outcomes are negative controls for every family.

The test target has no SMTP, cloud, filesystem, or external transaction side
effects. The `fixture_mailbox_write` tool is a synthetic label recorded only in
the local observer ledger; no mail provider is called. Retrieval document IDs
are synthetic. The response body is intentionally not trusted as a trace.
