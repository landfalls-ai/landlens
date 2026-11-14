# Design: Iris

The look of Landlens since 14 November 2026, and the reference for any new UI. The tokens and every style live in
`apps/desktop/src/renderer/src/styles.css`; this page says why they are what they are and what to reuse.

## Direction

**Healthy is quiet, trouble is loud.** A near-black instrument panel (or a white one in light mode) where neutral greys
carry everything that is fine. Colour means one of three things:

- state that needs attention: red (`--bad`) and amber (`--warn`);
- the thing you have selected, focus and primary actions: iris (`--accent`);
- Claude: iris too.

Iris never means a state. A 25-row pod table with 23 healthy rows looks calm; the two that are not are findable in
under a second, because they get a pill, an icon and a 3px edge at the table's left.

Status is **never colour alone**: every state has its own icon shape (`CircleCheck` ok, `Clock` pending, `CircleX`
failed, `CircleDashed` unknown, terminating or completed) and a word. The status fills were checked for protan and
deutan in both themes; amber on white is under 3:1 as a fill, which is why the icon and word carry it too.

## Fonts and icons

| Package | Version | Use |
|---|---|---|
| `@fontsource-variable/geist` | 5.3.0 | The UI face (`--font`) |
| `@fontsource-variable/geist-mono` | 5.3.0 | Names, hashes, images, YAML, tool output (`--mono`) |
| `lucide-react` | 1.73.0 | Icons as inline SVG |

All three are devDependencies, bundled by Vite: nothing is fetched at run time, so the CSP's `font-src 'self'` holds.
Fonts are imported once in `main.tsx`.

Icons go through `Ic` in `icons.tsx` (stroke 1.75, `aria-hidden`, `currentColor`): 15px in navigation and buttons,
13px in badges and tool rows, 18px in kind tiles. `kindIcon(resource)` and `iconOfKind(kind)` map each resource to one
icon, so the sidebar, table, drawer, overview and dock agree (Pods `Box`, Deployments `Layers`, Nodes `Server`,
Secrets `KeyRound`, anything else `Shapes`). The brand mark is `Mark.tsx`.

## Tokens

CSS custom properties on `:root`; dark is the default and light follows `prefers-color-scheme: light`. Components
read tokens only: no colours in TSX, no inline style objects for theming.

| Group | Tokens | Notes |
|---|---|---|
| Surfaces | `--bg-0` … `--bg-4` | 0 window, sidebar, dock, code wells; 1 main canvas; 2 raised (drawer, cards, inputs); 3 active and chips; 4 pressed |
| Lines | `--line`, `--line-2` | Raised things use `box-shadow: inset 0 0 0 1px var(--line)`; `border` only between panes |
| Ink | `--ink`, `--ink-2`, `--ink-3`, `--ink-4` | Body, secondary, labels, quietest (zero restarts) |
| Accent | `--accent`, `--accent-fill`, `--accent-soft`, `--accent-line`, `--sel` | Selection, focus, primary buttons, Claude |
| State | `--ok`/`--warn`/`--bad`/`--unk` fills, `-text` variants, `-soft` backgrounds | Text never uses a fill colour |
| Type | `--t-105`, `--t-11`, `--t-115`, `--t-12`, `--t-125`, `--t-13` … `--t-30`, `--w-regular/medium/semibold` | 13/400 body, 11.5/500 sentence-case labels, no uppercase; half steps are tokens too (`--t-105` axis ticks and gutter labels, `--t-115` labels, `--t-125` row names), so `charts.css` and `mcp.css` carry no raw sizes |
| Focus | `--focus`, `--focus-in`, `--focus-gap` | The ring's gap is the surface it sits on: `--bg-1` by default, `--bg-0` in the dock, `--bg-2` in the drawer (each sets `--focus-gap` and redeclares `--focus`) |
| Space, radii | `--s-1` … `--s-6` (4px grid), `--r-1` 4 … `--r-4` 12 | |
| Motion | `--ease`, `--dur-1` 90ms, `--dur-2` 160ms, `--dur-3` 240ms | Off (except opacity) under `prefers-reduced-motion` |
| Layout | `--sidebar-w` 232, `--rail-w` 52, `--drawer-w` 420, `--dock-w` 392, `--toolbar-h` 48, `--row-h` 32, `--statusbar-h` 26 | |
| Code | `--code-key`, `--code-str`, `--code-num`, `--code-punct` | YAML and tool wells |

Numbers that line up (ready, restarts, age, counts) use `tabular-nums`.

## Layout

