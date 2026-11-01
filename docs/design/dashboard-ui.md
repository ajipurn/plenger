# Dashboard UI design

The local security workspace reviews source folders on this computer. Codex
Security informs the finding reports and Clerk informs the visual styling.
The interface follows Plenger's available local capabilities. Its navigation is
**Findings**, **Projects**, **Scans** and **Settings**, each with an icon.
Provider settings retain their connection behavior and use the shared React Aria components.
Usage is documented in [../guide/dashboard.md](../guide/dashboard.md), with
qualification in [../STATUS.md](../STATUS.md).

Page modules load on navigation through React lazy and Suspense. The shell stays
visible while a page loads. Scan forms and their drawer code load on first use
and stay mounted afterwards to preserve closing and focus behavior. Keep the
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
Settings includes Appearance, Providers and Data. Appearance holds the Theme
choice: Dark, System or Light, as radio cards that each preview the dashboard
in their appearance. System shows light and dark side by side. The Density
choice, Comfortable or Compact, uses the same cards with a findings table that
shows more rows when compact. A choice saves immediately.

The navbar uses the existing `/mark.svg` brand asset, shared with the favicon.
Keep this logo when changing navigation or menu icons. The header wordmark reads
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
time. Sort by severity and paginate at 30 findings. Selecting a row opens a
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
limit was charged.

Scan details place the project, status and actions in one header. A compact
summary shows elapsed time, saved findings and scan depth. Metadata groups source,
model usage and timing. Long folder paths wrap within the panel. While a scan
runs, show its actual read, review and validation stages without estimating a
percentage. Cancel acknowledges the pending request. Export snapshot identifies
incomplete records; finished jobs use Export JSON. Scan again opens the local scan
form after a job ends. Empty failed runs are incomplete, never clean results.

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
phones. Hairlines group the project, the models, and the review settings.
Binary choices are pill segmented controls whose raised thumb
slides to the selected option. They describe only the selected option and its
model calls. Selected segments, checkboxes and
switches use the selection color. Start with the
provider's default model. A scan's model choice does not change that default.
Show the selected folder path. Keep optional review context in a disclosure
under the project. Do not add environment or scan-scope selectors.
Validation uses the same provider and model by default. A checkbox reveals
separate validation provider and model choices. These apply only to this scan.
Quick and Full coverage describe actual review coverage. Full coverage offers
an optional token or USD limit behind a checkbox that is on by default, and
shows how many batches the limit guarantees and how many the project needs.
Without a limit it states the batch cap and one batch's maximum.
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
IDs, source text and editable fields static.

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

Notch Toast confirms a finished action whose controls have closed: a saved,
deleted or default provider, cleared data and a copied prompt. Call
`notifySuccess` from `shared/toast.tsx` with under about 35 characters. The
toast does not wrap and clips on a phone. Errors, progress and instructions
stay inline next to their controls. The toast hides its own text from assistive technology, so a
persistent status region repeats each message for screen readers.

Ordinary buttons, icon buttons, inputs and select triggers share a 32px control
height, 13px type, 18px line height, 1px border and 8px radius. Panels use a 12px
radius. Use shared control tokens for padding and icon size. On small screens
controls are 40px with 16px type; coarse pointers use 44px controls. Multiline fields and selection indicators
keep their appropriate shapes. Primary and secondary buttons have the same
geometry. Do not add individual size overrides in page styles.

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
ChatGPT sign-in credentials have no key preview. Editors continue using the shared
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
