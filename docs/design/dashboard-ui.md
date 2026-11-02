# Dashboard UI design

The local security workspace reviews source folders on this computer. Codex
Security informs the finding reports and Clerk informs the visual styling.
The interface follows Plenger's available local capabilities. Its navigation is
**Findings**, **Projects**, **Scans** and **Settings**, each with an icon.
Provider settings retain their connection behavior and use the shared React Aria components.
Usage is documented in [../guide/dashboard.md](../guide/dashboard.md), with
qualification in [../STATUS.md](../STATUS.md).

Page modules load through React lazy and Suspense. Once the first page shows, the
other pages load in the background, so a first visit renders at once. The shell
stays visible while a page loads. Scan forms and their drawer code load on first
use and stay mounted afterwards to preserve closing and focus behavior. Keep the
default 500 kB build warning and check emitted chunks when adding dependencies.

## Shell and visual system

Use a centered workspace with a sticky two-row header, underlined tabs, quiet
borders and dense tables. The first row contains the Plenger brand and New Scan
at the right. The second row contains
the four main tabs. Settings opens provider connections and stays active on nested
settings routes. Header, tabs and content share a 1280px container with
32px gutters, reduced to 16px on small screens. Child sections do not add a
second outer gutter. Do not restore the old
Overview, Inventory or campaign sidebar in this shell. The workspace has no footer.
The header rows are 56px and 40px tall. Tables and drawers use compact padding.
Data tables sit in a recessed tray that carries the sentence case column labels.
The rows form a card inset 3px inside it, with quieter lines between rows than
at its edge. Every data column sorts from its header button; Actions columns do
not. The first click puts dates, counts and severity largest first and text from
A, and a second click reverses it. The sorted column's label reads in ink with
its arrow; other headers show a faint arrow on hover or focus. The sort lives
in the `sort` search parameter, so it survives opening a row and coming back,
and paginated lists sort before they are sliced. Rows without a value, such as
an unscanned project, stay last. Providers keep their saved order, the default
first, until a column is chosen. Search and filters sit
above the tray, apart from the table. Tables have no footer. Search keeps a
fixed 320px width at the start of the toolbar, with filters beside it. A page
action such as Add project sits at the far end. Phones give search a full row.
Settings includes Appearance, Providers and Data. Appearance places Theme and
Density in two adjacent cards, with more room for Theme. Narrow layouts stack
the cards. Theme offers Dark, System or Light as compact radio cards that each
preview the dashboard. System shows light and dark side by side. Density uses
a Comfortable or Compact segmented control above one findings table preview.
The preview follows the selected density and shows more rows when compact.
A choice saves immediately, with its save status beside the Appearance heading.
Data lists what clearing removes and preserves in two columns inside one card.
An irreversible-action notice and the Clear data button sit in its footer.
The existing confirmation dialog is required before deletion.

The header shows `/logo.svg`, the 48 by 48 pixel art tiger, beside the wordmark.
It is also the favicon. Show it at 24px or 48px so each logo pixel maps to whole
screen pixels. Keep this logo when changing navigation or menu icons. The header wordmark reads
PLENGER in bundled Bytesized at 32px. Its glyphs sit on 8 units per em, so keep
the size a multiple of 8 for sharp pixels.

Read colors, radii and typography from `styles/tokens.css`. Layout rules for
this shell live in `styles/security.css`; shared controls remain in
`styles/styles.css`. Light and dark appearances share structure. Dark remains
the default and SQLite preserves the selected appearance before page scripts
load. System follows the device setting in CSS, so it also applies before
scripts run and changes with the device. Any element with `data-theme` takes
that appearance's tokens, which is how the previews show both. Use bundled
Geist Sans for interface text and Geist Mono for source, paths and identifiers.
Counts use tabular numbers.

