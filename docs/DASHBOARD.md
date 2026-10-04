# Local dashboard

The React + Vite dashboard runs static scans, reviews offline llmfy project
preparation and exposes limited file-canary and Next.js booking/SQLite previews. The standalone executable includes
its assets and local service. Public distribution remains pending under M8; see
[DISTRIBUTION.md](DISTRIBUTION.md). M6a is not complete.

## Start

With the executable on your `PATH`, run:

```sh
plenger serve
plenger serve path/to/project --port 4180
plenger serve --workspace path/to/project --port 4180
plenger serve --data-dir path/to/dashboard-data
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

`pnpm dashboard` builds the frontend once, then starts Vite with hot reload and the
local project service. Changes under `dashboard/` update in the browser while the
command is running. Its Vite server binds to `127.0.0.1` and defaults to port 5173;
`--port` chooses a different Vite port. The API service uses an available local
port. `pnpm dashboard:build` rebuilds production assets, and `pnpm dev serve` serves
the existing frontend build without Vite.
Open the Vite address printed in the terminal. `--workspace` sets the initial
project folder; `--data-dir` chooses where dashboard state is stored. Without a
workspace, the dashboard restores the last selected project, falling back to the
current directory when nothing is saved. Relative paths are resolved from the
launch workspace. Folder browsing is unrestricted. Stop the service with Ctrl+C.

## Interface stack and navigation

The dashboard uses React Router 7, Tailwind CSS 4, Base UI, Gravity icons,
OverlayScrollbars and Torph text animation. Base UI supplies accessible form and
dialog behavior; text animation respects reduced-motion preferences.

OverlayScrollbars styles the document, horizontal navigation on narrow screens,
project dialog, findings list and folder list with a shared thin scrollbar theme.
Document scrolling remains on the browser's real viewport, so modal scroll lock,
skip links and keyboard scrolling continue to work. Instances on dialog popups
are destroyed when the popup closes and recreated when it opens.

The visual system follows the [Fey reference on Refero](https://styles.refero.design/style/a0630421-7b66-48b4-aa14-6194a3b2c2b9):
matte-black surfaces, white text, 16px card radii and compact ghost pill actions.
The reference CSS is in `dashboard/src/fey.css`; [DESIGN.md](../DESIGN.md) records
the dashboard adaptations. The two-row top navigation keeps the project selector
beside the logo; page links use a blue active underline. The project topbar scrolls
away while workspace navigation stays at the top of the viewport. Switching pages
starts the new page at the top; finding selection within a page preserves scroll.
Compact controls and card spacing keep the workspace dense without shrinking
body text. Geist Sans and Geist Mono are bundled and served locally, including
in the executable; no external font service is used. UI copy uses 14px, labels and
source metadata use 12px, section headings use 18px and page titles use 26px
(24px on narrow screens), with regular, medium and semibold weights. Geist Mono
is used for source paths, code and identifiers. Severity indicators retain
distinct semantic colors. Layouts adapt to narrow screens and short windows,
with keyboard focus and the project picker available throughout.

The header's lowercase `plenger` wordmark uses locally bundled Nanum Pen Script
400. The logo and favicon share an outlined lowercase `n` from that font; both
remain available offline in the standalone executable.

Use the sun/moon button in the header to switch between light and dark mode.
Dark mode is the default. The choice is saved in SQLite for this data directory,
across projects, browsers, service ports and restarts. The server renders the
saved theme into each page before scripts load. Clearing saved scan data retains
this appearance preference.

Views have browser routes: `/` for Overview, `/findings`, `/inventory`, `/redteam`
and `/history`. Browser Back and Forward navigate these views. A priority finding
opens `/findings?finding=<fingerprint>`. Existing `#overview`, `#findings`,
`#inventory`, `#redteam` and `#history` links are converted to the corresponding
route when the page opens. Direct route loads and refreshes restore the selected
project's saved scan and preparation plan from SQLite.

Use **Select project**, then **Browse folders…** to open the operating system's
folder chooser. The selected folder returns to Plenger; choose **Select this
folder** to use it as the project. Cancelling the native dialog keeps the current
folder. macOS opens its standard folder dialog through Finder, Windows uses FolderBrowserDialog,
and Linux uses an installed Zenity or KDialog. The dialog opens on the computer
running `plenger serve`.

The system dialog is a separate window: finish or cancel it there, even if the
dashboard page is closed or refreshed. Plenger allows one system chooser at a
time. macOS may request permission for the terminal running Plenger to control
Finder; the manual path and in-app folder list work without that permission.

You can also enter a folder path and press Enter, or browse its parent and
subfolders inside Plenger. These controls remain available if the system chooser
is unavailable. The in-app list shows non-hidden directories and omits directory
symlinks. The dashboard scans folders; use the CLI to scan a single file.

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
  connections, prompts, stores and HTTP entry points in a table. Category tabs
  show counts; search filters the selected category by name, configuration or
  source file. Lists have 20 declarations per page. Rows show model configuration,
  linked tool names and full source paths with line and column, so repeated
  constructors can be distinguished. Expand a declaration with its chevron for
  full metadata and capabilities. On narrow screens, configuration moves under
  the declaration. Frameworks are in a compact expandable summary. Tabs,
  pagination and row expansion support keyboard navigation.