```
┌ sidebar 232 ┬ main ─────────────────────┬ drawer 420 ┬ dock 392 ┐
│ cluster     │ toolbar 48                │            │          │
│ jump        ├───────────────────────────┤            │          │
│ nav         │ overview or table         │            │          │
│             ├───────────────────────────┤            │          │
│             │ status bar 26             │            │          │
└─────────────┴───────────────────────────┴────────────┴──────────┘
```

`.app` is a grid, `var(--sidebar-w) minmax(0,1fr) auto auto`. `Workspace.tsx` sets classes on it from a
`ResizeObserver` and what is open, so **the table keeps at least ~600px**:

| State | ≥ 1280 wide | 1024–1279 |
|---|---|---|
| drawer | sidebar, drawer 420 | sidebar, drawer 380 |
| dock | sidebar, dock 392 | rail 52, dock 360 |
| drawer + dock | rail, drawer 372, dock 392 | rail, dock 360, drawer 372 floating over the table |

⌘B folds the sidebar to the rail by hand. The main pane is a container (`container-name: main`), so the toolbar and
table shrink by the pane's width, not the window's: under 860px the key hints go and the filter says "Filter"; under
760 the status words; under 640 "Ask Claude" becomes its icon (and always while a drawer is open, which has its own
worded Ask Claude); columns drop in order Node, Ready, Age, Namespace, Restarts (Namespace also whenever one namespace
is selected). When the drawer floats over the table (1024–1279 with the dock), the columns are chosen for the strip
that still shows, and Status becomes a 16px icon-only column at the left (a dot when healthy, the tone's icon
otherwise, the word in its title and for screen readers), so which rows are in trouble stays visible.

**Title bar.** On macOS the window is `hiddenInset` with the traffic lights at 16,16; the sidebar's top 44px, the
toolbar, `.drawer-top`, `.dock-head` and `.welcome-bar` are drag regions, and their controls are `no-drag`. Preload
writes `data-platform` on `<html>` (data only), and the CSS keys the inset on `[data-platform="darwin"]`; Windows and
Linux keep the native frame. The window's background follows the theme so it doesn't flash.

## Screens

- **Welcome** (`Welcome.tsx`): a centred column with the mark, "Pick a cluster", the contexts as rows (two-letter
  tile hashed over six gradients, `current` pill, server in mono), the current context first and focused; ↑/↓, Enter
  and number keys. Connecting dims the others; an error rings the row and offers "Try again".
