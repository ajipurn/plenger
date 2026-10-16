# Local dashboard

`plenger serve` runs a local web dashboard for static scans, scan history,
saved model connections and the managed red-team profiles. The npm package
includes the built frontend and the local service. What is available and
qualified is tracked in [../STATUS.md](../STATUS.md); the visual design rules
are in [../design/dashboard-ui.md](../design/dashboard-ui.md).

## Start

After installing the npm package:

```sh
plenger serve
plenger serve path/to/project --port 4180
plenger serve --workspace path/to/project --port 4180
plenger serve --data-dir path/to/dashboard-data
```

For a published release, npx can launch the same dashboard:

```sh
npx plenger@latest serve --port 4180
```

See [install.md](install.md) for npm installation and local tarballs.

Use either a positional project path or `--workspace`, not both. Without
`--port` (or with `--port 0`) a free local port is chosen. `--data-dir` selects
where dashboard state is stored. Without a workspace, the dashboard restores
the last selected project, falling back to the current directory. Relative
paths resolve from the launch directory. Stop the service with Ctrl+C.

For development, from the repository root:

```sh
pnpm dashboard
pnpm dashboard --workspace path/to/project --port 4180
pnpm dev serve path/to/project --port 4180
```

`pnpm dashboard` builds the frontend once, then starts Vite with hot reload and
the local service. Its Vite server binds to `127.0.0.1` and defaults to port
5173; `--port` changes the Vite port, and the API service takes a free port.
`pnpm dev serve` serves the last frontend build without Vite. See
[../../CONTRIBUTING.md](../../CONTRIBUTING.md).

## Navigation

Views have browser routes: `/` for Overview, `/findings`, `/inventory`,
`/redteam`, `/history` and `/settings/providers`. `/settings` and `/providers`
redirect to `/settings/providers`; unknown routes return to `/`. Browser Back
and Forward work. A priority finding opens `/findings?finding=<fingerprint>`.
Old `#overview`, `#findings`, `#inventory`, `#redteam` and `#history` links are
converted to routes when the page opens. Direct loads and refreshes restore the
selected project's saved scan and preparation plan from SQLite.

The sidebar groups the views under Analyze, Test and Workspace; on narrow
screens it becomes a header with a scrolling tab strip. The topbar shows where
you are, when the open scan was taken, and **Export JSON** and **Scan project**
(**Rescan project** once a scan exists) on every page.

The dashboard uses React Router 7, Tailwind CSS 4, Base UI, Gravity icons,
OverlayScrollbars and Torph. Dark mode is the default; the sun/moon button at
the bottom of the sidebar switches appearance. The choice is saved in SQLite for the data
directory, across projects and restarts, and rendered into the page before
scripts load. Fonts are bundled and served locally, including from the
npm package. Layouts adapt to narrow screens, and keyboard focus and the project
picker are available throughout.

## Select a project

Press the project switcher at the top of the sidebar (**Select project** when
none is chosen). The picker shows the current location as a breadcrumb with a dense
folder list below. **Browse…** opens the operating system's folder chooser on
the computer running `plenger serve`: macOS uses Finder's dialog, Windows uses
FolderBrowserDialog, Linux uses an installed Zenity or KDialog. Cancelling the
native dialog keeps the current folder. The dialog is a separate window:
finish or cancel it there even if the page is closed or refreshed; one system
chooser is allowed at a time. macOS may ask permission for the terminal to
control Finder; the path input and in-app folder list work without it.

You can also edit the path and press Enter, or browse the parent and
subfolders in the list. The in-app list shows non-hidden directories and omits
directory symlinks. Confirm with **Open project**. The dashboard scans folders;
use the CLI to scan a single file.

## Review a scan

**Scan project** runs source analysis. No wrapper, configuration or
credentials are needed. Analysis reads Python, JavaScript and TypeScript
without importing or executing the project, installing dependencies or
contacting a model. The scanner's exclusions and `.gitignore` handling apply.

- **Overview** shows finding, agent, tool and source counts, priority findings,
  frameworks, connection counts and scan coverage.
- **Findings** has text search, severity filters and a sort select. Selecting a
  row opens a drawer with the source, numbered evidence trace with expandable
  code context, confidence, exposure, risk explanation, review notes,
  remediation and OWASP/CWE mapping. Escape closes it and returns focus to the
  row.
- **Inventory** shows models, LLM calls, agents, tools, MCP connections,
  prompts, data stores and HTTP entry points in a table beside a category
  sidebar (a select on narrow screens). Search filters the selected category by
  name, configuration or source file; a framework filter narrows it further.
  Pages hold 20 declarations. Rows show configuration chips, linked tool
  counts and the source file and line, so repeated constructors can be told
  apart. Selecting a row opens a drawer with full metadata, the captured prompt
  and capabilities. Frameworks sit in an expandable summary above the table.
- **Scan history** lists saved completed scans across projects and launches
  in a table: project, scan time, source files and findings. Search filters by
  project name or path; pages hold 20 scans. The scan open in the workspace is
  marked. Reopening a scan shows its captured result and persists the
  selection; **Rescan project** reads current source.

**Export JSON** downloads the selected scan's results, including inventory,
findings and evidence. The export contains `id`, `createdAt`, `scan` and
`rules`; it is distinct from the CLI's versioned `scan --json` report. Secrets
are redacted by the scanner before results reach the page or the export;
redaction is not exhaustive. See [reports-ci.md](reports-ci.md) for CLI report
contracts and [../RULES.md](../RULES.md) for the rules.

## Red-team

