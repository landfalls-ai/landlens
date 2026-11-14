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
| Type | `--t-11` … `--t-30`, `--w-regular/medium/semibold` | 13/400 body, 11.5/500 sentence-case labels, no uppercase |
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
760 the status words; under 640 "Ask Claude" becomes its icon; columns drop in order Node, Ready, Age, Namespace,
Restarts (Namespace also whenever one namespace is selected).

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
  `cluster:health` every 10s through `useHealth`, which also feeds the sidebar badges and the status bar counts.
- **Lists** (`ResourceTable.tsx`, columns in `kinds.ts`): 32px inset rows; healthy status is a quiet dot and word,
  failing and pending are pills with a left edge; generated name suffixes dimmed (`splitName` in `present.ts`);
  restarts toned at 5 and 10; sortable headers; ↑/↓ or j/k; a row flashes when its status changes. The toolbar's
  `.seg` filters pods by status.
- **Drawer** (`Details.tsx`): kind tile, eyebrow, Ask Claude, copy, close; title with the hash dimmed; status and
  facts. Tabs Overview, Events, YAML (`[` and `]`), then Logs and Metrics disabled until wave 4. A failing pod leads
  with a **Diagnosis** card (why, retry, exit code, reason, how long it ran, and the termination message when the
  container left one); then facts whose Owner and Node navigate, containers, a conditions checklist, labels as
  chips. YAML (`Yaml.tsx`) is a numbered, coloured well whose `textContent` is still the exact YAML.
- **Dock** (`AgentDock.tsx`, `DockParts.tsx`): the darkest surface, so the cluster reads as the lit centre. Header
  with the read-only lock; consecutive tool calls in one list with icon status and numbered output; the ask card is
  the one thing with an iris ring; the composer holds the context chips, the Mode and Model pills, the state, and
  Send or Stop.
- **Jump to** (`JumpPalette.tsx`, ⌘K): kinds, and objects in the list already loaded.

## Components

Reuse these classes before writing new ones: `button.primary`, `.secondary`, `.ask-btn`, `.icon-btn`, `.link-btn`;
`label.field` (`.select` wraps a native `<select>`, `.search`); `.badge.ok|warn|bad|muted`; `.count-badge`; `.pill`;
`.chip` (key `i`, value); `.kind-tile` (`sm`, `lg`, tinted by tone); `.notice`; `.skel` (shimmer); `.empty`;
`.spinner`; `kbd` (always `aria-hidden`); `.panel`. Focus is `:focus-visible { box-shadow: var(--focus) }`
everywhere, inset inside rows and tabs.

## Keyboard

⌘K jump, ⌘J dock, ⌘B sidebar, ⌘1 Overview, ⌘2 Pods, `/` filter, ↑/↓ or j/k rows, Enter open, Esc closes the drawer
(never the dock), `[` `]` drawer tabs; in the dock, Enter and Esc answer the newest ask when the composer is empty.

## What the tests rely on

The e2e test finds things by role and name, so keep: heading "Pick a cluster"; buttons "Pods", "Deployments",
"Secrets", "Ask Claude", "Stop", "Send"; combobox "Namespace"; tabs "Overview", "YAML"; textbox "Message Claude
Code"; landmark "Claude Code"; classes `.tr`, `.drawer`, `.yaml`, `.ctx-chip`, `.tool`, `.tool summary`,
`.tool-failed`, `.msg-agent`, `.ask button.primary`, `.dock`. Badges and key hints inside buttons are `aria-hidden`,
so they don't change a button's name; Overview tiles are links named "Open …", and its rows are `.ov-row`, not `.tr`.

`LANDLENS_SHOTS=<folder>` saves screenshots of every screen in dark, light and at 1024×700 ([development.md](development.md)).