Light appearance uses the palette as given: Arctic Powder (`#F1F6F4`) canvas
and fields, white cards, Mystic Mint (`#D9E8E3`) secondary surfaces and Oceanic
Noir (`#172B36`) text. Primary actions use Forsythia (`#FFC801`) with Oceanic
Noir labels. Links, selection and checked controls use Nocturnal Expedition
(`#114C5A`). Deep Saffron (`#FF9932`) marks the current page and tab. Both warm
colors also tint medium and high severity. Dark appearance is derived
from the same colors: an Oceanic Noir canvas with surfaces lifting toward
Nocturnal Expedition, Arctic Powder text, a lighter Nocturnal Expedition for
links and selection, the same Forsythia actions and Deep Saffron marks, and
Forsythia and Deep Saffron at full strength for medium and high severity. Dark focus rings use Mystic Mint. Derive surface layers and
borders from this palette, with readable contrast in both appearances.
Controls have depth: buttons and selected segments are raised, with a light top
edge and a short shadow, and flatten slightly when pressed. Inputs, selects and
segment tracks are recessed. Cards lift a little further and floating layers
most. The depth comes from shadow tokens in `styles/tokens.css`.
Reserve severity colors for finding severity and chart ribbons. Green indicates completed jobs.
Workflow status and security severity are separate concepts. Keep actual source
paths, review limitations and unknown values explicit.

## Findings

The toolbar combines search, project selection, open/all/closed views and
status/severity filters. Active status filters appear as removable chips.
A severity-to-status flow uses the currently filtered findings, including zero
and mixed-status results. Its minimum readable width can scroll inside its
container on phones. It never uses demonstration counts in the product.

The table shows severity, finding, project, origin, status and detection
time. Sort by severity, most severe first, until another column is chosen, and
paginate at 30 findings. Selecting a row opens a
full page report with Summary, Root cause, Attack path, Validation, Remediation
and captured evidence. The metadata column holds severity, editable workflow
status, observed revision, project, detection time and affected locations.
View scan returns to the original scan. A historical occurrence keeps its own
source evidence while showing the current workflow status.

Fix with a coding agent opens a drawer. The user chooses a provider and
explicitly generates a prompt, then copies it. It does not launch an agent or
apply a patch. Optional REA evidence is unselected by default.

## Project details

Project names open `/projects/:id`. Keep Projects selected in the main navigation.
The page has a project heading, New Scan, saved finding counts and a metadata
column. Findings and Scans are separate project-scoped views. Scan rows open
their saved results. Latest scan outputs link to the existing scan output view.
Preserve project context when opening findings and scans so the back link returns
to the project. An unscanned project still opens its detail page with an empty state.

## Projects and scans

Projects shows saved local folder names and paths, the last scan, open finding counts
across all scans and a per-row New Scan action. Search operates on project names
and paths.
Add project saves a folder, optional display name and optional review context.
Git is optional. Registration does not call a model.

Scans shows start time, local source, duration, reported tokens and status.
Search and state filters operate on saved jobs. Scan details have Findings and
Outputs tabs with metadata beside them. Outputs includes architecture, assets,
trust boundaries, all six STRIDE categories, source coverage and optional REA
imports. Scans with several batches expose their independent batches and
limitations. The summary shows files covered, why batches stopped and what the
limit was charged. A scan that finished what it set out to do carries a green
check: a Quick round, or Full coverage that read every file or found nothing new.
A finished Quick scan says it is complete and how many files Full coverage would
add, so unread files do not read as a scan cut short. Quick is measured against
its round, not the project. A Batch round packs its files before the first model
call, so the card shows them as the target, for example 6 of 6 files in the
round, with the project total beside it. Explore chooses its own files, so the
card counts the files read and shows no target bar.

Scan details place the project, status and actions in one header. A compact
summary shows elapsed time, saved findings and scan depth. Metadata groups source,
model usage and timing. Per-request token usage opens in a drawer from Model &
usage, so the main column starts with its tab content. Long folder paths wrap within the panel. While a scan
runs, show its actual read, review and validation stages without estimating a
percentage. Cancel acknowledges the pending request. Export snapshot identifies
incomplete records; finished jobs use Export JSON. The header holds the scan's
actions in the same places: a running scan has Pause scan, Stop scan and Export
snapshot; a paused one has Continue scan, Stop scan and Export snapshot, with
Continue where Pause was. Pause waits for the round to end, so the button reads
Pausing after this round and stays disabled while Stop stays available; the
progress card keeps moving until then. Header Continue keeps what is left of the limit; the
paused card can set another limit first. Scan again opens the local scan form
after a job ends, never while it is paused. Empty failed runs are incomplete, never clean results.

