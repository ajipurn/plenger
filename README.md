# plenger

*Please Let Every Null Get Escaped, Right?*

Local security review of your repositories, modeled on Codex Security Cloud.
One npm package with a local dashboard.

Run `plenger` to start the dashboard. Add a project, choose a model connection
and start a scan: bounded source review, a second skeptical review, STRIDE
threat modeling, source evidence and a prompt a coding agent can use to fix a
finding. Source leaves the machine only for the selected provider, after
redaction. See [docs/STATUS.md](docs/STATUS.md) for release availability,
capabilities and qualification evidence.

Static analysis reads source only. It never runs, imports or installs the
project and needs no network access. Its specialty is Python, JavaScript and
TypeScript: agent inventory, tool and entry point capabilities, and findings
with supporting code. Other languages enter AI review as text.

## Static rules and risk mappings

The [rule catalog](docs/RULES.md) defines 48 static risk rules. A default scan
uses 41 rules. Seven additional library rules (`PLG901` to `PLG907`) require
`library: true` in the engine API. Library mode is not exposed in the dashboard.

Rules map to selected OWASP risk categories and CWE weakness types:

| Reference | Catalog mappings | Scope |
| --- | --- | --- |
| [OWASP Top 10 for LLM Applications 2025](https://genai.owasp.org/llm-top-10/) | 8 of 10 categories | No mapping for LLM04 Data and Model Poisoning or LLM09 Misinformation |
| [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) | 9 of 10 categories | ASI01 to ASI09 have mappings; ASI10 has none |
| [Common Weakness Enumeration](https://cwe.mitre.org/about/index.html) | 27 distinct CWE IDs | Selected weaknesses, including path traversal, command injection, SQL injection, unsafe deserialization and SSRF |

A mapping means at least one rule addresses a specific pattern in that
category. It does not establish full detection coverage for the category.

The engine parses source, traces inputs to effects and emits a matching rule
ID. Reports then use that rule's fixed `owasp` and `cwe` mappings from
[src/rules/catalog.ts](src/rules/catalog.ts). For example, `PLG101` detects a
tool running a shell command built from model input, or a program named by
model input. Its mappings include `LLM06:2025` Excessive Agency. This
classification needs no model call. See [static analysis](docs/guide/scanning.md)
for tracing limits and [status and qualifications](docs/STATUS.md) for evidence.

## Install and start

For a published release, use Node.js 22.18 or newer with npm:

```sh
npm install -g plenger
plenger
```

Or run without a global installation:

```sh
npx plenger@latest
```

Open the printed local URL in your browser. Save a connection under
Settings > Providers, then start a scan. Results and credentials are stored
locally, separately from the installed package. Stop the dashboard with Ctrl+C.

## Commands

```sh
plenger
plenger --workspace path/to/project --port 4180
plenger --data-dir path/to/data
plenger --help
plenger --version
plenger update
```

Published builds check for a newer stable release in the background, at most
once per day. Offline checks never block the dashboard. Set
`NO_UPDATE_NOTIFIER=1` to disable them.

`plenger update` updates an official npm global installation after showing
the current and target versions and asking for confirmation. Stop any running
dashboard first. npx, local dependency and source installations get instructions
for their installation method. Update does not move or delete dashboard data.
See [the install guide](docs/guide/install.md).

The CLI contains only the dashboard launcher, help, version and update.
Static analysis and AI review run through the dashboard. The red-team engine
and container recipes remain internal; the CLI does not expose them.
See [the architecture](docs/ARCHITECTURE.md) and [red-team guide](docs/guide/redteam.md).

## Reports and CI

The dashboard exports scan records as JSON. The composite
[GitHub Action](action.yml) calls the static engine directly and writes SARIF,
a Markdown job summary and a severity gate. It accepts explicit baseline and
suppression files. See [reports and CI](docs/guide/reports-ci.md).

## Documentation

- [Documentation index](docs/README.md)
- [Status and qualifications](docs/STATUS.md)
- [Dashboard](docs/guide/dashboard.md) and [AI security review](docs/guide/ai-security-review.md)
- [Static analysis](docs/guide/scanning.md) and [rule catalog](docs/RULES.md)
- [Installation and updates](docs/guide/install.md)
- [Architecture](docs/ARCHITECTURE.md) and [roadmap](docs/ROADMAP.md)
- [Changelog](CHANGELOG.md) and [security policy](SECURITY.md)

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the toolchain, checks, fixtures and
benchmarks. [AGENTS.md](AGENTS.md) holds instructions for coding agents.
The earlier Python implementation is kept on the `feat/backup` branch.

## Licence

plenger is licensed under the [Apache License 2.0](LICENSE). Copyright 2026
Aji Purnomo. Grammar and dashboard dependency notices are listed in
[docs/licenses/sources.json](docs/licenses/sources.json) and shipped as
`dist/THIRD_PARTY_NOTICES.txt`.
