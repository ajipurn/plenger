# Installed dependency inventory

The reproducible lock/source/hash ledger is checked offline with:

```sh
uv run --locked python scripts/check_dependency_inventory.py --check
uv run --locked python scripts/check_dependency_inventory.py --json
```

The JSON output records Python and frontend package versions, lockfile source,
artifact integrity, dependency scope, features used, completed test classes,
managed scanner image digests, and declared license metadata. The check never
contacts a registry. It validates identity consistency, but does not turn a
package's declared metadata into legal approval.

Versions and licenses below come from installed distribution metadata. Missing or
ambiguous metadata is not license clearance. Source/archive hashes are in uv.lock.
Full container/transitive license review remains open. The bundled Semgrep rule is
plenger-original; third-party scanner rules are not bundled. On macOS, Semgrep,
OSV-Scanner, and Trivy binaries are host-provisioned and recorded by per-project
hash. On other platforms, the corresponding official images are pinned by digest
in the managed scanner adapter. Neither path is a license release clearance.

| Python distribution | Version | Declared license |
|---|---|---|
| alembic | 1.20.0 | MIT |
| annotated-doc | 0.0.5 | MIT |
| annotated-types | 0.8.0 | MIT |
| anyio | 4.15.1 | MIT |
| certifi | 2026.7.22 | MPL-2.0 |
| click | 8.5.0 | BSD-3-Clause |
| fastapi | 0.141.1 | MIT |
| h11 | 0.16.0 | MIT |
| httpcore | 1.0.9 | BSD-3-Clause |
| httpx | 0.28.1 | BSD-3-Clause |
| idna | 3.20 | BSD-3-Clause |
| iniconfig | 2.3.0 | MIT |
| librt | 0.15.0 | MIT |
| Mako | 1.4.1 | MIT |
| markdown-it-py | 4.2.0 | OSI Approved :: MIT License |
| MarkupSafe | 3.0.3 | BSD-3-Clause |
| mdurl | 0.1.2 | OSI Approved :: MIT License |
| mypy | 1.20.2 | MIT |
| mypy_extensions | 1.1.0 | MIT |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause |
| pathspec | 1.1.1 | OSI Approved :: Mozilla Public License 2.0 (MPL 2.0) |
| pluggy | 1.6.0 | MIT |
| pydantic | 2.13.5 | MIT |
| pydantic_core | 2.46.5 | MIT |
| Pygments | 2.21.0 | BSD-2-Clause |
| pytest | 9.1.1 | MIT |
| PyYAML | 6.0.3 | MIT |
| rich | 15.0.0 | MIT |
| ruff | 0.16.8 | MIT |
| shellingham | 1.5.4 | ISC License |
| SQLAlchemy | 2.0.54 | MIT |
| starlette | 1.6.0 | BSD-3-Clause |
| typer | 0.27.2 | MIT |
| types-PyYAML | 6.0.12.20260906 | Apache-2.0 |
| typing-inspection | 0.4.4 | MIT |
| typing_extensions | 4.16.0 | PSF-2.0 |
| uvicorn | 0.53.0 | BSD-3-Clause |
| plenger | 0.1.0 | not declared |

| hatchling | 1.32.3 | MIT |

| tomlkit | 0.15.1 | MIT |

| trove-classifiers | 2026.6.1.19 | OSI Approved :: Apache Software License |

## Frontend direct dependencies

| Package | Version | Declared license |
|---|---|---|
| @playwright/test | 1.63.0 | Apache-2.0 |
| react | 19.3.0 | MIT |
| react-dom | 19.3.0 | MIT |
| @types/react | 19.3.0 | MIT |
| @types/react-dom | 19.3.0 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| vite | 6.4.3 | MIT |
| vitest | 5.0.1 | MIT |
