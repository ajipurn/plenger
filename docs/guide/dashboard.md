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
plenger --data-dir path/to/dashboard-data
```

For a published release, npx can launch the same dashboard:

```sh
npx plenger@latest --port 4180
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
and beside each project. Open **Settings > Appearance** to choose the Dark, System
or Light theme. System follows your device setting and changes with it.
Choose **Compact** density there to fit more rows on screen.
The theme and density are saved in SQLite and applied before scripts load.

Routes are `/findings`, `/projects`, `/projects/:id`, `/scans`, `/scans/:id`,
`/findings/:id`, `/settings/appearance`, `/settings/providers` and `/settings/data`.
Browser Back, Forward and refresh
work. `/history` redirects to Scans; `/repositories` and `/inventory` redirect to Projects.
The `/redteam` route displays **Coming soon** and exposes no testing controls.

Select menus with ten or more options include a search field. Search matches display
names and IDs without regard to case. Use arrow keys and Enter to choose a result,
or Escape to close the menu. Shorter lists keep the compact select menu.

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
again starts a new project. Finish, pause or stop a running scan before deleting
a project.

## Start a scan

1. Press **New Scan**, choose a local project and check its folder path.
   Optionally edit **Review context**, which is saved for subsequent scans.
2. Choose a saved provider and model, a review mode and **Quick** or
   **Full coverage**. Save a connection in **Settings > Providers** first if
   needed. **Batch** sends each round the files the scan picks. **Explore**,
   selected for Claude connections, lets the model read the project through
   read-only tools. Each card shows its model calls or rounds. For Full coverage,
   pick a limit preset, enter another token or USD amount, or choose
   **No limit**. Choosing another model applies to this scan only.
   **Load models** refreshes the saved catalog. **Validate with** keeps the same
   model, or pick another saved connection and model for validation. The plan
   above **Start Scan** sums up the choices.
3. Press **Start Scan**. The scan sends redacted source and context to the
   selected providers and consumes model usage.

One scan runs at a time across all projects. While it runs, **New Scan**,
**Scan again** and **Continue scan** are disabled, and hovering one names the
reason. Let the running scan finish, or pause or stop it, to start another. A
paused scan does not block other scans.

Scans saved by the former **Static only** choice still open as static results.
Their candidates stay **Unvalidated**. Use **Scan again** for a full review.

