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
| Layout | `--sidebar-w` 232, `--rail-w` 52, `--drawer-w` 420, `--dock-w` 392, `--toolbar-h` 48, `--row-h` 32, `--statusbar-h` 26, `--bench-h` 300 (240 under 760 tall), `--bench-min` 160, `--bench-head-h` 34 | |
| Terminal | `--term-bg`, `--term-fg`, `--term-cursor`, `--term-sel`, eight `--term-<colour>`, `--find`, `--find-cur` | xterm's theme and log ANSI colours, dark and light (`workbench.css`) |
| Code | `--code-key`, `--code-str`, `--code-num`, `--code-punct` | YAML and tool wells |

Numbers that line up (ready, restarts, age, counts) use `tabular-nums`.

## Layout

```
┌ sidebar 232 ┬ main ─────────────────────┬ drawer 420 ┬ dock 392 ┐
│ cluster     │ toolbar 48                │            │          │
│ jump        ├───────────────────────────┤            │          │
│ nav         │ overview or table         │            │          │
│             ├───────────────────────────┴────────────┤          │
│             │ the panel (wave 4), 300, when open      │          │
│             ├────────────────────────────────────────┤          │
│             │ status bar 26                           │          │
└─────────────┴────────────────────────────────────────┴──────────┘
```

`.app` is a grid, `var(--sidebar-w) minmax(0,1fr) auto auto`, with rows `minmax(0,1fr) auto auto`: the sidebar and
the dock span all three; the main pane and the drawer sit in the first; the panel ([workbench.md](workbench.md))
and the status bar span the main pane and the drawer below them. At 1024–1279 with the dock and a drawer, the
floating drawer ends at the panel's top. `Workspace.tsx` sets classes on it from a
`ResizeObserver` and what is open, so **the table keeps at least ~600px**:

| State | ≥ 1280 wide | 1024–1279 |
|---|---|---|
| drawer | sidebar, drawer 420 | sidebar, drawer 380 |
| dock | sidebar, dock 392 | rail 52, dock 360 |
| drawer + dock | rail, drawer 372, dock 392 | rail, dock 360, drawer 372 floating over the table |

The dock's widths above are defaults. Its left edge is a grip (`DockGrip.tsx`, `dockWidth.ts`): drag it, or focus it
and use ← → (16px a step), Home for the narrowest (320) and End for the widest; a double click goes back to the
default. The widest leaves the rail and 600px of table, and beside a drawer in a wide window the drawer's 372 too (at
most 960). The width you chose is kept in `localStorage` (`landlens.dock.width`) and held to that room as the window
or the panes change; the floating drawer at 1024–1279 sits beside whatever width the dock has.

⌘B folds the sidebar to the rail by hand. The main pane is a container (`container-name: main`), so the toolbar and
table shrink by the pane's width, not the window's: under 860px the key hints go and the filter says "Filter"; under
760 the status words; under 640 "Ask Claude" becomes its icon (and always while a drawer is open, which has its own
worded Ask Claude); columns drop in order Node, Ready, Age, Namespace, Restarts (Namespace also whenever one namespace
is selected). When the drawer floats over the table (1024–1279 with the dock), the columns are chosen for the strip
that still shows, and Status becomes a 16px icon-only column at the left (a dot when healthy, the tone's icon
otherwise, the word in its title and for screen readers), so which rows are in trouble stays visible.