- **Scan history** lists all saved completed scans across projects and service
  launches. Reopening a scan persists that selection and shows its captured
  result; use **Rescan project** to read current source. The list loads summary
  metadata, with the full snapshot loaded when selected.

**Export JSON** downloads the selected scan's actual results, including inventory,
findings and evidence. The dashboard export contains `id`, `createdAt`, `scan` and
`rules`; it is distinct from the CLI's versioned `scan --json` report. Recognised
secrets are redacted by the scanner before results reach the page or export.
Redaction is not exhaustive. See [REPORTS.md](REPORTS.md) for CLI report contracts
and [RULES.md](RULES.md) for static rule coverage.

## Offline red-team preparation

In **Red-team**, choose **Review test setup** to call `planProject()` for the selected
folder. Review supported targets, source coverage, dependency declarations
and preparation gaps. A sole candidate is selected automatically; choose
**Review this target** when a target choice is needed.

Preparation uses a temporary private source snapshot and removes it afterward.
It does not execute project code, resolve or install dependencies, or call a live
provider. `preparation.status: "ready"` means the source preparation policy passed;
`executionReady` always remains `false`. **Run a security test** offers
model access, call/token/deadline limits, Start/Stop, saved settings and persistent
run history for the supported llmfy file-test profile. It requires an active Podman
backend; Plenger prepares its pinned runtime and instrumentation. Enter a model ID
for OpenAI, Gemini or Ollama; cloud API keys are used in memory for that run and never saved.
The llmfy profile needs a compatible file-write tool for its clean control.
The Next.js booking profile automatically prepares SQLite, validates backend handlers,
and runs booking, price-override and zero-payment model trials. It uses Docker
Desktop when available or Podman, and shows the captured import closure and managed
dependency versions. See REDTEAM.md for the supported contract and current limits.
The Next.js booking profile has limited live-model evidence; broader model and
platform qualification, including live llmfy qualification, is still pending. The
offline preparation plan and selected target are saved per project. A new scan
clears that project's cached plan, so the next review reads current source.
See [REDTEAM.md](REDTEAM.md) for preparation policy and the remaining M6a stages.

Saved results appear before configuration and preparation details. The headline
distinguishes observed weaknesses, incomplete testing and a scoped negative result;
process completion and a successful normal task are not security verdicts. Each
attack shows the model outcome alongside any direct backend check, its observed
effect and a recommended fix. A blocked model attack does not override an observed
backend weakness. Scripted integration runs are identified separately from real
model evidence. Confirmed effects remain visible after interruption or restoration.
Coverage and exclusions stay visible, while conversations, tool events, committed
SQLite snapshots and runtime provenance remain under **Technical evidence**.
Use **Configure another test** for repeat runs and **Test setup and supported targets**
to inspect preparation. A result from a different source snapshot or selected
target is flagged rather than presented as evidence about the current code.

## Local service and session

The service checks the request Host and any supplied Origin against its exact
local address. Folder, state, scan, plan and run requests also require a token generated for
each service launch. It enables no CORS access. Run-scoped model credentials stay
in the host broker; they are not stored or passed into the project worker.

The page uses a Content Security Policy with scripts restricted to its own
origin. Runtime styles use a per-response nonce for OverlayScrollbars and a hash
for the pinned Torph stylesheet; unrestricted inline scripts or styles are not
enabled.

## Saved data and clearing

Scanning and local storage stay on this computer; explicit dynamic runs send model
messages to the selected provider through the host broker. SQLite stores completed
scan snapshots, history, each project's selected scan and preparation plan, and
the active project and theme preference. It also stores red-team evidence/progress and
non-secret run settings. API keys and full model request payloads are not persisted. The booking profile
saves synthetic test inputs, assistant text, tool arguments/results and disposable
SQLite snapshots as evidence.
Saving completes before an operation reports success. Failed
scans preserve previously committed results. Refreshing the page, changing the
service port, or restarting Plenger keeps this state; no browser storage is used.

The default database is `dashboard.sqlite` in the OS application data directory:

| OS | Directory |
| --- | --- |
| macOS | `~/Library/Application Support/plenger` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/plenger` |
| Windows | `%LOCALAPPDATA%\plenger` (or `~/AppData/Local/plenger`) |

`--data-dir <folder>` selects a separate data directory, useful for isolated
workspaces or tests. Newly created directories are private (`0700`) and the
database uses `0600` permissions on Unix systems. SQLite comes from the bundled
Node.js runtime; it adds no npm dependency. Its Node 22 experimental warning may
appear when `serve` starts.

In **Scan history**, choose **Clear saved data**, then confirm the dialog. This
removes all saved dashboard scans, plans, runs, run settings and project selections in that data
directory. The dashboard returns to the launch workspace and stays empty after
restart. Project source files and downloaded JSON exports are unchanged. Clearing
is unavailable while a project operation or dynamic run is active, and the service rejects
conflicting requests. A later scan starts a new saved history.

Saved snapshots can contain project details and source evidence; the scanner's
redaction is applied before persistence, with the same limits as JSON exports.