Each scan first runs the offline scanner, then AI discovery, STRIDE and source
validation.
**Quick** runs one round. In Batch mode the round sends the files on traced
paths first and makes at most two model calls. In Explore mode it makes at most
18 model calls; see [Explore mode](ai-security-review.md#explore-mode).
**Full coverage** runs round after round until no unsent source that fits a
round remains, the limit, if set, is reached, or 100 rounds have run. In Explore
mode it also stops when a round reads nothing earlier rounds had not. Later
rounds skip files already sent whole and continue excerpted files with their
unsent parts.

The limit counts every connection the scan uses, including a separate
validation model. A token limit counts accounted tokens: reported usage, or a request's
full reservation when the provider reported none. A USD limit uses the selected
models' automatic or saved prices, including a separate validation model.
New Scan uses fresh cached prices immediately and loads only missing or expired
prices for those models. It is an estimate, not your invoice. A round starts only
when its maximum fits what remains: every
prompt token counted at one per request byte and priced at the dearest prompt
rate, plus the whole output allowance. Rounds usually charge far less, so a
limit covers at least the number of rounds New Scan shows, often more. New
Scan also lists how many files the review can read and, in Batch mode, how many
rounds full coverage needs, from file sizes alone. Scan details show the files
covered, why rounds stopped and what the limit was charged. A Quick scan counts
against its one round: Batch shows the files the round sends, known as it starts,
and Explore, whose model picks what it reads, shows the files read. A finished
Quick scan says so and names how many more files Full coverage reads. Exact source and
omission counts are saved in Outputs.

A Full coverage scan that stopped at its limit, or whose later round failed
after earlier ones completed, for instance on a provider rate limit, shows
**Continue this scan** in its details. Enter a new limit, in the unit of the first one or in tokens when it had none, for what the scan
spends from now on. Later rounds skip the files earlier rounds sent whole and
continue excerpted files, from the saved static scan. They also attempt remaining
static candidates and may retry ones left Unvalidated before this continuation.
The scan keeps its first limit and lists each continuation with its limit.

A paused scan shows **Scan paused** in its details. **Continue scan** runs the
remaining rounds. A scan paused by stopping the service starts again with the
round that was running. The limit field
holds what is left of the limit the scan ran under; change it if needed. A scan
that ran without a limit continues without one.

The job continues in the local service when you navigate away or close the
page. Scans and scan details show its current phase. For an AI scan, a coverage
card at the top of scan details shows the files covered, read in full, read in
part and unread. It has one cell per round the scan may run. While the scan runs,
the card also shows the findings and tokens so far. After two rounds it estimates
the pace from the latest rounds: the new files a round covers, and where the round
limit or spending limit stops the scan at that pace. It is an estimate only.
The progress card shows reading the source, then the discover and validate steps
of the current round. Below it, the latest rounds list their files, findings,
time and tokens. While a model replies, the current round shows the reply as it
streams: thinking, about how many output tokens it has written, and the tool it
is calling. Claude also reports the input tokens at the start. The output count
is an estimate from the characters received. The reply's reported usage replaces
it when the reply ends, and only reported usage counts toward the limit. Reply
text is never shown or saved. Between replies, the current round shows its
latest step, such as a file an Explore round reads. The details column appears
when the scan finishes.

A Full coverage AI scan shows **Pause scan** and **Stop scan** while it runs; other
scans show **Stop scan** only. **Pause scan** waits for the running round to
finish, so no tokens are spent on a request that is cut off. Meanwhile the button
reads **Pausing after this round…** and **Stop scan** still works. **Stop scan**
ends the current request at once. Rounds that finished are kept with their
findings. A round that a stop cut off stays in the list as not completed, with
the tokens it charged. A paused scan can continue
later with **Continue scan** in the scan header, under what is left of its limit; a
scan with a limit can also set another one in the paused card first. **Stop scan**
also ends a paused scan for good, keeping its findings. A stopped scan shows
**Stopped** and cannot continue. Provider failures and
refusals stop further requests. Response validation errors name the failed stage
and field when available. Completed static findings remain visible if the AI
review fails.
Stopping the service pauses a running Full coverage AI scan, so it can continue
after a restart, and stops other jobs. A job interrupted before it saved its end,
for instance by a crash, is paused on restart when it is a Full coverage AI scan
and reported as failed otherwise. Findings of a scan paused this way appear when
it continues and finishes.

The local service pushes scan changes to the page as they happen. The page
polls every second only while that connection is closed. Claude, OpenAI and
ChatGPT replies stream. Gemini and Ollama replies arrive whole, because
compatible servers differ in how they report usage in a stream.

No project code, package scripts or model tools execute. The service reads
source and uses fixed read-only Git metadata commands. It does not install
project dependencies or probe a running application. The static engine and the repository's GitHub Action run without model usage.

## Review findings and outputs

**Findings** combines saved static and AI findings across local projects. Search,
project, severity, validation and status filters update the table and severity-to-status
diagram. The initial view includes New, Triaged and In progress candidates that validation
has not dismissed. Origin and validation have separate labels. Static indications
without a completed source review show as Unvalidated, including historical data.
Use the validation filter to see dismissed static candidates.
Select a column header to sort by it, and again to reverse it; this works in every
table. Open a row to see its summary, root cause, attack path, validation,
remediation, affected source locations and captured evidence.

The status selector saves **New**, **Triaged**, **In progress**, **Resolved** or
**Dismissed**. A finding reported again keeps its status and first detection
date. An AI finding counts as reported again when a later review gives the same
STRIDE category and overlapping source evidence, even under a new title. A
resolved finding that is reported again reopens as **New**; a dismissed one stays
dismissed. A complete static scan resolves static findings it no longer reports,
unless the scan was truncated or skipped their file. AI findings are never
resolved by absence, because each round covers only part of the source.
Validation outcomes for either origin, such as Source-supported and Needs review, describe the
source analysis; they are separate from this workflow status.

**Scans** lists start time, source, initiator, duration, reported tokens and job
status. Open a scan for its findings. The **Coverage** tab of an AI scan lists
the eligible files by folder, read, partial and unread, and every round with the
files it read. The file list comes from the saved static scan. A scan without one
lists only the files its rounds covered. The **Outputs** tab contains
architecture, assets, trust boundaries, all six STRIDE categories, traced paths
with how the review closed each, dismissed candidates with what each dismissal
rests on, source coverage and limitations. The right column records the observed
revision, environment snapshot and provider. Git metadata names the commit and
branch at start; it does not freeze the files. Plenger does not read working-tree status,
because Git would run the filter commands that a project's own Git configuration
names. Included file digests identify what the
model actually received. Anthropic and OpenAI dollar estimates use the selected
models' captured prices. **Usage by request**, under Model & usage in the right
column, opens a drawer with each request's uncached input, output, cache writes
and cache hits, by round. Reported token totals remain
visible when another response lacks usage. Scan details explain incomplete totals.
Older scans can recover totals from their saved billing details without a new scan.
Budget reservations never replace missing usage. Missing prices or all missing usage
remain unavailable. ChatGPT subscription scans estimate USD using standard API rates.
The breakdown records the pricing basis and completeness for each pass.

**Export scan** downloads the redacted job, its findings and review records.
It is distinct from the static engine's versioned JSON report. Dismissed model
candidates remain in the review records even though they are absent from the
default finding table. Cross-origin duplicates merge only with a CWE of the same
family and an overlapping sink after validation identifies the duplicate. Rule ids,
provenance, review reasons and earlier triage states remain traceable in the report.

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
models that account offers. The list is saved with the connection, so the editor and
New Scan offer the same choice. **Reconnect ChatGPT** replaces it with the latest list.
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

### Model pricing

Anthropic and OpenAI API connections load standard API prices from
[Models.dev](https://models.dev). Plenger reads full model records from its
public repository to retain cache-write rates and long-context tiers. These
requests send no API key or project source. Missing prices are not guessed.

ChatGPT connections use the same read-only OpenAI price catalog. Their reported
input, cached input and output tokens produce a USD estimate, with reasoning
included in output once. This compares the scan with standard API pricing. It is
not a subscription bill or a measure of credits or remaining quota. Missing cache
details leave the estimate incomplete or unavailable. Subscription providers accept
token limits and USD limits based on standard API rates. These limits compare
estimated usage, not subscription charges or credits. Requests reserve an allowance
before dispatch; subscription output usage is checked after each response.
See [ChatGPT pricing](https://learn.chatgpt.com/docs/pricing).

Open **Model pricing** for a read-only list of prices. Expand **Pricing details**
to inspect cache writes, context tiers, the source and the last update time.
Pricing loads when this tab is selected. Opening **Connection** does not load it.
The tab's badge reads locally cached prices when the drawer opens, including after
a page reload. It does not fetch individual model prices to populate the count.
Reopening pricing reuses fresh results in the dashboard session. Unavailable models
wait five minutes before an automatic retry; **Refresh pricing** retries immediately.
There are no manual price inputs. **Refresh pricing** fetches the latest records.
Successful records are cached locally for 24 hours and survive restarts. A failed
automatic update can use the last cached record, with a notice. A failed explicit
refresh keeps the current prices.

Each scan checks pricing for its selected models at startup, including a separate
validation model. Missing or expired records load automatically. Earlier manual
rates are a fallback if the catalog cannot be loaded. Each scan keeps its original
price snapshot. Older scans without a billing breakdown are not repriced.

Estimates sum each token category once per request. Long-context tiers compare
all input tokens, including cache reads and writes, with the saved threshold.
OpenAI cache reads and writes are subtracted from prompt totals before charging
uncached input. Reasoning tokens are included in completion totals and are not
charged twice. Missing usage, unknown cache lifetimes and nonstandard OpenAI
service tiers cannot be priced as standard requests.

The catalog is community maintained. Estimates use standard global API list
prices and exclude discounts, taxes, regional premiums and other service charges.
They are not invoices. Loading prices does not enable prompt caching. See the
[OpenAI pricing documentation](https://developers.openai.com/api/docs/pricing)
and [Claude pricing documentation](https://platform.claude.com/docs/en/about-claude/pricing).

**Connection** holds the API key, default model and advanced endpoint settings.
Save the provider to apply connection changes.

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
unchanged. Finish, pause or stop active scans before clearing data.

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
