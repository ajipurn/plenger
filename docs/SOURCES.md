# Sources actually consulted for this checkpoint

The original `SOURCES.md` referenced by PRD/SPEC was absent. R01–R13 mappings have
not been recovered; this file does not claim to restore them. The Jev request and
full YAML examples were also missing. Those contracts require verification before
the relevant integration milestone.

- uv lock/sync semantics: https://docs.astral.sh/uv/concepts/projects/sync/
- FastAPI response cookies: https://fastapi.tiangolo.com/advanced/response-cookies/
- Installed Python package metadata and `uv.lock`: actual dependency versions/hashes.
- Local Docker image inspection: pinned parser image already cached on development host.
- `docker run` and real isolation tests: see `tests/integration/test_slice.py`.
- Official scanner image tags/digests and usage: [Semgrep container tags](https://hub.docker.com/r/semgrep/semgrep/tags), [OSV-Scanner usage](https://google.github.io/osv-scanner/usage/), and [Trivy installation/images](https://www.trivy.dev/docs/latest/getting-started/installation/).

No unverified upstream engine flags are implemented. The Jev adapter uses only the
bounded System One request/response shape checked against the official TypeSafe
documentation below; it is still not live-verified in this environment.
- FastAPI explicit route decorators: https://fastapi.tiangolo.com/tutorial/first-steps/
- APIRouter inclusion/prefix semantics: https://fastapi.tiangolo.com/tutorial/bigger-applications/

## Reconstructed examples (20 September 2026)

The missing YAML example now documents only implemented safe configuration fields.
The missing Jev JSON example was authored with synthetic content after checking:

- TypeSafe HTTP API: https://docs.typesafe.ai/api
- Choice shape: https://docs.typesafe.ai/primitives/choice
- Score shape: https://docs.typesafe.ai/primitives/score
- Noul shape: https://docs.typesafe.ai/primitives/noul
- Model catalog: https://docs.typesafe.ai/models

The managed scanner argv contracts were checked against the current primary
documentation for [OSV-Scanner output](https://google.github.io/osv-scanner/output/),
[OSV-Scanner offline usage](https://google.github.io/osv-scanner/usage/),
[Trivy filesystem flags](https://www.trivy.dev/docs/latest/guide/references/configuration/cli/trivy_filesystem/),
and [Trivy secret scanning](https://www.trivy.dev/docs/latest/guide/scanner/secret/).
Semgrep uses a packaged local rule file and metrics/version-check disabling; no
remote Semgrep registry configuration is used.

For this local checkpoint, explicit Homebrew provisioning installed Semgrep
1.176.0, OSV-Scanner 2.6.0, and Trivy 0.74.0. The managed manifest records the
binary SHA-256 values at setup time; the current host values were
`c7ee8a1df4640b492b4cd3898c53dc3938ba9bfaeee0977cc2a3a763f1f85ff3`,
`2939ca32e8287f3e7ae3dc8619a9d8af5ab04d97b9840d69ab7f123fab0e255b`, and
`9ae1b2901e838326e6accc84efbeb790a9b0f506479bfbc8becdf42d855e0fdd`, respectively.
These identities are host evidence, not portable release pins; a clean host must
provision and verify its own binaries and licenses. The non-macOS container path
uses these immutable image identities:

- `semgrep/semgrep@sha256:e5ea1a270ca5557a114ae7a30a8f860cc16a924f8df85cd975688f17c7c97731`
- `ghcr.io/google/osv-scanner@sha256:afd838850ac1a0fcc15ff4a041dc9ba11123c3f0d2666217a5f0fcf9222b55fa`
- `aquasec/trivy@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969`

The image identities were inspected locally and exercised with `--pull=never`;
license and clean-host compatibility review remain release gates.

These are request examples, not completed integrations or live evaluations. No
credentials, actual source, or target data was sent. A model pin in an example
still requires account-specific live verification during M4.
