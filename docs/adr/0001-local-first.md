# ADR 0001 — Local-first shared service

Status: accepted for this development checkpoint.

CLI and FastAPI use `services/application.py`. Capture never imports or executes
target modules and never installs target dependencies. Results are local SQLite
records. No hosted evaluator is enabled. Init writes only a new declarative config;
it preserves an existing config and does not modify target `.gitignore`.

M0–M6 remain the ordered plan: foundation; limited vertical slice; real scanners;
authorized LLM runner; Jev; developer workflow; hardening. Each gate remains open
until its acceptance evidence exists. Smaller working features do not close a
whole requirement. Original PRD/SPEC/TRACEABILITY are preserved without weakening.

The referenced SOURCES and example files were absent at start. Only the config
fields implemented and tested here are accepted. `examples/plenger.minimal.yaml`
is a new checkpoint example, not a reconstruction of the missing full contract.
