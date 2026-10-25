# Local dashboard

`plenger` runs a local web dashboard for local projects, source-based AI
security scans, findings and saved model connections. The npm package
includes the built frontend and the local service. What is available and
qualified is tracked in [../STATUS.md](../STATUS.md); the visual design rules
are in [../design/dashboard-ui.md](../design/dashboard-ui.md).

## Start

After installing the npm package:

```sh
plenger
plenger --workspace path/to/project --port 4180
plenger --workspace path/to/project --port 4180
plenger --data-dir path/to/dashboard-data
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
pnpm dev --workspace path/to/project --port 4180
```

`pnpm dashboard` builds the frontend once, then starts Vite with hot reload and
the local service. Frontend changes reload through Vite. Restart the command
after changing service source code. Its Vite server binds to `127.0.0.1` and defaults to port
5173; `--port` changes the Vite port, and the API service takes a free port.
`pnpm dev` serves the last frontend build without Vite. See
[../../CONTRIBUTING.md](../../CONTRIBUTING.md).

## Navigation

The Clerk-inspired header has a workspace row and an underlined navigation
row. Header, navigation and main content share the same centered width.
The main tabs are **Findings**, **Projects**, **Scans** and **Settings**.
Each tab has an icon. Settings sits beside Scans and opens the provider
connection settings. **New Scan** is available in the header
and beside each project. Open **Settings > Appearance** to switch Dark mode on or off.
The theme is saved in SQLite and applied before scripts load.

Routes are `/findings`, `/projects`, `/projects/:id`, `/scans`, `/scans/:id`,
`/findings/:id`, `/settings/appearance`, `/settings/providers` and `/settings/data`.
Browser Back, Forward and refresh
work. `/history` redirects to Scans; `/repositories` and `/inventory` redirect to Projects.
The `/redteam` route displays **Coming soon** and exposes no testing controls.

The workspace accepts local folders. It does not need a GitHub connection.
Projects can be in any language. Static agent-specific rules cover Python,
JavaScript and TypeScript; PHP is parsed for the model analysis but has no
static rules yet. The source-based model analysis also reads other
languages, templates and configuration as plain text. The two have different
coverage.
See [ai-security-review.md](ai-security-review.md).

## Add a project

Open **Projects > Add project**. Enter a local folder path, or use **Browse…**.
The display name and review context are optional. Context can describe
security assumptions, tenant boundaries and protected assets. Git is optional.
Adding a project saves its configuration without making a model request.

