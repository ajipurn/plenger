# Local dashboard

The React + Vite dashboard runs static scans and reviews offline llmfy project
preparation through the same engine as the CLI. The standalone executable includes
its assets and local service. Public distribution remains pending under M8; see
[DISTRIBUTION.md](DISTRIBUTION.md). M6a is not complete.

## Start

With the executable on your `PATH`, run:

```sh
plenger serve
plenger serve path/to/project --port 4180
plenger serve --workspace path/to/project --port 4180
```

No separate frontend build, Node.js installation or pnpm is needed for the binary.
Choose either a positional project path or `--workspace`, not both.

For development, use Node.js 22.18 or newer and pnpm 10 from the repository root:

```sh
pnpm install
pnpm dashboard
pnpm dashboard --workspace path/to/project --port 4180
pnpm dev serve path/to/project --port 4180
```

`pnpm dashboard` builds the frontend, then starts the same `serve` command through
`node src/dashboard/bin.ts`. `pnpm dev serve` uses the existing frontend build.
Open the address printed in the terminal. The service binds to `127.0.0.1` and
chooses an available port by default (`--port 0`); `--port` accepts 0–65535.
`--workspace` sets the initial project folder and the base for relative paths. It
defaults to the current directory and does not restrict folder browsing. Stop
the service with Ctrl+C.

## Interface stack and navigation

The dashboard uses React Router 7, Tailwind CSS 4, Base UI, Gravity icons,
OverlayScrollbars and Torph text animation. Base UI supplies accessible form and
dialog behavior; text animation respects reduced-motion preferences.

The visual system takes its warm neutral surfaces, dark text and lime accents
from the Perk reference. Inter Variable is bundled and served locally, including
in the executable; no external font service is used. Severity indicators retain
distinct semantic colors. Layouts adapt to narrow screens and short windows,
with keyboard focus and the project picker available throughout.

Views have browser routes: `/` for Overview, `/findings`, `/inventory`, `/redteam`
and `/history`. Browser Back and Forward navigate these views. A priority finding
opens `/findings?finding=<fingerprint>`. Existing `#overview`, `#findings`,
`#inventory`, `#redteam` and `#history` links are converted to the corresponding
route when the page opens. Direct route loads work, but reloading still clears
the in-memory scan and plan; a URL does not persist a result.

Use **Select project** to enter a folder path or browse its parent and subfolders,
then choose **Select this folder**. The picker lists non-hidden directories and
omits directory symlinks. The dashboard scans folders; use the CLI to scan a
single file.

## Review a scan

Choose **Scan project** to run source analysis. No project wrapper, configuration
file or credentials are needed. Analysis reads Python, JavaScript and TypeScript
source without importing or executing the project, installing its dependencies
or contacting a model. The scanner's normal exclusions and `.gitignore` handling
apply.

- **Overview** shows finding, agent, tool and source counts, priority findings,
  frameworks, connection counts and scan coverage.
- **Findings** supports text search and severity filters. Select a finding to
  inspect its source evidence, confidence, exposure, notes, suggested remediation
  and OWASP/CWE mapping.
- **Inventory** shows the discovered models, LLM calls, agents, tools, MCP
  connections, prompts, stores and HTTP entry points with their source locations.
- **Scan history** reopens the last 20 completed scans in the current page session.
  These results are held in memory until the page is closed or reloaded. Reopening
  a scan shows its captured result; use **Rescan project** to read current source.

**Export JSON** downloads the selected scan's actual results, including inventory,
findings and evidence. The dashboard export contains `id`, `createdAt`, `scan` and
`rules`; it is distinct from the CLI's versioned `scan --json` report. Recognised
secrets are redacted by the scanner before results reach the page or export.
Redaction is not exhaustive. See [REPORTS.md](REPORTS.md) for CLI report contracts
and [RULES.md](RULES.md) for static rule coverage.

## Offline red-team preparation

In **Red-team**, choose **Review plan** to call `planProject()` for the selected
folder. Review discovered llmfy targets, source coverage, dependency declarations
and preparation gaps. A sole candidate is selected automatically; choose
**Review this target** when a target choice is needed.

Preparation uses a temporary private source snapshot and removes it afterward.
It does not execute project code, resolve or install dependencies, or call a live
provider. `preparation.status: "ready"` means the source preparation policy passed;
`executionReady` always remains `false`. Dynamic runs, model access and budget
setup, cancellation, saved profiles and persistent run history remain pending.
See [REDTEAM.md](REDTEAM.md) for preparation policy and the remaining M6a stages.

## Local service and session

The service checks the request Host and any supplied Origin against its exact
local address. Folder, scan and plan requests also require a token generated for
each service launch. It enables no CORS access and does not collect or manage
provider credentials.

The page uses a Content Security Policy with scripts restricted to its own
origin. Runtime styles use a per-response nonce for OverlayScrollbars and a hash
for the pinned Torph stylesheet; unrestricted inline scripts or styles are not
enabled.

Project operations and results stay on this computer. The browser uses no
storage for scan results, project selection or plans. Closing or reloading the
page clears its scan history; only an explicitly downloaded JSON export remains.
