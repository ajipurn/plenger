# Plenger dashboard design

The dashboard follows the [Fey reference on Refero](https://styles.refero.design/style/a0630421-7b66-48b4-aa14-6194a3b2c2b9).
Its extended DESIGN.md and CSS Variables export were reviewed. The exported CSS
is copied into `dashboard/src/fey.css`; application mappings live in
`dashboard/src/tokens.css` and components in `dashboard/src/styles.css`.

## Color and surfaces

- Canvas: Fey Ink `#0b0b0b`.
- Cards: Fey Charcoal `#191919`; nested content and inputs: Fey Obsidian `#131313`.
- Primary text: white; secondary copy: Fey Graphite `#868f97`.
- Navigation underline: Fey Signal `#479ffa`.
- Selection and focus: Fey Growth `#4ebe96`.
- Severity colors carry finding severity; blue carries navigation only.

Dark is the default appearance. Light mode uses a `#fafafa` canvas, white cards,
`#f4f5f6` nested surfaces, `#17191c` primary text and `#626b73` secondary text.
Primary actions use dark fills in light mode. Shadows, code blocks, severity
colors, focus rings, backdrops and scrollbars follow semantic appearance tokens;
layout, typography and spacing stay consistent between modes.

The header's compact sun/moon action switches to the other appearance and remains
available on narrow screens. SQLite saves the global choice independently of the
selected project. Apply it to the initial HTML to avoid a flash on page loads.

## Typography

Use locally bundled Geist Sans for the interface and Geist Mono for code,
source paths and identifiers. These typefaces follow the user's preference.
UI copy is 14px/1.5, secondary metadata 12px/1.5, section headings
18px/1.32, and page titles 26px/1.2 (24px on narrow screens). Body copy uses weight
400, navigation and controls 500, and headings 600. Use the reference's tight
tracking on page titles and tabular numbers for counts.

The header wordmark uses locally bundled Nanum Pen Script at its native 400
weight, 30px on desktop and 28px on narrow screens, with natural letter spacing.
The lowercase `n` monogram is outlined from the same font and shared by the
header and favicon through `dashboard/public/mark.svg`. This keeps the logo
independent of font loading while preserving the handwritten glyph exactly.

## Components and layout

All rounded surfaces and controls share the 8px `--ui-radius` token, including
cards, dialogs, inputs, buttons, badges, menus and scrollbars. Flush surfaces
inside a shared container remain square so adjacent edges join cleanly. Cards
use a single black shadow halo. Compact actions use ghost surfaces. Primary actions use a dark
fill in light mode and a white fill in dark mode, without a glow.
Content shares a centered 1200px container. Keep the existing 20px section gaps
and 16–24px card padding appropriate for a working dashboard.

The project topbar scrolls with the page. Workspace navigation stays at the top
once reached, below dialogs and above page content. It remains horizontally
scrollable on small screens through OverlayScrollbars. This sticky behavior and
compact density follow the user's requirements rather than the reference's
landing-page layout.

Preserve keyboard focus, modal scroll locking, reduced motion and readable
wrapping. Long technical disclosures use bounded scroll regions; hiding overflow
must not remove their content.

Inventory uses a compact table beside a category sidebar. Base UI vertical tabs
provide keyboard navigation; a synchronized Base UI Select dropdown replaces
the sidebar on narrow screens. Category counts use Torph only for numbers.
The toolbar groups the category title and filtered count, search by name,
configuration or source file, and a framework filter using the shared Base UI Select. Paginate at 20 declarations;
the footer puts the visible range on the left and Previous / Next on the right.

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

Use a single compact page header with the finding count and scan timestamp.
The full-width table groups severity, a short rule title with subject and rule ID,
source filename/directory, and confidence. The toolbar combines search, severity
filters and a Base UI sort select. Default to highest severity, then score; paginate
at 20 findings. Hover and selected rows use neutral surfaces, with severity colors
restricted to badges. On phones, rows stack source and confidence below the title,
and a Base UI severity select replaces the filter buttons.

Selecting a row opens a 640px Vaul drawer with the full finding title, source code,
numbered evidence trace with expandable code context, risk explanation, review
notes and suggested remediation.
Keep all source observations and reference mappings. Deep links open the matching
finding, Escape dismisses the drawer and returns focus to its row, and the panel
fills the viewport on phones. Use the table-shaped skeleton while loading and Torph
only for numeric counters.

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