Select a project name to open its detail page. **Findings** shows its saved
findings and triage statuses. **Scans** lists that project's scan history.
The side panel shows the local folder, review context, the project threat model
and latest scan details. The threat model lists the architecture, assets and
trust boundaries that scans derived or that you wrote. **Edit** saves your own
version, which later reviews start from and keep. **Let scans derive it** hands
it back to the reviews. See
[ai-security-review.md](ai-security-review.md#project-threat-model).
**View scan outputs** opens the latest scan's threat model and source coverage.
**New Scan** selects the project automatically. Project links in scan and finding
details return to the same project page.

Browse opens the operating system's folder chooser on the computer running the
service. Cancelling it keeps the path. If the chooser is unavailable, enter the
path directly. Relative paths resolve from the service's launch directory.
The dashboard scans folders; the CLI also accepts a single file.

## Delete a project

Press the trash button beside a project in **Projects**, or **Delete project**
on its detail page. Confirm in the dialog. Deleting removes the project and its
scan history: scans, findings and their triage, reviews, imported evidence, the
threat model and red-team results. It cannot be undone. The folder and its files
stay unchanged, and other projects and providers are kept. Adding the folder
again starts a new project. Finish or cancel a running scan before deleting a
project.

## Start a scan

1. Save a model connection under **Settings > Providers**.
2. Press **New Scan** and choose a local project. Check the displayed folder path.
3. Choose a provider, model, a review mode and **Quick** or **Full
   coverage**. **Batch** sends source the scan packs; **Explore**, selected for
   Claude connections, lets the model read the project through read-only tools.
   For Full coverage, **Set a spending limit** is checked by default; enter a
   limit in tokens or in USD, or clear it to run without one. The saved model is
   selected initially. Choosing another model applies to this scan only. Use
   **Load models** if the provider's saved catalog needs refreshing. Optionally
   choose another saved connection under **Second review** to check candidates
   with a different model.
4. Optionally edit **Review context**. It is saved for subsequent scans.
5. Press **Start Scan**. This sends redacted source and context to the provider
   and consumes API usage.

Each job first runs the offline scanner, then source-based AI discovery,
STRIDE threat modeling and a second source review of any candidates.
**Quick** reviews one batch, the files on traced paths first, with at most two
model calls. In Explore mode it runs one exploring review of at most 18 model
calls instead, and Full coverage runs exploring reviews; see
[Explore mode](ai-security-review.md#explore-mode). **Full coverage** reviews batch after batch until no unsent source
that fits a batch remains, the limit, if set, is reached, or 100 batches have run. Later
batches skip files already sent whole and continue excerpted files with their
unsent parts.

The limit counts every connection the scan uses, including a separate second
review. A token limit counts accounted tokens: reported usage, or a request's
full reservation when the provider reported none. A USD limit uses saved Claude
prices, so it needs prices for every model in the scan; it is an estimate, not
your invoice. A batch starts only when its maximum fits what remains: every
prompt token counted at one per request byte and priced at the dearest prompt
rate, plus the whole output allowance. Batches usually charge far less, so a
limit covers at least the number of batches New Scan shows, often more. New
Scan also lists how many files the review can read and how many batches full
coverage needs, from file sizes alone. Scan details show the files covered, why
batches stopped and what the limit was charged. Exact source and omission
counts are saved in Outputs.

A Full coverage scan that stopped at its limit, or whose later batch failed
after earlier ones completed, for instance on a provider rate limit, shows
**Continue this scan** in its details. Enter a new limit, in the unit of the first one or in tokens when it had none, for what the scan
spends from now on. Later batches skip the files earlier batches sent whole and
continue excerpted files, from the saved static scan. The scan keeps its first
limit and lists each continuation with its limit.

The job continues in the local service when you navigate away or close the
page. Scans and scan details show its current phase. While it runs, the
progress card lists the latest steps under the active stage: each model request,
each file an exploring review reads or search it runs, and each finished batch.
Its heading shows the tokens charged so far. **Cancel scan** explicitly
requests cancellation. Provider failures and refusals stop further requests. Response validation
errors name the failed stage and field when available. Completed static
findings remain visible if the AI review fails.
Stopping the service cancels its active job; an interrupted persisted job is
reported as failed on restart.

No project code, package scripts or model tools execute. The service reads
source and uses fixed read-only Git metadata commands. It does not install
project dependencies or probe a running application. The static engine and the repository's GitHub Action run without model usage.

## Review findings and outputs

**Findings** combines saved static and AI findings across local projects. Search,
project, severity and status filters update the table and severity-to-status
diagram. The initial view includes New, Triaged and In progress findings.
Open a row to see its summary, root cause, attack path, validation, remediation,
affected source locations and captured evidence.

The status selector saves **New**, **Triaged**, **In progress**, **Resolved** or
**Dismissed**. A finding reported again keeps its status and first detection
date. An AI finding counts as reported again when a later review gives the same
STRIDE category and overlapping source evidence, even under a new title. A
resolved finding that is reported again reopens as **New**; a dismissed one stays
dismissed. A complete static scan resolves static findings it no longer reports,
unless the scan was truncated or skipped their file. AI findings are never
resolved by absence, because each review covers one source batch.
AI review outcomes such as Source-supported and Needs review describe the
source analysis; they are separate from this workflow status.

**Scans** lists start time, source, initiator, duration, reported tokens and job
status. Open a scan for its findings and an **Outputs** tab containing
architecture, assets, trust boundaries, all six STRIDE categories, traced paths
with how the review closed each, dismissed candidates with what each dismissal
rests on, source coverage and limitations. The right column records the observed
revision, environment snapshot and provider. Git metadata names the commit and
branch at start; it does not freeze the files. Plenger does not read working-tree status,
because Git would run the filter commands that a project's own Git configuration
names. Included file digests identify what the
model actually received. Anthropic dollar estimates use the selected model's
saved manual prices. **Token usage and cost details** shows each request's
uncached input, output, cache writes and cache hits. Missing prices or usage are
unavailable. Partial totals are labeled **At least**.

**Export scan** downloads the redacted job, its findings and review records.
It is distinct from the static engine's versioned JSON report. Dismissed model
candidates remain in the review records even though they are absent from the
finding table.

### Generate a fix prompt

Open a finding and press **Fix with a coding agent**. Choose a saved provider
and press **Generate fix prompt**. One explicit model request uses that saved
finding's redacted evidence, review notes and remediation. It does not send
complete files, other findings or the absolute repository path. **Copy prompt**
provides instructions to paste into your coding agent.

The prompt asks the agent to verify the current code, confirm the finding,
make a focused fix and add suitable regression coverage. It includes provenance
so the agent can detect stale assumptions. Plenger does not run the agent,
edit code or create a pull request.

Generation has a 60-second deadline, a 2,048-token output allowance and a 24 KiB
evidence limit. A saved per-call output limit for red-team runs does not apply. Automatic output settings for OpenAI
and Claude send that allowance as the output ceiling. Refusals and errors stop without
retrying. Prompts are displayed in the drawer without being saved to scan
history. Closing the drawer or leaving the page cancels unfinished generation.

For external JavaScript or Electron analysis, import complete REA JSON under
**Scans > scan > Outputs > REA evidence**. Explicitly select an import in the
fix drawer to include it. Nothing is selected by default. See
[rea-evidence.md](rea-evidence.md).

## Manual local scans

Scans run only after an explicit **Start Scan** action. A Git commit or file
change does not trigger a scan. To review new changes, start another scan of the
saved project. Remote repository connections and continuous scanning are not
available. See [../STATUS.md](../STATUS.md).

Earlier saved monitoring settings are disabled when the service starts. Scan
history and finding triage remain readable. The API accepts the older
`scope: "repository"` value as a manual local scan for compatibility and rejects
`scope: "continuous"` before calling a provider. New clients omit `scope`.

## Provider settings

**Settings > Providers** retains named connections, model and endpoint settings, key
storage, connection tests and the default provider. Ollama, OpenAI, Gemini,
Anthropic Claude and the experimental ChatGPT connection use the existing
provider implementation. API keys are entered here, never in scan forms.
**Test saved connection** makes one bounded call without project source.
Editing or deleting a provider does not rewrite earlier scan evidence.
Changing a cloud provider's endpoint requires entering its key again.

The ChatGPT connection signs in with your ChatGPT account in a new tab and lists the
models that account offers. The list is saved with the connection, so reopening the
editor shows the same choice. **Reconnect ChatGPT** replaces it with the latest list.
ChatGPT has no temperature or output controls. Requests send no output limit, and
token use is checked after each response against the operation's allowance.

For Anthropic and OpenAI, enter an API key, press **Load models**, and choose
a **Default model** from the provider's catalog. Editing a saved connection can use its
existing key. Loading models makes authenticated catalog requests without generating
text or saving the draft. Changing the key, provider or endpoint clears the draft catalog.
Claude catalog pagination is followed automatically. The catalog comes from the
[Anthropic Models API](https://platform.claude.com/docs/en/api/beta/models/list)
or the [OpenAI Models API](https://developers.openai.com/api/reference/resources/models/methods/list).

Successful model lists are saved locally. Reopening the editor or restarting the
dashboard restores the list without contacting the provider. Select **Reload
models** to replace it with the latest list. A failed reload keeps the saved list.
Each list belongs to the same provider, base URL and API key. Changing any of these
requires loading a matching list. Loading draft models saves the list without
saving the API key; saving the provider makes that list available in its editor.

These two providers have no temperature or output controls in the editor.
Saving uses the model's default temperature and automatic output settings.
OpenAI requests omit the optional output limit. Their reported token use is
checked after completion, so a response can exceed the operation's threshold.
Claude requires an output limit. Plenger reads the selected model's limit and
caps it by the operation allowance. Older compatible endpoints without model
limit metadata use the operation allowance. Existing explicit generation settings
remain supported; saving an Anthropic or OpenAI connection in the editor resets them
to automatic settings.

### Claude model pricing

The Anthropic Models API provides model metadata without unit prices. Its
[Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)
reports historical organization usage and charges, and requires an Admin API key.
It is not a model price catalog.

In the provider editor, open **Model pricing**, choose a **Model** and enable
**Set prices for this model**. **Connection** holds the API key, default model
and advanced endpoint settings. Switching tabs keeps unsaved edits. **Save
provider** and **Cancel** stay in the footer. Saving incomplete prices opens the
affected model and focuses its first invalid field.

Enter USD per million tokens for uncached input, output, 5-minute cache writes,
1-hour cache writes and cache hits. Each model has its own price table. All five
fields are required; enter zero explicitly for a free category. An optional
long-prompt tier has its own threshold and all five prices. Use your effective
rates from the [Claude pricing documentation](https://platform.claude.com/docs/en/about-claude/pricing).
Plenger does not infer prices from model names.

Estimates sum each token category once per request. Long-prompt tiers compare
the request's total input, including cache reads and writes, with the saved
threshold. The higher tier applies only above that threshold. Usage without
cache-write lifetimes cannot be priced reliably. Changing a provider's prices
affects future scans; earlier scans keep their original price snapshot.

Setting cache prices does not enable prompt caching. Current scan requests do
not set cache-control breakpoints. Reported cache usage is still accounted for
when present. Estimates exclude taxes, discounts and other service charges.
They are not invoices. See [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
for Anthropic's token accounting rules.

API keys are encrypted with AES-256-GCM in SQLite. The 32-byte `provider-key`
file in the same directory has owner-only permissions. This is local encryption
at rest. Someone with both files can decrypt saved keys. Full keys are never returned
to the browser or included in exports. The editor shows a masked preview with only
the last four characters. Keys shorter than 12 characters stay fully masked.
The preview is derived locally and excluded from stored settings and exports.
Leave the key field blank to keep the saved key. Deleting a provider removes its key.

## Local service and saved data

Open **Settings > Data** and press **Clear data** to remove all saved projects,
scans, findings, reviews, imported evidence, red-team results and run settings.
Confirm the deletion in the dialog. This cannot be undone. Providers, their
credentials, saved model lists and the theme are kept. Project files and exported reports stay
unchanged. Finish or cancel active scans before clearing data.

The service binds to `127.0.0.1` and checks Host and Origin against its local
address. Requests require a token generated per launch. No CORS access is
enabled. The page enforces a Content Security Policy. Fonts are bundled locally.
The frontend uses React Router, React Aria Components, Tailwind and Gravity icons.

SQLite stores local projects, review context, scan jobs,
reviews, finding statuses and existing project history. Provider connections
and the theme remain shared across projects. The first workspace startup
imports earlier static scans with the latest saved AI review for each scan.
Existing provider credentials and legacy evidence remain stored.
Refreshing the page, changing ports and restarting do not clear this data.

The default database is `dashboard.sqlite` in the OS application data directory:

| OS | Directory |
| --- | --- |
| macOS | `~/Library/Application Support/plenger` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/plenger` |
| Windows | `%LOCALAPPDATA%\plenger` (or `~/AppData/Local/plenger`) |

`--data-dir <folder>` selects a separate directory. New directories use `0700`
and the database uses `0600` on Unix. Node 22 may print its experimental SQLite
warning. To move an installation, stop the service and move its complete data
directory, keeping `provider-key` with the database.

Saved snapshots and exports contain source evidence and project details.
Known secret patterns are redacted before storage and model dispatch. Redaction
does not recognize every application-specific secret. Review exported evidence
before sharing it. Qualification and availability are tracked in
[../STATUS.md](../STATUS.md).
