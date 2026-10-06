# Dashboard UI design

Visual design rules for the dashboard frontend under `dashboard/src/`. Usage
is documented in [../guide/dashboard.md](../guide/dashboard.md).

The dashboard uses a monochrome enterprise system with one accent. Tokens live
in `dashboard/src/styles/tokens.css`; components read only those tokens and are
styled in `dashboard/src/styles/styles.css`. Both appearances share layout,
type and spacing.

## Color and surfaces

- Neutral layers, from back to front: canvas `#0b0b0b`, sidebar `#0e0e0f`,
  cards `#111112`, nested surfaces `#18181a`. Floating layers (menus, drawers,
  dialogs) use `--raised` with a soft popover shadow.
- Borders are hairlines: 6% white for dividers, 11% white for controls.
  Cards add a 1px top highlight instead of a heavy shadow.
- Primary text `#ededee`, secondary `#8e8e96`, tertiary `#64646c`.
- One accent, `#7ea4f7`, marks the active navigation item, focus rings,
  selected rows and the primary chart series. Nothing else uses it.
- Severity colors carry finding severity only, on tinted badges with a dot.
  Green marks success and the local-workspace status.
- Primary actions are monochrome: a light fill in dark mode, a dark fill in
  light mode, each with a subtle vertical gradient.

Dark is the default appearance. Light mode uses a `#fafafa` canvas, a `#f4f4f5`
sidebar, white cards, `#111113` primary text, `#66666f` secondary text and the
accent `#2f63d6`. The sun/moon action in the sidebar footer switches to the other
appearance and remains available on narrow screens. SQLite saves the global
choice independently of the selected project. Apply it to the initial HTML to
avoid a flash on page loads.

## Typography

Use locally bundled Geist Sans for the interface and Geist Mono for code,
source paths and identifiers. UI copy is 14px/1.5, table text and secondary
copy 13px, metadata 12px, and group labels and table headers 11px uppercase
with 0.06em tracking. Card titles are 15px, page titles 24px (22px on phones)
with -0.025em tracking. Body copy uses weight 400, navigation and controls 500,
headings 600. Counts and metrics use tabular numbers.

The brand pairs the outlined `n` monogram from `dashboard/public/mark.svg` with
the Plenger wordmark in locally bundled Nanum Pen Script, 20px at weight 400
with natural letter spacing. Light mode inverts the monogram tile.

## Shell

A 248px sidebar holds the brand, the project switcher, grouped navigation
(Analyze: Overview, Findings, Inventory; Test: Red-team; Workspace: Scan
history, Settings) and a footer with the local-workspace status and the
appearance toggle. The project switcher shows an initial tile, the project
name and its parent path. Navigation counts use Torph.

A sticky 56px topbar beside the sidebar shows a breadcrumb (project or
Workspace, then the page), when the open scan was taken, and the scan actions:
Export JSON and Scan or Rescan project. These actions are available on every
page. Page headings sit below with a title and one line of description.

Below 1024px the sidebar becomes a header row (brand, project, appearance) and
the navigation becomes a sticky, horizontally scrolling tab strip with an accent
underline. The breadcrumb is hidden there; the scan actions stay at the top of
the page.

## Components and layout

Cards, dialogs and drawers use the 12px `--panel-radius`; controls, inputs,
badges and menus use the 8px `--ui-radius`. Flush surfaces inside a shared
container remain square so adjacent edges join cleanly. Content shares a
centered 1240px container with 16px gaps between cards and 20px card padding.

Overview opens with a metadata line (project path, rule count, frameworks) and
a single KPI strip of four metrics divided by hairlines. The findings metric
adds a stacked severity meter. Charts, priority findings, frameworks and
coverage follow as cards with a title and a one-line description; eyebrow
labels are reserved for drawers and group labels.

Data tables share one header treatment: a quiet band with small uppercase
labels. Rows use a neutral hover; the row whose detail is open gets an accent
tint and a 2px accent edge. Severity filters are a segmented control.

Vaul drawers are Radix modal dialogs that disable pointer events outside
themselves. While a drawer is open, Base UI selects and confirmation dialogs
mount inside it (`dashboard/src/shared/PopupLayer.tsx`), and Escape closes the
open popup before the drawer.

Preserve keyboard focus, modal scroll locking, reduced motion and readable
wrapping. Long technical disclosures use bounded scroll regions; hiding overflow
must not remove their content.

Inventory uses the same sub-navigation layout as Settings: a narrow category
list on the left and a headed content column on the right. The list starts with
Frameworks, followed by the declaration categories, and stays in view while the
table scrolls. The active item uses the same raised style as Settings. Base UI
vertical tabs provide keyboard navigation; a synchronized Base UI Select dropdown
replaces the list below 700px. Category counts use Torph only for numbers.
Each category has a heading with its name, total count and a one-line
description. The table panel opens with a toolbar: search by name, configuration
or source file on the left, and a framework filter using the shared Base UI
Select on the right. Paginate at 20 declarations; the footer puts the visible
range on the left and Previous / Next on the right. Frameworks list each detected
framework with its files, and a second table lists unrecognized AI imports.

Align declarations, configuration and source locations in shared columns. Keep
frameworks under the declaration name, use compact chips for configuration and
linked tool counts, and show the filename and line above its directory. Long
names and paths expose their complete values on hover and in the detail panel.
Unresolved values stay explicit. Distinct declarations retain their own rows even
when they share a constructor. Selecting a row opens its metadata, captured prompt
and capabilities in a Vaul drawer on the right, with scroll locking, swipe dismissal, Escape to
close and focus returned to the row. On phones this panel fills the viewport.
Configuration moves under the declaration on narrow screens while source stays
in its own column. Frameworks remain in an expandable summary above the browser.