The progress card lists the stages on a vertical timeline. The active stage
holds its description and the latest activity, newest first. The heading shows
the tokens charged so far. A source and shield illustration follows the active
phase. It loops while the scan works, because a batch scan can wait minutes
for one reply with no new step. It works like a spinner, so it has no pause
control. Each step that arrives adds one ring from the shield. Motion stops
while a scan cancels. Reduced motion keeps it static.
Sort scan findings by severity, highest first, across static and AI origins.

Show Reading source, Discovering findings and Validating findings while a job
runs. A failed AI review names the response stage and rejected field when
available. Keep completed static findings visible and explain that they are
separate from the failed model review. Navigation does not cancel the job. Cancellation has a separate action.
Job completion is separate from the presence of findings. Refusals and failures
remain visible with their saved outcome. Missing token usage is unavailable,
never zero. Dollar estimates require saved model prices and reported usage.
Show partial estimates explicitly and retain the price snapshot used by each
scan. Do not invent account credits, hosted environments or remote integrations.

## New Scan drawer

Use a right drawer up to 760px wide and full width on phones. Keep its title
and close action above the scrolling form. Cancel and Start Scan stay in a
fixed footer, alongside a visible source-dispatch and API-usage disclosure.
The form selects a saved local project, provider, model, review mode and scan
depth, in that order. Labels sit left of their controls and stack above them on
phones. Small titles and hairlines group Source, Model and Review.
Show the selected folder path on one line; a long path loses its start, never
the project folder, and the file count stays at the right. Keep optional review
context in a disclosure under the project. Do not add environment or
scan-scope selectors.
Provider and model share one row. Start with the provider's default model; a
scan's model choice does not change that default. **Validate with** keeps the
same model by default, or picks a saved connection and its model for this scan
only.
Mode and depth are radio cards. Both options show one line on what they do and
a chip with what they cost, such as model calls per round or the rounds a
project needs, so they compare without switching. The selected card takes the
selection ring and a filled radio dot.
Full coverage adds a limit. Presets offer token or USD amounts that fit one
round's maximum, plus No limit, and a field takes any other amount, shown with
thousands separators. Errors stay under the field.
The footer adds the choices up into a plan above the disclosure: mode, depth
and limit on one line, then the source per round and the rounds the limit
guarantees. Phones keep only the first line.
Static checks, AI code review and STRIDE threat modeling remain included.

All scans start manually. The service does not watch commits or start scheduled
reviews. Saved monitors from earlier versions are disabled on startup. Existing
projects, scan history, triage and provider settings stay saved. Earlier
`/repositories` bookmarks redirect to `/projects`. Internal repository record
names and API paths stay compatible with saved data; they do not imply a remote
repository connection. Availability is recorded in [../STATUS.md](../STATUS.md).

## Accessibility and responsive behavior

Changing numeric readouts use Torph's Counter tick behavior through `MorphNumber`.
Match digits by place value and use tabular figures. Only changed digits move.
Use the shared 200ms ease-in-out transition without scale. Running scan timers tick
locally once a second between API polls and stop when the scan finishes.
Reduced motion displays updated values without rolling digits. Keep dates, model
IDs, source text and editable fields static. Torph measures every glyph when it
attaches, so a value stays plain text until it first changes. A table of saved
values then opens without layout work. Scan cost tables render only while their
section is open.

Use semantic tables, visible labels and status text alongside color. Shared
React Aria Components provide buttons, inputs, selects, checkboxes,
menus, tabs, popovers and confirmation dialogs. Right drawers use Vaul with
accessible titles and descriptions, focus trapping and explicit focus restoration.
React Aria popovers and provider deletion confirmations portal inside the drawer
so its modal focus scope includes them. Escape dismisses the innermost popup first. Drawers lock background
scrolling and allow vertical scrolling inside the form. Busy forms cannot dismiss
their modal. Reduced motion disables drawer animations. React Aria reads the
response stylesheet nonce from the `csp-nonce` meta property. Radix scroll-lock
styles use the same nonce. CSP admits the pinned Torph, Vaul and Notch Toast
stylesheets by hash. No inline script or style policy is relaxed.