- **Overview** (`Overview.tsx`, the landing page): a verdict sentence ("2 problems need attention", "Nothing is
  broken; n things to watch", "All clear") with "Ask Claude what's wrong"; tiles for nodes, pods (a segmented bar),
  deployments and restarts, which open those lists; Problems worst first and Recent warnings; Nodes. It reads
  `cluster:health` every 10s through `useHealth`, which also feeds the sidebar badges and the status bar counts. Below
  the problems, **Usage** (CPU and memory against allocatable, top namespaces, a 1h/6h/24h switch), and a CPU and
  memory sparkline on each node row ([metrics.md](metrics.md)).
- **Lists** (`ResourceTable.tsx`, columns in `kinds.ts`): 32px inset rows; healthy status is a quiet dot and word,
  failing and pending are pills with a left edge; generated name suffixes dimmed (`splitName` in `present.ts`);
  restarts toned at 5 and 10; sortable headers; ↑/↓ or j/k; a row flashes when its status changes. The toolbar's
  `.seg` filters pods by status.
- **Drawer** (`Details.tsx`): kind tile, eyebrow, Ask Claude, copy, close; title with the hash dimmed; status and
  facts. Tabs Overview, Events, YAML and, for pods and workloads, Metrics (`[` and `]`), then Logs disabled until wave 4. A failing pod leads
  with a **Diagnosis** card (why, retry, exit code, reason, how long it ran, and the termination message when the
  container left one); then facts whose Owner and Node navigate, containers, a conditions checklist, labels as
  chips. YAML (`Yaml.tsx`) is a numbered, coloured well whose `textContent` is still the exact YAML.
- **Dock** (`AgentDock.tsx`, `DockParts.tsx`): the darkest surface, so the cluster reads as the lit centre. Header
  with the read-only lock; consecutive tool calls in one list with icon status and numbered output (failure lines
  marked only in log output: `get_logs` and `kubectl logs`); the ask card is the one thing with an iris ring and
  halo; the composer's focus is a 1px `--accent-line` ring, no halo; the composer holds the context chips, the Mode and
  Model pills, the state, and Send or Stop. Between sending and the first thing back, a "Thinking…" row with two
  `.skel` lines. The body reserves its scrollbar gutter (`scrollbar-gutter: stable`) and its right padding plus the
  gutter equals the composer's inset, so cards and composer share one right edge; the user's bubble uses the cards'
  10px padding.
- **Views in the dock**: only the newest view stays open; earlier ones fold to their tool row plus a one-line verdict
  (the tool's first line of text, ellipsised, with "Show view"; a heading ending in ":" takes its first item), and
  reopen on a click ("Hide view" folds them back). A view shows at most 320px; past that a fade to `--bg-2` with
  **Show all**. The frame is `overflow: clip`, so scrolling something inside into view can't shift the clipped view. The point is that a few tool calls never
  push Claude's answer out of the dock.
- **Jump to** (`JumpPalette.tsx`, ⌘K): kinds, and objects in the list already loaded.
- **MCP** (`McpPage.tsx`, `mcp.css`; sidebar under Overview, `Plug`): `.tabs` Servers and Calls; "Add server" sits
  at the intro's right edge. A server is a `.panel` (kind tile, mono name, status `.badge`, a `.switch` "On for
  <context>", Test, edit and remove icon buttons; for an added server a second switch, "Run read-only tools without
  asking") with its tools as rows on one grid (`minmax(0,1fr) 62px 96px 112px`: name and a one-line description
  that expands on click, the `view` chip, the badge, Preview), so the columns line up; a muted **Read-only** badge
  (quiet: runs without asking) or an amber **Asks first**; where Preview can't run, a disabled button in its place says
  why (Needs arguments, Not read-only, Server off). Calls are `.ov-row`s with a status icon and word, `server · tool`
  and the target as words, the session (and "from a view") in the sub line, a `view` chip, filtered by two selects
  with the toolbar's chevron and a `.seg`; a row opens the call in the `.drawer`, where the session id is
  middle-truncated with a copy button and a JSON result is indented. The add-server dialog reuses `.dialog`,
  `.form-row`, `.test-steps`.
- **MCP App views** (`AppFrame.tsx`): a `.app-frame` on `--bg-2` under the tool's card in the dock, in Preview and in
  the call drawer. A view from a server you added (not `landlens-kube`) sits in `.app-third`: a `--line-2` ring, 8px
  inset, and "View from <server>" above, drawn by the page outside the frame, so it never reads as Landlens's own.
  Keys typed in a view: Escape and the app's ⌘/Ctrl chords come back to the page and are replayed on the frame, so
  ⌘J or Esc work with focus inside. Past 640px a view's body scrolls. Landlens's own views: health problem rows lead
  with the object's name (namespace with the detail), stats auto-fit (`minmax(84px, 1fr)`), the object card uses the
  drawer's ✓/✗ conditions checklist and one owner per line, and the log view says **Logs couldn't be read** in the
  bad tone when the kubelet answered with a reason, not a log. Views style themselves with the MCP Apps standard variables, which the host fills from these
  tokens (`irisVariables` in `app-host.ts`: backgrounds from `--bg-*`, text from `--ink-*`, borders from `--line*`,
  state from `-soft` and `-text`, rings from `--accent`), and resend on a theme change. Landlens's own views follow
  Iris: kind tile, eyebrow, title, pills with icon and word, inset rows, the viz palette for charts.

## Components

Reuse these classes before writing new ones: `button.primary`, `.secondary`, `.ask-btn`, `.icon-btn`, `.link-btn`;
`label.field` (`.select` wraps a native `<select>`, `.search`); `.badge.ok|warn|bad|muted`; `.count-badge`; `.pill`;
`.chip` (key `i`, value); `.kind-tile` (`sm`, `lg`, tinted by tone); `.notice`; `.skel` (shimmer); `.empty`;
`.spinner`; `kbd` (always `aria-hidden`); `.panel`. Focus is `:focus-visible { box-shadow: var(--focus) }`
everywhere, inset inside rows and tabs.

## Charts

The rules come from the dataviz method; the code is `apps/desktop/src/renderer/src/charts/` and `charts.css`.

- **Palette**: four categorical slots as tokens, `--viz-1` … `--viz-4`, plus `--viz-other`, `--viz-grid` and
  `--viz-axis`, dark and light. Slot 1 is the Iris accent (`#7D71F5` dark, the accent's hover step, because `#9A90FF` is
  too light for the dark band; `#5546DB` light), then orange, blue and aqua. The order passed the validator against
  `--bg-2` in both themes (worst adjacent CVD ΔE 19.6 dark, 23.1 light). Light aqua sits under 3:1 on white, so every
  chart has a legend with values and a table view. Components set a slot class (`s1` … `s4`, `so`), never a colour.
- **Status colours never appear in a chart**; colour in a chart is identity (which container, node or pod), not state.
- **Marks**: 2px lines with round joins; bands at a 14% wash with their 2px edge; hairline solid grid; reference
  lines in ink, request dashed and limit or allocatable solid; the crosshair's dots have a 2px surface ring.
- **Reference labels live in a right gutter**, never on the data: a fixed 96px gutter whenever the chart has a
  reference (so CPU and memory stacked in one column share an x axis), each label at its line's height (`x = left +
  plot width + 6`, start-anchored, baseline +3.5), pushed apart when two are closer than 12px (`spread` in
  `scale.ts`). A reference above a fitted axis is named at the gutter's top with "↑".
- **One unit per chart** (`chartUnit`, `formatIn`): picked from the axis's top and used by the ticks, the head, the
  readout, the legend, the gutter labels and the table.
- **Domains**: the Overview's usage charts fit the axis to the data ×1.25 when the data stays under half the largest
  reference; otherwise the axis covers the references. When samples cover under half the range, the time axis starts
  at the first sample. Ranked bars are 8px, one hue, square at the baseline and rounded at the tip, the value beside it.
- **Forms**: stacked bands when the parts sum to something you compare with a line (a pod's containers against its
  limit, a cluster's nodes against allocatable); a line per pod for a workload; ranked bars for namespaces; a
  sparkline (quiet ink, the latest point in the accent) on node rows. Past four series the rest fold into "other".
- **Interaction**: one range switch (`.seg.range`) above what it scopes; a crosshair snapping to the nearest sample,
  by pointer or keyboard; a Table toggle. On a wide card (the Overview) the readout floats beside the crosshair and
  lists the series and the total, never the reference lines (the gutter has them). In a narrow column (the drawer)
  nothing floats over the plot: the head shows the crosshair's time and value and the legend's values follow it.
  A refetch keeps the frame at reduced opacity.
- **Sentences, not blanks**: a chart that can't draw says which source is missing, why, and offers the fix
  ("Connect Clickland").

## Keyboard

⌘K jump, ⌘J dock, ⌘B sidebar, ⌘1 Overview, ⌘2 Pods, `/` filter, ↑/↓ or j/k rows, Enter open, Esc closes the drawer
(never the dock), `[` `]` drawer tabs; in the dock, Enter and Esc answer the newest ask when the composer is empty.
These work with focus inside an MCP App view too: the view hands Escape and ⌘/Ctrl with K, J, B or a digit back to
the page.

## What the tests rely on

The e2e test finds things by role and name, so keep: heading "Pick a cluster"; buttons "Pods", "Deployments",
"Secrets", "Ask Claude", "Stop", "Send"; combobox "Namespace"; tabs "Overview", "YAML"; textbox "Message Claude
Code"; landmark "Claude Code"; classes `.tr`, `.drawer`, `.yaml`, `.ctx-chip`, `.tool`, `.tool summary`,
`.tool-failed`, `.msg-agent`, `.ask button.primary`, `.dock`. Graphs: regions "Usage" and "Nodes", status "Metrics
unavailable", button "Connect Clickland", dialog "Connect Clickland" with fields "Clickland address" and "Clickland
API key", buttons "Test" and "Save", list "Test result", tab "Metrics"; classes `.metrics-src`, `.mtab`,
`.chart-plot`, `.chart-tip` (Overview only), `.chart-now`, `.chart-legend`, `path.edge`, `path.line`, `.test-steps`. MCP: button "MCP"; tabs
"Servers" and "Calls"; regions "MCP server <name>"; lists "<name> tools" and "MCP calls"; buttons "Add server",
"Preview <tool>", "Test", "Save"; dialog "Add an MCP server" with fields "Server name", "Server address", "Header
name", "Header value"; a `switch`; complementary "MCP call" with list "Front-door requests"; classes `.mcp-tool`,
`.mcp-call`, `.tool-app`, `.app-frame`, `.tool-with-app.folded`, `.tool-verdict`; switch "Use clickland on
<context>". Badges and key hints inside buttons are `aria-hidden`,
so they don't change a button's name; Overview tiles are links named "Open …", and its rows are `.ov-row`, not `.tr`.

`LANDLENS_SHOTS=<folder>` saves screenshots of every screen in dark, light and at 1024×700 ([development.md](development.md)).