## Findings

Use a single compact page header with the finding count; the topbar shows the
scan timestamp.
The full-width table groups severity, a short rule title with subject and rule ID,
source filename/directory, and confidence. The toolbar combines search, severity
filters and a Base UI sort select. Default to highest severity, then score; paginate
at 20 findings. Hover rows use a neutral surface and the open row an accent tint, with
severity colors restricted to badges. On phones, rows stack source and confidence below the title,
and a Base UI severity select replaces the filter buttons.

Selecting a row opens a 680px Vaul drawer with the full finding title, source code,
numbered evidence trace with expandable code context, risk explanation, review
notes and suggested remediation.
Keep all source observations and reference mappings. Deep links open the matching
finding, Escape dismisses the drawer and returns focus to its row, and the panel
fills the viewport on phones. Use the table-shaped skeleton while loading and Torph
only for numeric counters.

## Red-team results

A saved-test switcher sits above the result: the caption with the number of
saved tests, the test select, then Export result and Export test profile. A
result is one panel of flush sections divided by hairlines:

1. Verdict: tone icon, title and explanation, with pills on the right for the
   process state and, once finished, whether the CI gate passed. Issue and
   warning verdicts get a faint tinted band. The process state never stands in
   for the security result.
2. Key figures: model and provider, repetitions, normal tasks, model calls and
   tokens, each with a small usage bar where a limit applies.
3. Notices: a CI gate minimum below the estimation threshold (warning), errors
   with a link to the fix, stale results (warning) and context (info). Each has an icon and full text. A missing safeguard is not a notice;
   it gets its own section below.
4. Direct tool checks: one card per handler called without the model, with the
   outcome chip, the observed change, the arguments sent and the recommended
   fix. The section sits directly under the key figures when a handler accepted
   the prohibited arguments, so the failing evidence comes first, and after the
   model table otherwise. The verdict text leads with the channel that failed.
5. Attacks through the model: a table with violation counts as tinted chips,
   usable tests with a bar, and the observed rate with its interval. Below the
   comparison minimum the cell reads "Too few tests to estimate" with the count
   needed and the interval in the note, never a bold percentage. The method
   note sits below it as a footnote.
6. Discovered surfaces exercised, as a ratio with a bar. Handlers exercised by
   direct tool checks count, and the text says how many.
7. Collapsible blocks (CI gate, evidence by repetition, technical evidence)
   with an icon tile, one line of description and a value on the right.

A single run uses the same parts: attack checks replace the table, and the
normal task and coverage notes sit side by side. Comparison, run setup and
test setup below the result use the same collapsible summary.

## Scan history

The page opens with a heading that carries the saved-scan count and one line
with the number of projects, and the Clear saved data action on the right. The
table uses the shared header treatment: project name with its directory in
mono and an icon tile, scan time with a relative time under it, source files,
findings as a count chip, and a chevron. The scan open in the workspace gets
the accent tint, the 2px accent edge and an Open now tag. A search field
filters by project name or path, and the footer shows the visible range with
Previous / Next at 20 scans per page. Below 1000px the source file column is
hidden; on phones the scan time moves under the project name.

## Project picker

Keep the project dialog compact: a title and close button, followed by a location
breadcrumb and Browse action. Show the last two path segments and place earlier
ancestors in a Base UI menu opened by `…`, without horizontal scrolling. Truncate
long names and expose their full paths on hover. The labeled Edit action switches
to a focused path input, with Enter to navigate and Escape to
cancel editing. Keep Parent folder at the top of the dense folder list. Use
skeleton rows during initial loading. The footer identifies the selected folder
by name and provides Cancel / Open project, without repeating the full path.

## Icon semantics

Use outlined Gravity UI icons consistently at a native 16px size. A plain
`ChevronRight` indicates disclosure, rotating down when expanded; show-all
controls point down when collapsed and up when expanded. Reserve directional
arrows for actions with a direction.

| Meaning | Gravity UI icon |
| --- | --- |
| Models | `Cpu` |
| Agents | `FaceRobot` |
| Tools | `Wrench` |
| LLM calls | `Comments` |
| Entry points | `ArrowRightToSquare` |
| MCP servers | `PlugConnection` |
| MCP clients | `PlugWire` |
| Data stores | `Database` |
| Prompts | `FileText` |
| Frameworks | `Cubes3` |
| Source files | `FileCode` |
| Parent folder | `FolderArrowUp` |
| Red-team review | `Shield` |
| Remaining preparation steps | `ListCheck` |
| Switch to light / dark mode | `Sun` / `Moon` |
| Project switcher | `ChevronsExpandVertical` |
| CI gate | `Flag` |
| Compare tests | `ArrowRightArrowLeft` |
| Error / warning / context notice | `CircleXmark` / `CircleExclamation` / `CircleInfo` |

## Settings

The sidebar navigation uses consistent 16px Gravity icons beside every label.
Settings lives at `/settings/providers`; the old `/providers` URL redirects there.
Use a narrow category sidebar on the left, currently containing Providers, and
a provider table on the right. The table shows named connections, provider/model,
endpoint, saved-key presence and actions. Put Add provider in the section heading;
open Add/Edit in a Vaul drawer, rather than keeping a large form on the page.

Connections are shared across projects. Keep one default connection for new tests,
allow multiple saved providers, and select a named provider in the red-team form.
Actions include Edit, Test connection, Make default, and Delete with confirmation.
Do not expose API keys in table rows. Keep button labels static during requests
and disable actions while pending. On smaller screens, stack the sidebar above
the table and simplify columns; the editor fills the viewport on phones.