Notch Toast confirms finished actions; pages show no inline success notices.
Toasts cover a saved, deleted or default provider, a connected ChatGPT
sign-in, an added or deleted project, a finding status, a saved threat model,
imported or removed REA evidence, cleared data and a copied prompt. Call
`notifySuccess`, or `notifyInfo` for an action that changed nothing, such as a
cancelled sign-in. A short request the person waits on, such as a connection
test, uses `notifyPromise`: one toast shows progress, then the outcome. Its
failure toast names the reason, so a connection test shows nothing inline. Keep
every toast under about 35 characters; the toast does not wrap and clips on a
phone. Other errors, ongoing progress and instructions stay inline next to their
controls. The toast is a raised surface of the current appearance: a success
is tinted green and a failure red, each with an icon in that color. The toast
hides its own text from assistive technology, so a persistent status region
repeats each message for screen readers.

Ordinary buttons, icon buttons, inputs and select triggers share a 32px control
height, 13px type, 18px line height, 1px border and 8px radius. Panels use a 12px
radius. Use shared control tokens for padding and icon size. On small screens
controls are 40px with 16px type; coarse pointers use 44px controls. Multiline fields and selection indicators
keep their appropriate shapes. Primary and secondary buttons have the same
geometry. Do not add individual size overrides in page styles.
Button colour follows the action. Primary Forsythia marks the main action, danger
an action that cannot be undone such as Stop scan, warning one that interrupts
work but can be undone such as Pause scan, success one that resumes work such as
Continue scan, and secondary the rest, such as Export.

Density changes spacing, never control size. Table, round and coverage rows,
panel padding and the gaps between panels read `--row-padding-block`,
`--panel-padding` and `--section-gap`. Compact sets them to 6px, 16px and 12px
from 12px, 20px and 20px. Use these tokens for new repeated rows and panels.

The navigation always has its own header row. Below 480px the four tabs use
equal columns with icons above their labels. All labels stay visible.
Below 720px controls wrap, report
metadata moves below the document and form fields stack. Source blocks and
wide tables scroll within their own regions. Long paths wrap without expanding
the page. Keep the drawer footer usable at 320px. Preserve keyboard focus rings
and the skip link.

## Providers and red-team

Provider settings keep named connections, endpoint/model controls, encrypted
key presence, connection tests, default selection and deletion confirmation.
The browser receives only a masked preview with at most the last four characters
of a stored API key. Keys shorter than 12 characters stay fully masked. Derive the
preview locally without persisting it. Keep the replacement input empty and show
the preview as its placeholder only while the provider and endpoint match.
The provider table shows the same preview under the endpoint, and screen readers
hear the kept characters. ChatGPT sign-in credentials have no key preview. Row
actions are secondary buttons; the actions menu is a square one with a dots icon.
Editors continue using the shared
drawer and popup primitives.

Claude editors split Connection and Model pricing into keyboard-accessible tabs.
Keep Cancel, Save provider and save errors in a fixed footer. Preserve drafts
across tab and model changes. Saving invalid prices opens the affected model
and focuses its first invalid field. Group USD rates in aligned category rows,
with the unit stated once. Keep long context rates optional and explain
estimates in a disclosure. Advanced connection settings hold the endpoint and
generation defaults.

Anthropic and OpenAI place the API key before a model selector. **Load models**
uses the entered key or the saved key for the same endpoint. Clear the catalog
when the provider, endpoint or key changes. Keep loading, empty and failure states
visible beside the selector. Persist successful catalogs locally and restore them
when a saved provider is opened, including after a restart. Restoring a catalog
never contacts the provider. **Reload models** explicitly refreshes it; a failed
refresh preserves the previous list. Cache scope includes the provider, normalized
endpoint and key, using a private HMAC without storing draft credentials.
Model IDs come from the provider API, without a bundled model list.
Temperature and output controls are hidden for these providers.
Save null generation settings. Claude's required output cap is determined from
model metadata and the operation allowance. OpenAI defaults omit the optional
output limit and report observed token thresholds.

The legacy `/redteam` URL shows Coming soon without execution controls. It is
outside the four main workspace tabs. The CLI engine and its earlier
contracts are documented separately in [redteam-contracts.md](redteam-contracts.md).