**The sidebar's sections** (`Sidebar.tsx`, `navState.ts`, D139). Overview and Problems are always the top two rows;
below them every labelled block folds: **Workspace** (Connections, MCP, Agent), **Pinned**, **Cloud**, the kind
sections (Workloads, Network, Config, Storage, Access, Cluster), each extra API group, and **Custom resources**
(whose API-group sub-headings fold too). A header is a `button.nav-sec` with `aria-expanded` and `aria-controls` (its
rows), the 11px `--ink-3` label and a chevron on the right that turns −90° with `--dur-2` when folded; rows that
appear fade in over 120ms (off under `prefers-reduced-motion`). Workspace, Pinned, Cloud and the six kind sections
start open, the API groups and Custom resources folded, as before. What you choose is kept in `localStorage`:
`landlens.nav.v1` (`{ closed, opened }`, every cluster, so it survives a reload and a cluster switch) and
`landlens.nav.groups.<context>` for Custom resources' API groups (they differ by cluster); both choices are recorded
so a default can change later without overriding you, and a value that doesn't read is treated as no choices.
**The page you are on never hides:** under a folded header its row stays, alone, without unfolding it (opened from
⌘K, a link, a pin or a problem). **A folded header carries a roll-up badge** before its chevron (`.nav-sec
.nav-badge`, 15px): the problems about its rows' kinds, each counted once (a Deployment's crash loop marks Deployments
and Pods but is one problem), red if any is failing, else amber, in words in the title and for screen readers ("3
problems"). Open headers show none, since their rows carry them. ⌥-click (Alt on Windows and Linux) on any header
folds or unfolds every section; on an API group, every API group. In the rail the folds are ignored and left alone:
Overview, Problems, the Workspace pages, pins and Google Cloud keep their icons (a 1px `.nav-rule` between blocks),
and each kind section is **one icon** (its first kind's: Workloads `Box`, Network, Config, Storage, Access, Cluster;
an API group `Shapes`) carrying the roll-up dot and the active ring, opening the `.nav-flyout` that Custom resources
has had since D38. The sidebar's width stays 232.

**Title bar.** On macOS the window is `hiddenInset` with the traffic lights at 16,16; the sidebar's top 44px, the
toolbar, `.drawer-top`, `.dock-head` and `.welcome-bar` are drag regions, and their controls are `no-drag`. Preload
writes `data-platform` on `<html>` (data only), and the CSS keys the inset on `[data-platform="darwin"]`; Windows and
Linux keep the native frame. The window's background follows the theme so it doesn't flash.

## Screens

- **Welcome** (`Welcome.tsx`): a centred column with the mark, "Pick a cluster", the contexts as rows (two-letter
  tile hashed over six gradients, `current` pill, server in mono), the current context first and focused; ↑/↓, Enter
  and number keys. Connecting dims the others; an error rings the row and offers "Try again". GKE clusters of the
  chosen Google Cloud projects follow your own contexts under a `.cards-label` heading (**Google Cloud** with the
  `Cloud` icon and "GKE clusters of the projects you chose" in `--ink-3`): the row's tile is the blue `.cl-tile.gke`
  with the `Cloud` icon, the short name with a **GKE** pill, and "project · location" in mono where the server would
  be; the footer counts "N contexts in your kubeconfig · M GKE"; a project that couldn't be listed is one small dim
  line under the cards. The first connect to a GKE cluster opens an `alertdialog` (`.dialog`, 420px): a `kind-tile`
  with `Cloud` and "Connect <short name>?", the cloud sentence, then the project and location in a small dim line;
  **Cancel** (focused) and **Connect** (primary). The sidebar's switcher menu groups **Clusters in your kubeconfig** and
  **Google Cloud** (the GKE tile, short name, " · project" dim); a connected GKE cluster shows its short name and the
  GKE tile in the switcher, its full context in the tooltip.
- **Overview** (`Overview.tsx`, the landing page): a verdict sentence ("2 problems need attention", "Nothing is
  broken; n things to watch", "All clear") with "Ask Claude what's wrong"; tiles for nodes, pods (a segmented bar),
  deployments and restarts, which open those lists; the worst five problems (a row opens it on the Problems page; See
all N) and Recent warnings; Nodes. It reads
  `cluster:health` every 10s through `useHealth`, which also feeds the sidebar badges and the status bar counts. Below
  the problems, **Usage** (CPU and memory against allocatable, top namespaces, a 1h/6h/24h switch), and a CPU and
  memory sparkline on each node row ([metrics.md](metrics.md)). Usage and the drawer's Metrics tab name their source
  in a `.metrics-src` line; from wave 9 part 2 a GKE cluster's reads "Cloud Monitoring shop-prod" with the `Cloud`
  icon (12 px) and the tooltip "Cloud Monitoring, GKE system metrics of shop-prod in demo-shop (us-central1), 60s
  steps". A Cloud Monitoring reason adds a `.link-btn` **Open Google Cloud** (an unchosen project) or **Copy command**
  (an API to turn on) beside the live line and under the no-metrics notice, whose reasons show a backticked command
  as code.
- **Google suggests** (wave 9 part 1; `GoogleSuggests.tsx`, `googleRules.ts`, `googleView.ts`, `.gs-*` in `gcp.css`;
  [gcp.md](gcp.md#googles-view-of-a-cluster)): on a GKE cluster of a chosen project, a `.panel` right after the
  Problems and Recent warnings columns, full width (so one column at 1024×700). Head: the `Cloud` icon (15 px, accent),
  "Google suggests", a `.count-badge`, "GKE · demo-shop · us-central1" in `--ink-3`, and a refresh `.icon-btn`
  (a spinner while reading). Rows are `.ov-row.gs-row` (`role="button"`, `aria-expanded`): a `.badge` with icon and
  word, never colour alone (`.bad` + `CircleX` for Critical and High, `.warn` + `Clock` for Medium, `.muted` +
  `CircleDashed` for Low and Unknown; at least 84 px so the descriptions line up), Google's sentence clamped to two
  lines, the meta line in `--ink-3` ("Deprecation · reliability · refreshed 2 days ago"), and a chevron. Enter, Space
  or a click opens the row in place (`.gs-detail`, a `--bg-1` well indented under the sentence): "What Google
  recommends", the APIs as a small fixed table (`.gs-apis`; the API and user agent in mono, breaking anywhere), and
  the source line. Empty: `.ov-empty` "Google has no suggestions for this cluster.", only when Google's whole list was
  read; when it was cut, a `.gs-cut` note (`role="note"`, `CircleAlert` in `.tone-warn`) says what was read, alone or
  under the rows, and the count reads "3+"; a failure: a `.notice` with the
  sentence, its command as `code`, and **Copy command**. On a GKE-looking cluster of an unchosen project, one quiet
  `.gs-hint` line (`role="note"`) under Nodes with a **Open Google Cloud** `.link-btn`. No Ask yet (wave 9 part 3).
- **Problems** (`Problems.tsx`, `problemRules.ts`; CSS `.pb-*` in `workbench.css`; [doctor.md](doctor.md#the-problems-page)):
  a `.seg` for severity and `.chip` buttons per kind of problem (the chosen one in accent), the skipped-checks
  `.notice`, then "Failing" and "To watch" sections of `.ov-row`s: tone-tinted kind tile, title in medium weight, the
  kind as `.ov-kind`, namespace dimmed, the detail in mono, age at the right; Ask and Open as `.ghost-btn`s on hover,
  focus or selection; the selected row has the accent wash and a 2px left edge. The drawer is the `.drawer` shell of
  Helm's: a stethoscope tile, the reason as a `.badge`, "Open <Kind>" as a small `.secondary`, the hint in a `--bg-2`
  card above the facts, and the Logs tab's `.logs-pane` with a `.logs-note` head.
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
- **Autonomous mode in the dock** (`DockParts.tsx`, `agent.css`; [connections.md](connections.md#autonomous-mode)).
  The one place the dock uses amber as a state: autonomous is a standing permission, so it reads as a warning, never
  as the iris accent. A row of `.auto-pill`s above the composer's foot, one per connection (`GitHub · asks`, 24px, a
  `--line` ring like the pill selects; `GitHub · autonomous 3/20` on `--warn-soft` in `--warn-text` with a `Zap`;
  `Linear · read only` as quiet text, hidden when the window is narrow). A pill opens the scope sheet, a popover
  above the composer built like the slash menu (`--bg-2`, `--shadow-2`, 10px radius): the provider's mark in a 22px
  tile, "GitHub writes in this session", the level sentence, the scope `.field`s in mono, the D83 sentence in an
  amber well, then **Turn on** (filled `--warn`, dark ink; the one amber button) and Cancel; when on, the scope, the
  count and Stop. Under the dock's head, while any connection is autonomous, a full-width strip on `--warn-soft` with a
  hairline under it: `Zap`, "**Autonomous:** GitHub writes to … run without asking." with the count dimmed, and a
  small secondary **Stop**; no close button. A tool row that ran on its own has an `.auto-chip` (18px, amber,
  `Zap` and "ran on its own") after its label; the transcript notes why autonomous stopped in `--warn-text`.
- **A GitHub or Linear question** is the ask card with the provider's mark in a 22px tile, "GitHub · issue write?",
  "Asked because: …" in `--warn-text` with a `CircleAlert` when autonomous said no, and an `.args-table`: a ringed
  `<dl>` of 92px labels and mono values divided by hairlines (Repository, Team, Issue, Pull request, Method, Branch,
  From, Into, Title, File, Files with up to 20 paths, then every other argument, nested ones as JSON), the Body in
  the sans face, pre-wrapped, its first 600 characters and "(+N more characters)", at most 140px before it scrolls.
  Under it, **Show all arguments** (`.args-all`, a `<details>`) opens every argument as indented mono JSON in a ringed
  `--bg-1` well, at most 260px before it scrolls. The answers are Claude Code's own, with ↵ and esc hints, without
  **Always allow** for these writes. The warn strip stays under the head while History is open.
- **Views in the dock**: only the newest view stays open; earlier ones fold to their tool row plus a one-line verdict
  (the tool's first line of text, ellipsised, with "Show view"; a heading ending in ":" takes its first item), and
  reopen on a click ("Hide view" folds them back). A view shows at most 320px; past that a fade to `--bg-2` with
  **Show all**. The frame is `overflow: clip`, so scrolling something inside into view can't shift the clipped view. The point is that a few tool calls never
  push Claude's answer out of the dock.
- **Jump to** (`JumpPalette.tsx`, ⌘K): actions, problems (tone icon, title, kind and namespace), objects, kinds and
  clusters ([workbench.md](workbench.md#k-search)).
- **MCP** (`McpPage.tsx`, `mcp.css`; the sidebar's Workspace group, `Plug`): `.tabs` Servers and Calls; "Add server" sits
  at the intro's right edge. A server is a `.panel` (kind tile, mono name, status `.badge`, a `.switch` "On for
  <context>", Test, edit and remove icon buttons; for an added server a second switch, "Run read-only tools without
  asking") with its tools as rows on one grid (`minmax(0,1fr) 62px 96px 112px`: name and a one-line description
  that expands on click, the `view` chip, the badge, Preview), so the columns line up; a muted **Read-only** badge
  (quiet: runs without asking) or an amber **Asks first**; where Preview can't run, a disabled button in its place says
  why (Needs arguments, Not read-only, Server off). Calls are `.ov-row`s with a status icon and word, `server · tool`
  and the target as words, the session (and "from a view") in the sub line, a `view` chip, filtered by two selects
  with the toolbar's chevron and a `.seg` (All, OK, Failed, Refused, Autonomous); a call that ran on its own has the amber `.auto-chip`; a row
  opens the call in the `.drawer` (with **Allowed by**: a read, you, the autonomous mode, or a preview), where the session id is
  middle-truncated with a copy button and a JSON result is indented. The add-server dialog reuses `.dialog`,
  `.form-row`, `.test-steps`.
- **Connections** (`ConnectionsPage.tsx`, `connections.css`; the sidebar's Workspace group, above MCP, `Cable`; also "Connections" under
  Welcome's list, where the page stands alone with a **Clusters** button back): one column of `.panel` cards, at most
  820px. A card's head is the provider's own mark (drawn in ink, in a `.kind-tile`), the name, a state `.badge` with
  its icon (Connected ok, Not connected muted, Connecting… with a spinner, Sign-in ran out warn, Failed bad) and one
  action at the right (Connect primary, Disconnect or Cancel secondary). The device code sits in an accent-ringed
  well on `--bg-1`, the code at `--t-26` in mono with spaced letters, then Copy and **Open github.com/login/device**; a
  pasted token is one password `.field` in a quiet well, its shape checked as you type, with the advice and **Make
  one** under it. Connected, the body is rows on one grid (a 210px label column, the control, its sentence), divided
  by hairlines: **Level** as a `.seg` (Read only · Ask for writes), then the `.switch`es "Reads run without asking" and
  "Give to Claude sessions"; then the tool count as a link that opens the tools (`.mcp-tool` rows with the name, a
  one-line description that expands, and **Read-only** or the amber **Asks first**, reads first; a routine write
  also has a muted **Routine** badge with a `Zap`; the badges sit right-aligned) and **Check tools**.
  A note that needs you is amber with its icon and **Review tools**; a card whose tools changed gets an amber ring.
  On the MCP page a connection's panel carries its mark, a **From Connections** chip and **Manage in Connections**.
- **Land family** (wave 7, `FamilyCards.tsx`, `.fam*` in `connections.css`): a section under Google Cloud with its
  heading and one line of intro, then a `.panel` card each for Clickland, Landflow and Landfall. Each card has the
  sibling's own mark from `icons.tsx` (`SiblingMark`: Clickland's histogram tile, Landflow's nodes and flow,
  Landfall's beacon, filled in ink in a `.kind-tile`), the name, and a state `.badge` (Ready ok, Off muted, Signing
  in… with a spinner, Sign-in ran out warn, Failed bad). Then come the address in mono (only when connected), who
  you are (`Signed in as …`, the role and how, muted, then the scopes as mono `.chip`s) and a note (a fixed sentence,
  amber, or red when the card is Off or Failed). The uses are `.fam-row`s on hairlines: a label column, a sentence,
  and a dot with its state word at the right on the same line ("In use", "Can record", "Can list and run", "Secret
  stored", "Through Landflow"; muted "Not in use", "No scope", "Not set up"). Under 640px of the main pane the sentence drops under
  the label. The forms are the wave 6 wells: a mono `.field` for the address, a password field for the key, its
  shape checked as you type, the help in `small`. The triage webhook's form sits inside the Landflow card (path,
  header name, secret; Remove, Cancel, Save). **Check** lists its steps as `.test-steps`.
- **Google Cloud** (`GcpPage.tsx`, `gcp.css`; the sidebar's **Cloud** section after Pinned, `Cloud`; also under
  Welcome's list, standing alone with a **Clusters** button back): three columns in the main pane. **Projects**
  (240px, `--bg-0`): two-line items (name, then the id in mono), a filter, **Choose projects…** in the foot. **Types**
  (260px, `--bg-1`): **All**, then the types under service headers (the service's icon, its name, its host in mono at
  the right, one line, ellipsis), each type an item with its count in tabular mono; the picked item is `--bg-3` with
  a hairline ring and an accent icon. **Resources**: the list table (`ResourceTable`; name, type, location, state as a
  tone pill, created), a 280px filter, a query chip, the count right-aligned. Under 1,100px of main the projects
  become a select atop the types; under 720px the types become a select (optgroups by service) in the resources
  header, and the table takes the pane. A project's error sits in the Types column as a bad-tinted box with the
  sentence. The drawer is the usual `.drawer`: a service tile, "Google Cloud / <project>" (ellipsised first), then
  **Open in Landlens** (secondary, on a GKE cluster the catalog lists), **Copy name** (an icon button), **Ask Claude**
  (primary, `Sparkles`; disabled while the brief is read; without a cluster a disabled "Connect a cluster to ask
  Claude") and close; the name, a type chip, location and state; tabs **Summary** (the drawer's key/value grid; labels as `key= value` chips) and
  **JSON** (the YAML editor's well, read-only, filling the body). States are one `.notice` each with its next step.
  The chooser is a `.dialog` with a filter and a checklist (checkbox, name, id in mono). On Connections, a **Google
  Cloud** card after the providers: the state, account, chosen projects as mono chips, **Choose projects…** and
  **Open Google Cloud**, then a `.conn-row` with the switch **Claude can read these projects** and a dim sentence that
  says what on and off mean (on asks in a native dialog first; an error is a `tone-bad` line). On the MCP page,
  `landlens-gcp` follows `landlens-kube` while it is on: the `Cloud` tile, **Built in**, **From Connections**, and
  **Manage in Connections** in place of Test, Edit and Remove.
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

- **Your actions** (wave 8, `ObjectMenu.tsx`, `ActionSheet.tsx`, `ReviewCard.tsx`, `RecentActions.tsx`). The object
  menu is a 240px `.menu.object-menu` on `--bg-2` with an inset `--line` ring, kept inside the window: sections Open,
  Actions, Ask Claude and Copy name, then **Delete…** in `--bad-text` with `⌫`; an item your role can't use is
  disabled with a second `--ink-3` line ("Your role can't patch deployments in landlens-dev"). The drawer's head has a
  **⋯** (`Ellipsis`, "More actions") after Copy name. The action sheet is a 720px `.dialog.action-sheet` over the
  main pane, the `Zap` icon and "Scale hands-web" in its head. Scale's form is a `.stepper` (− field +, 96px mono
  field); while main reads, three `.skel` bars and "Checking with the cluster…". The review is `ReviewCard` with
  `eyebrow` "Your action" (no iris ring, as an edit), main's title, risk tags, then `.change-facts`: one line per
  fact with `Info` in `--ink-3`, `TriangleAlert` in `--warn-text`, `CircleX` and the text in `--bad-text`, the first
  word medium. A review main will ask about in its own dialog has a danger button "Delete 12…" instead of the card's
  second click. The result is one line per object (`CircleCheck` ok, `TriangleAlert` conflict, `CircleX` failed) and
  **Done**, with **Review again** on a conflict. Recent actions is the status bar's `History` item with the count
  since start, opening a 420px `.pop.recent-actions` above it: a row is the action's icon, its sentence, its age in
  mono and the outcome word in its tone.
- **Nodes** (wave 8 part 2, `DrainPlanView.tsx`). A Node's menu has **Cordon** (`CircleSlash`) or **Uncordon**
  (`CircleCheck`), then **Drain…** (`LogOut`). Cordon's sheet is the action card; a preview-only card (D153) shows
  `Info` and "Development build: preview only. Nothing is sent to nodes on this cluster." in `--ink-2` where "Dry run
  passed" would be, with Apply disabled. The drain sheet (`.drain-sheet`, the same 720px dialog, `LogOut` in its
  head): three `.badge` counts with icon and word (`LogOut` to evict, `CircleSlash` blocked in bad when not zero,
  `Pause` stay), the two ticks (`.drain-ticks`), the preview-only, partial and disagreement notes, then one column
  of `.drain-row` cards (`--bg-1`, inset `--line`): the pod in mono, its namespace in `--ink-3`, the owner as a
  `.link-btn`, `.chip`s, and for a blocked row a `--bad-soft` card with a 3px `--bad` inset edge and its unblock
  sentence in `--bad-text`. Groups: *Blocked*, *Will be evicted*, *Stay* (a fold with a chevron). A re-review dims
  the list (`.drain-stale`) rather than blanking it. The foot: **Ask Claude** (link), Cancel, and the danger
  **Drain…**; during the run each row's state on its right (`Clock` waiting, a spinning `LoaderCircle` evicting,
  `CircleCheck` gone in ok, `CircleSlash` blocked and `CircleX` failed in bad), the elapsed time in mono in the
  head, **Stop**; at the end the summary, **Uncordon…** and **Done**.

### Tables (wave 8 part 3)

The checkbox column is 28 px, `.tick` (a 14 px rounded square, the accent when on, a dash when some); a checked row
is `.tr.checked` (the accent at 8%, a 2 px accent edge when focused). The selection bar replaces the toolbar's right
side: a count chip with a check, small secondary buttons (Delete in the bad colour), the ask button and a close
icon; below 720 px of pane the buttons are their icons. The namespace button is a field with a folder icon and the
label; its popover (260 px) and the column menu (220 px) are `.table-pop` menus under their button, rows `.pop-row`
with a `.tick`, **Only** shown on hover, a foot line when several are chosen. The object menu's Ask Claude opens a
submenu (`.ask-sub`, left of the menu when there is no room right) with a paperclip "Attach to a question", a rule,
then the presets with the sparkle; the drawer's Ask is a split button (`.ask-split`) with a caret. The Overview under
several namespaces shows a chip with the layers icon. A bulk card folds operations past three (`.change-folded`) and
lists what was left out (`.left-out`).

### Secrets (wave 8 part 4)

A Secret's Data section lists keys as rows (`.secret-keys`, `.secret-row`): the key in mono, its size dim, then
small `.secondary` **Copy** and **Reveal** buttons. The unlock chip (`.lock-chip`, warn tone, an open padlock, the
countdown in mono, a "Lock now" link) sits in the section's head. A revealed value is a `pre.secret-value`
(`data-private`, mono, at most 8 lines then it scrolls, `user-select: none`) with a 2 px warn-coloured countdown
line under it and "Hides in N s"; copy's status is a dim line with a padlock ("Copied. Clears in 30 s"). Certificates
are `.cert-card`s under a "Certificates" head: the CN in bold with a shield, the key and "leaf" dim in mono, expiry as
a `.badge` (ok, warn, bad, with a check, clock or cross icon), CA and self-signed as muted badges, then `.facts`
(issuer, names as mono chips folded past 6, valid, key, serial and SHA-256 with an icon copy button); the chain is a
mono line with arrows. Other Secrets show a quiet `.link-btn` "Look for certificates".

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

On a focused row, `x` or Space toggles its checkbox and ⌘A selects every row shown (wave 8 part 3); Esc clears a
selection before it closes the drawer. Shift+click on a checkbox takes a range. In the object menu → opens Ask
Claude's submenu and ← or Esc goes back; in ⌘K, Tab on an `ask <name>` row lists its preset asks.
On a focused row, ⌫ (or Delete) opens the delete review (wave 8); every other action is in the row's menu (Shift+F10)
or ⌘K, so a stray letter can't start a write. In the object menu: ↑/↓, Home/End, a letter jumps by name, Esc. In
Scale's field, ↑/↓ step one and Shift+↑/↓ ten.

⌘K jump, ⌘J dock, ⌘B sidebar, ⌘1 Overview, ⌘2 Pods, ⌘3 Problems, `/` filter, ↑/↓ or j/k rows, Enter open, Esc closes the drawer
(never the dock), `[` `]` drawer tabs; in the dock, Enter and Esc answer the newest ask when the composer is empty.
In the sidebar (D139): ↑/↓ move over the visible rows and headers, Home/End to the ends, → unfolds a header (or steps
into it), ← folds it or goes from a row to its header, ⌥→/⌥← unfold or fold every section, Enter/Space activate; Tab
still walks them in order. ⌘K has **Fold all sections** and **Unfold all sections**.
These work with focus inside an MCP App view too: the view hands Escape and ⌘/Ctrl with K, J, B or a digit back to
the page.

## What the tests rely on

The e2e test finds things by role and name, so keep (wave 8 adds menu "<Kind> <name>" with its menuitems "Scale…",
"Restart", "Delete…"; button "More actions"; dialog with `#action-title`; spinbutton "Replicas"; buttons "Review",
"Done", "Review again", "Recent actions"; region "Review your action"; list "What happened"; dialog "Recent actions"
with `.recent-row`; part 2 adds button "Nodes", menuitems "Cordon", "Uncordon", "Drain…", regions "Blocked", "Will be
evicted", "Stay" with `li[data-pod="<namespace>/<name>"]`, checkboxes "Delete pods that nothing will recreate" and
"Lose emptyDir data", role note with the preview-only sentence, buttons "Drain…", "Stop", "Uncordon…"; part 3 adds
checkboxes "Select <name>" and "Select every row shown", toolbar "Selection" with buttons "Restart", "Delete…", "Ask
Claude", "Clear the selection"; button "Namespaces: <label>" and dialog "Namespaces" with searchbox "Filter
namespaces", checkboxes by namespace and "All namespaces", buttons "Only <ns>"; button "Columns" and menu "Columns"
with menuitemcheckboxes; menu "Ask Claude" (the submenu) and button "Preset asks"; e2e helpers `chooseNamespace` and
`chosenNamespaces` in `test/e2e-helpers.ts`; part 4 adds region "Data" with buttons "Reveal <key>", "Hide <key>", "Copy <key>", "Copy <key> as base64", status "Unlocked for m:ss" with button "Lock now", `pre.secret-value` labelled "Value of <key>", region "Certificates" with `.cert-card`, button "Look for certificates"): heading "Pick a cluster"; buttons "Pods", "Deployments",
"Secrets", "Ask Claude", "Stop", "Send"; tabs "Overview", "YAML"; textbox "Message Claude
Code"; landmark "Claude Code"; classes `.tr`, `.drawer`, `.yaml`, `.ctx-chip`, `.tool`, `.tool summary`,
`.tool-failed`, `.msg-agent`, `.ask button.primary`, `.dock`. Google Cloud: button "Google Cloud" (the sidebar's
complementary "Resources" and Welcome); regions "Projects", "Types", "Resources" and "Google Cloud connection";
dialog "Choose projects" with its checkboxes named by project id and "Save"; searchbox "Filter resources"; buttons
"Read again", "Clear the query", "Copy name", "Open in Landlens"; complementary "Google Cloud resource <name>"; the
GKE heading "Google Cloud" on Welcome and cards named "<short name> GKE …"; alertdialog "Connect <short name>?"; menu
"Clusters" with groups "Clusters in your kubeconfig" and "Google Cloud"; button "<context>, switch cluster"; switch
"Claude can read these projects"; region "MCP server landlens-gcp"; the JSON well
`.gcp-json .cm-content` (label "Resource JSON"); selects "Project" and "Type" when narrow. Graphs: regions "Usage" and "Nodes", status "Metrics
unavailable", button "Connect Clickland", dialog "Connect Clickland" with fields "Clickland address" and "Clickland
API key", buttons "Test" and "Save", list "Test result", tab "Metrics"; classes `.metrics-src`, `.mtab`,
`.chart-plot`, `.chart-tip` (Overview only), `.chart-now`, `.chart-legend`, `path.edge`, `path.line`, `.test-steps`. MCP: button "MCP"; tabs
"Servers" and "Calls"; regions "MCP server <name>"; lists "<name> tools" and "MCP calls"; buttons "Add server",
"Preview <tool>", "Test", "Save"; dialog "Add an MCP server" with fields "Server name", "Server address", "Header
name", "Header value"; a `switch`; complementary "MCP call" with list "Front-door requests"; classes `.mcp-tool`,
`.mcp-call`, `.tool-app`, `.app-frame`, `.tool-with-app.folded`, `.tool-verdict`; the status `.seg` (group
"Status") with "Autonomous"; the drawer's "Allowed by"; switch "Use clickland on
<context>". Connections: button "Connections" (sidebar and Welcome); heading "Connections" (standalone); regions
"GitHub connection" and "Linear connection"; the tool rows' **Routine** badge; buttons "Connect", "Disconnect", "Use a token instead", "Use an API key
instead", "Open github.com/login/device", "Read only", "Ask for writes", "Review tools", "Accept these tools",
"Manage in Connections"; label "Device code"; fields "GitHub token" and "Linear API key"; switches "<Name>: reads run
without asking" and "Give <Name> to Claude sessions"; lists "<Name> tools"; regions "MCP server github".
Land family: region "Land family" with heading "Land family"; regions "Clickland connection", "Landflow connection",
"Landfall connection"; lists "What <Name> is used for" (the `.fam-row`s, each `.fam-label` and `.fam-state`) and
"<Name> check"; buttons "Connect…", "Settings…", "Connect", "Sign in", "Sign in again", "Sign out", "Set up", "Edit",
"Check", "Disconnect"; fields "Landflow address", "Landflow API key", "Landfall address"; form "Triage webhook"
with fields "Webhook path", "Webhook header name", "Webhook secret". Connect Clickland opened from here has no
"Cluster name in Clickland" field.
Autonomous: buttons "GitHub · asks", "GitHub · autonomous <n>/20", "Turn on", "Stop GitHub autonomous"; dialog
"GitHub autonomous" with fields "Repositories", "Default branch" (Linear: "Team key"); status "Autonomous" (the
strip); region "Claude asks"; classes `.auto-chip`, `section.change`, `.change-done.rejected`. Badges and key hints inside buttons are `aria-hidden`,
so they don't change a button's name; Overview tiles are links named "Open …", and its rows are `.ov-row`, not `.tr`.
Google suggests (wave 9): region "Google suggests"; rows `.gs-row` with `aria-expanded`; the opened `.gs-detail`;
button "Check Google's suggestions again"; the failure `role="alert"` with button "Copy command"; the hint is a
`role="note"` with button "Open Google Cloud".
Sidebar (D139): headers `.nav-sec[data-sec="<section>"]` with `aria-expanded` and `aria-controls`; groups named by
section ("Workspace", "Pinned", "Cloud", "Workloads", …); in the rail a section is a button and its flyout a menu,
both named by the section; `localStorage` key `landlens.nav.v1`.

`LANDLENS_SHOTS=<folder>` saves screenshots of every screen in dark, light and at 1024×700 ([development.md](development.md)).