**Review test setup** (later **Refresh test setup**) prepares the project
offline: supported targets, source coverage, dependency declarations and
preparation gaps. A sole candidate is selected automatically; otherwise choose
**Review this target**. Preparation uses a temporary private snapshot, removes
it afterwards, and never executes project code, installs dependencies or calls
a provider. `preparation.status: "ready"` means the source policy passed;
`executionReady` stays `false` until a run is configured. The plan and
selected target are saved per project; a new scan clears the cached plan.

**Run a security test** configures a saved connection from Settings →
Providers or run-only OpenAI, Gemini or Ollama access, the repetition count
and the shared call, token and deadline limits, then **Start test** starts the
selected profile. Docker is used when available, otherwise Podman; plenger
builds its pinned runtime image on first use. The llmfy profile needs a
compatible file-write tool for its clean control. The Next.js booking profile
prepares SQLite, validates the backend handlers directly and runs the booking,
price-override and zero-payment trials; it shows the captured import closure
and managed dependency versions. Keys entered only for a run stay in memory.
Settings are remembered per project, and results, including partial results,
are stored in SQLite. Refresh reconnects to an active run.

Results appear above the configuration. While a test runs, **Progress** shows
the current repetition and check, the model calls made, the last worker event,
the elapsed time against the deadline and a matrix with one square per check
and repetition: not started, running, completed without violation, violation
observed or no conclusion. The latest worker events of the current check are
listed below it. Select a square to open that repetition under **Evidence by
repetition**. The headline distinguishes observed
weaknesses, incomplete testing and a scoped negative result; finishing a run
is not a safety verdict. Each attack shows the model outcome, any direct
backend check, the observed effect and a recommended fix. A refused model
attack does not override an observed backend weakness. Scripted integration
runs are labelled separately from real model evidence. Coverage and exclusions
stay visible; conversations, tool events, committed SQLite snapshots and
runtime provenance are under **Technical evidence**. A result from a different
source snapshot or target is flagged rather than presented as evidence about
the current code. **Configure another test** starts a new configuration,
**Export test profile** saves the non-secret plan for `plenger redteam run`,
and **Compare with a previous test** opens an explicit before/after
comparison that can be exported separately. Profiles, gates, statistics and
the CLI are described in [redteam.md](redteam.md).

## Provider settings

**Settings → Providers** lists named connections with provider and model,
endpoint, saved-key presence and actions. **Add provider** opens a drawer for
an Ollama, OpenAI or Gemini connection with model, base URL, temperature
(blank uses the model default) and maximum output tokens per call. Actions are
Edit, **Test saved connection** (one bounded model call without project
source), **Make default** and Delete with confirmation. Connections are shared
across projects. Choose a connection by name in Red-team; per-test limits
still apply. Results snapshot the connection's non-secret settings, so editing
or deleting a provider does not rewrite earlier evidence; a deleted provider
that a saved configuration referenced must be replaced explicitly. Changing a
cloud provider's endpoint requires entering its key again.

API keys are encrypted with AES-256-GCM in SQLite. The 32-byte `provider-key`
file in the same data directory has owner-only permissions. This is local
encryption at rest, not an OS keychain: someone with both files can decrypt
saved keys. Keys are never returned to the browser or included in exports.
Deleting a provider removes that connection and its key. **Clear saved data**
keeps providers (see [below](#saved-data-and-clearing)).

## Local service and session

The service binds to `127.0.0.1` and checks the request Host and any Origin
against its exact local address. Folder, state, scan, plan, provider and run
requests require a token generated for each launch. No CORS access is enabled.
Run-scoped model credentials stay in the host broker and never enter a worker.
The page uses a Content Security Policy with scripts restricted to its origin;
runtime styles use a per-response nonce (OverlayScrollbars, Base UI and the
drawer scroll lock) and hashes for the stylesheets the pinned Torph and Vaul
inject. Upgrading either library means updating `src/dashboard/style-policy.ts`;
a test recomputes the Vaul hash from the installed package.

## Saved data and clearing

Scanning and storage stay on this computer; explicit red-team runs send model
messages to the selected provider through the host broker. SQLite stores
completed scan snapshots and history, each project's selected scan and
preparation plan, red-team runs and campaigns with their evidence, non-secret
run settings, saved providers (shared across projects), the active project and
the theme. Keys entered for one run and full model request payloads are never
persisted. Saving completes before an operation reports success; failed scans
keep previously committed results. Refreshing, changing the port or
restarting keeps this state; no browser storage is used.

The default database is `dashboard.sqlite` in the OS application data
directory:

| OS | Directory |
| --- | --- |
| macOS | `~/Library/Application Support/plenger` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/plenger` |
| Windows | `%LOCALAPPDATA%\plenger` (or `~/AppData/Local/plenger`) |

`--data-dir <folder>` selects a separate directory. New directories are
private (`0700`) and the database uses `0600` on Unix. SQLite comes from the
installed Node.js runtime; its Node 22 experimental warning may appear when
`serve` starts.

**Clear saved data** is in **Scan history**. After confirmation it removes, for
the whole data directory: all saved scans and history, preparation plans,
red-team runs and campaigns with their evidence, run settings and project
selections. Saved providers and their encrypted keys remain, as do the theme
preference and the `provider-key` file. Project source files and
downloaded exports are unchanged. Clearing is unavailable while a project
operation or run is active, and the service rejects conflicting requests. The
dashboard returns to the launch workspace and stays empty after a restart; a
later scan starts a new history.

Saved snapshots can contain project details and source evidence. The
scanner's redaction is applied before persistence, with the same limits as
JSON exports.
