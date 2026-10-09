# TDXLU (TDX Launcher Ultra)

A next-generation TouchDesigner project launcher — based on the Tauri 2 + React port of TD Launcher Plus, rebuilt and improved here.

## Stack

- **Tauri 2** + **Rust** backend
- **React 19** + **TypeScript** + **Vite 6** frontend

## Dev

```bash
npm install
npm run tauri:dev
```

## Build

```bash
npm run tauri:build          # unsigned local build (no updater artifacts)
```

## Release

Releases are built and published from local machines, two commands per
machine, nothing copied between them (full runbook:
[docs/releases-local.md](docs/releases-local.md)):

```bash
npm run release:build        # signed bundles for THIS machine -> artifacts/<platform>/
npm run release:ship         # upload this platform; the second machine to ship goes live
```

Companion TOX (its own channel, no build):

```bash
npm run release:prepare-utility
npm run release:publish -- --only utility
```

Credentials come from a gitignored `.env.release` at the repo root (copy
`.env.release.example`). Tag pushes no longer trigger CI; the workflows
under `.github/workflows/` are manual-dispatch only.

| Command | What it does |
|---|---|
| `release:build` | Fetch the FNSTools bootstrap, `tauri build --target <this machine>`, notarize the dmg (macOS), sign any bundle missing its `.sig`, collect into `artifacts/<platform>/` with a `bundle-info.json` naming the companion TOX it bundles |
| `release:ship` | Stage this platform + a `platform.json` fragment, upload; writes `latest.json` only once every shipped platform's fragment is in the bucket and all bundle the same companion as the tree |
| `release:prepare` / `release:publish -- --only app [--dry-run]` | The two halves of `release:ship`, for inspecting before uploading |
| `release:prepare-utility` / `release:publish -- --only utility` | Stage and upload the companion TOX from `release/TDXLauncherUtility.tox` |
| `set-release-host <https://host>` | Point the compiled-in updater endpoint and the Rust release base at a host (currently `launchdl.functionstore.tools`) |
| `fns:bootstrap [-- --force]` | Refresh the bundled FNSTools bootstrap from the rolling manifest |

## Tabs

- **Recent** — merged TD + launcher recents. Select a project to see its required TD build (via `toeexpand`), pick a version, launch.
- **Sessions** — one expandable card per live or recently ended TouchDesigner session, including ones opened outside the launcher (discovered by process scan). See [Sessions](#sessions).
- **Templates** — starter `.toe` files, reorderable, with a default TD version for the whole tab.
- **Palette** — `.tox` from `Documents/Derivative/Palette` plus custom folders; drag straight into a TD network. A pinned **Toolbox** section on top holds your go-to tools in user-defined categories — see [Toolbox](#toolbox).
- **FNSTools** — store, installer and global configurator for the [FNSTools toolkit](https://tools.functionstore.xyz): pick any subset, install it into a running session, edit every tool's settings. See [FNSTools](#fnstools).
- **Patreon** *(optional build)* — browse `.tox` components from creators you support and load one into a running session. See [Patreon import](#patreon-import).

## Features

- **First-run tour** — spotlight walkthrough that *drives the app as it talks*: it switches to each tab and narrates what lives there, with the spotlight on live content. On a fresh install most tabs are empty, so any pane that would render blank borrows stand-in rows for the duration (announced on the first card, gone when the tour ends). Replay it anytime with **Help → Start Tour**
- **First-encounter tips** — the first time you open a tab or a side panel, a small non-blocking bubble points at it and explains the part the tour skipped. Once each, ever; **Help → Show them again** re-arms the set
- **Setup wizard** — opens right after the tour (even if skipped): theme & view mode, `.toe` file association, one-click companion-TOX install, tray / login / hotkey behavior, and pointers to backups, GitHub, Patreon and the crash watchdog; rerun it from **Help → Setup Wizard**
- **Gallery view** — icon/hero grid (default); switch to classic list in the toolbar or Settings. Tiles with a preview clip play it on hover.
- **Version detection & install** — reads the build a `.toe` needs; if that version isn't installed, offers the matching Derivative download and runs the installer.
- **Missing-build fallback** — a `.toe` double-clicked in Finder/Explorer whose exact build isn't installed doesn't dead-end. The launcher asks once and remembers the answer in **Settings → Opening a project from Finder/Explorer**: the **latest** build, the **closest** one, a build you **pin**, or always stop and let you pick. Only the auto-launch countdown path uses it — choosing a version yourself in the app is unaffected.
- **Global hotkeys** — the launcher window is one keystroke away from anywhere (default `Ctrl/⌘+Shift+D`), TD fullscreen included. A second hotkey opens **Quick launch**, a small always-on-top search overlay: type a project, running session, palette / Toolbox / Patreon component or action — Enter launches / focuses / places it, or drag a `.tox` row straight into TD. A third can jump the main window straight to the Palette tab — each combo is independently bindable, on or off individually. See [Quick launch](#quick-launch).
- **Project versions** — one card per project: `Name.N.toe` increments, `Backup/` copies and crash autosaves fold into a family with a ⑂ badge; a versions drawer lists every copy with launch / restore-as-head / prune. See [Project versions](#project-versions).
- **Project sidecar metadata** — `{stem}.tdxlu.json` next to a `.toe`
- **Per-tab search** — the toolbar's search box filters the tab you're looking at and nothing else; each tab keeps its own query, and a tab holding an active filter is marked in the tab bar so a stale query never reads as an empty tab
- **Inspector dock** — a compact, content-height dock on the right keeps project inspectors visible without claiming the whole edge; left-click opens one panel, while Ctrl/Cmd-click or right-click → **Open alongside** stacks up to three; expand its text labels from **View → Show panel labels**
- **Tags** — hierarchical with `/` (e.g. `show/live`); filter/edit via **Tags** beside Search in the list toolbar
- **Info** — per-project README shown and editable in-app; toggle with **Info** in the panel rail
- **Companion** — drive a running TD session from the launcher: save, thumbnails, preview recording, component loading. See [Companion TOX](#companion-tox).
- **MCP / Envoy** — detects a project's `.mcp.json`, reports the Envoy port, and falls back to Envoy `execute_python` when the companion's TCP bus is unavailable
- **Git** — side panel: Changes + History (commit log / show), diffs, stage/commit, branch, pull/push; GitHub PAT in Settings
- **Backup** — side panel: project folder ↔ USB / OneDrive / Drive / Dropbox folder; FreeFileSync-style exclude/include globs + max size; backup / restore / sync (no deletes). Or connect Google Drive / Dropbox / OneDrive / Box directly (“+ cloud”): a one-time rclone download, sign-in in your browser, then the service is a backup destination (backup / restore)
- **Heartbeat** — tray watchdog via TCP pulses from companion script/TOX; multi-project; SMTP alerts on stall/relaunch
- **Phone Remote** — run the show from your phone: one tap on the header's **📱 Phone** button (also reachable from Sessions → Control, or Settings) enables LAN access and shows a QR; scan it and a touch mirror of the Sessions tab opens on your phone. While the remote is live on your Wi-Fi, the header button shows a pulsing dot. Every session — live or ended — is a **tab**; the open tab shows the session's facts (version, PID, uptime, companion), a **heartbeat chip** when the watchdog is armed (last pulse + restart count), a live **perf readout** (fps / cook / drops / GPU / CPU / RAM, when Settings → Performance monitor is on), the actions **Focus / Save / Thumbnail / Preview video / Relaunch / Kill** (an ended session shows **Relaunch / Dismiss** — the same stale-session model as the desktop), and the session's live parameters — searchable, with **−/+ nudge steppers** on integer values and a **★ pin** that floats your key faders to the top (remembered per project). The Control page's target list is itself remote-editable: a quiet **＋ Expose a component** browser (desktop panel and phone alike) lists the session's COMPs that carry custom parameters and points a new Control-sequence block at the one you tap; a small **×** on a non-builtin target stops exposing it. A **+ Launch** button opens any recent project that isn't already running, so the phone is a remote of the whole launcher, not just of live sessions. Destructive taps (Kill, and a live-session Relaunch, which kills first) are **hold-to-confirm** with haptic feedback: press and hold ~0.7s, a bar fills, release early to cancel — the phone analog of the desktop confirm dialog. The screen is kept awake while the page is open, and it **installs to the home screen** as a standalone app (web app manifest served by the control server). The page follows the desktop theme. Same-Wi-Fi only; the pairing token is persisted (server-side and in the phone's storage) so a home-screen install keeps working across restarts (**Regenerate** invalidates every shared link). Token-gated, served over the launcher's control server (`control_server.rs`). For handing a remote to someone who should only *operate*, the pairing dialog has a second tab: **Client link** — a separate code whose pages show **only the authored interface** (the parameters you exposed on the Control page, with their tabs), and nothing else: no session actions, no launching, no component browsing, no paths. The restriction is **enforced by the server** (every other API route is refused for that token), not merely hidden in the page — and **Regenerate** invalidates both links at once. **Settings → control server** holds the HTTP port (changing it rebinds a running server live — paired devices just re-scan the QR), the LAN toggle, and **Stop server** (keeps the pairing, kills reachability)
- **Project media** — auto-scans a media folder next to the `.toe`; browse from the version panel
- **Tray** — stays in the system tray; Settings control close-to-tray and quit-after-launch
- **Start at login** — Settings toggle registers TDXLU with the OS (Windows Run key / macOS LaunchAgent); login launches start minimized to the tray when the tray icon is enabled

## Quick launch

Press the Quick Launch hotkey (default `Alt/⌥+Shift+D`) anywhere — TD fullscreen included — and a small search overlay appears over everything, for when you'd rather type a name than browse the main window. One input, everything reachable:

| Result | Matched on | Enter | Also |
|---|---|---|---|
| Project (family) | name, path, tags | Launch the head with its detected build | `Ctrl+Enter` → TouchPlayer |
| Running session | name, path | Focus its window | |
| Toolbox / Palette / Patreon `.tox` | name, category, creator | Place into the running session (companion `load_tox`) | **drag the row straight into a TD network** |
| Template | name | New project from it | |
| Command | verb | Run it | `>` filters to commands only |
| Tool command | label, help | Run it in the session offering it | `?` filters to tool commands only |

Empty query shows running sessions, your most recent projects and the app commands; typing fuzzy-matches across everything, field-aware — a name hit outranks a category hit outranks a path hit, and every word must land somewhere. `Esc` or clicking elsewhere dismisses. Patreon rows are the `.tox` files already downloaded to your Patreon cache — no network involved.

**Filter tokens** mix freely with search words, in any order:

- `=` *(leading)* — components only: palette, Toolbox and Patreon `.tox` rows. Bare `=` browses the whole library grouped by where things live; `=midi` searches just components.
- `/x` — filter by *place*: palette folder, Toolbox category, Patreon creator, or `Templates`. `/live` browses your `User Palette / Live` folder grouped under headers; `/pat` is the whole Patreon cache (`/pat blur` searches only it, `/alta` narrows to one creator); `/toolbox`, `/templates` likewise. Combines with `=`.
- `#x` — filter by project tag. `#show` lists everything tagged `show/…` — running sessions keep their project's tags, so a live show still surfaces. `#show aur` combines with search.
- `?x` — **tool commands** only: the actions components inside your running sessions have published — `?` alone lists every one your sessions offer. See [Tool commands](#tool-commands).

All five prefix characters (`>` `=` `/` `#` `?`) are customizable in **Settings → hotkey → Filter prefixes** — the overlay's placeholder and hints follow whatever you pick.

**Commands** are verb-first, Raycast-style. Every live session contributes `Focus <name>`, `Save <name>`, `Thumbnail <name>` and `Preview video <name>` (companion required), `Relaunch <name>` and `Kill <name>`; the app adds Open TDXLU / Settings / About & updates, plus **New default project** (a launch, but it reads as something you *do*, so it lists as a command too). Type `>` to see only commands — `>ki` then Enter is the whole kill flow. **Destructive commands (Kill, Relaunch) arm on the first Enter** — the row turns red and the footer says what a second Enter will do; any other key (or Esc) disarms. Nothing destructive ever fires on a single keypress.

**Executed queries are remembered.** `Alt+↑` / `Alt+↓` cycle back through what you actually ran, shell style — `↓` past the newest returns to the draft you were typing, and typing anything starts a fresh one. Persisted across restarts.

### Tool commands

Components inside a running project can publish their own actions to the palette. They ride the `>` command list, own the `?` prefix, carry a **TOOL** badge, and show the tool's own one-line help under the label; the launcher runs them over the companion bus (`fns_commands` / `fns_run_command`; companion ≥ 0.11.0, Envoy fallback). Nothing to configure — a session carrying a tool that registers commands contributes them the moment it is running.

- **Arguments** — a command can declare keyword parameters. They render as ghost chips after the label and fill as values arrive: either through a prompt flow (typed values in the input, menu/toggle values as pick rows) or **inline**, as trailing query tokens that spill into the declared params in order — `? rec 2` runs the recorder with `seconds=2` and fires immediately when the rest is covered by defaults. Single-token values only; anything with spaces goes through the prompt. The registry coerces and validates by declared style before the tool's method is called, so a bad value or a missing required param refuses the run with a named error.
- **Several sessions, one row** — identical commands across sessions merge, with a session-count badge. The run targets the session the palette was summoned over (any of its TD windows); when focus can't disambiguate you pick from a list, and `→` opens that picker on any tool command.

The registry ships inside the companion TOX and promotes itself to `/sys` (`op.FNS_COMMANDREGISTRY`), so it survives utility updates for the life of the TD process. Tool authors: one `@fns_command` decorator plus one `announce()` call — full contract in [docs/fns-command-registry.md](docs/fns-command-registry.md). [FNSTools](#fnstools) packages publish commands out of the box.

Three global hotkeys are configurable independently in **Settings**, each with its own on/off toggle and combo: the main launcher window (the primary way in, default `Ctrl/⌘+Shift+D`), Quick Launch (this overlay, default `Alt/⌥+Shift+D`), and the main launcher window on the Palette tab. The first two are bound by default; the Palette one is opt-in.

## Phone multi-touch

Turn any phone on the network into a multi-touch surface for TouchDesigner —
**and it no longer needs the launcher running.** Touch is served by the
**FNS_Remote** component (an FNSTools package): it runs its own web server
inside TouchDesigner, serves the touch page itself, and holds the phone's
WebSocket, so the phone talks to the session directly.

Arm **Active** on FNS_Remote, turn on **Allow LAN access**, and pulse **Open
Pairing Page** for a QR to scan. One session, one server, one link — which
also means multiple sessions can each have their own phone, something the old
launcher relay could never target correctly.

| Output | Channels / rows |
|---|---|
| `null_touch` | `t<N>:tx`, `t<N>:ty`, `t<N>:force`, `t<N>:active` per touch slot, plus `touchcount` |
| `table_clients` | one row per connected phone: address, screen size, user agent |

Touch Y is flipped by default so `0` is the **bottom** of the phone screen,
matching TD's bottom-up texture and UV convention (**Flip Y**). Positions are
`0-1` across the touch area unless **Normalize** is off, in which case they
are scaled by the phone's reported screen size.

Three buttons build the receiving operators for you, wherever **Create Target**
points (blank = the network you have open): **Create Select CHOP**, **Create
Select DAT**, and **Create Receiver** (one COMP holding both). Everything they
build references the `op.FNS_REMOTE` global shortcut, so the operators keep
resolving no matter where in the project you drag them.

The server binds **loopback only** until you explicitly allow LAN access, and
its access token is stored per machine — never in the project file — so a
`.toe` you hand to someone else carries the capability dormant rather than a
live listener and your token.

> **Touch only, by design.** Motion sensors (accelerometer, gyroscope) are
> deliberately not supported: browsers expose `DeviceMotion` only in a secure
> context, which would drag a TLS certificate and a per-phone trust install
> into a live rig. Multi-touch needs none of that and works over plain HTTP
> everywhere.

## Project versions

TouchDesigner projects accumulate copies of themselves: incremental saves (`Project.2.toe`, `Project.3.toe`, … — the plain `Project.toe` stays the newest save), backups TD retains in `Backup/Project.30.toe`, and `CrashAutoSave.Project.toe` after a crash. The Recent tab groups all of them into one **family card** per project:

- The card is titled by the base name and carries a **⑂ N** badge (variant count). Click it — or **Versions…** in the context menu — for the versions drawer.
- **Launch on the card always fires the head** (`Project.toe`) — never a guessed variant. If you last opened a different copy, the card says so (*"last opened Project.7.toe"*) as a passive hint that opens the drawer.
- A **⚠** chip appears when a crash autosave newer than the head exists.

Grouping is deterministic — filesystem conventions only, nothing stored: a numeric suffix counts as an increment only when the plain head exists or ≥ 2 files share the base (a lone `Show.2024.toe` stays its own project), and a file in `Backup/` belongs to the project one level up only when that folder actually holds family members. Toggle it with **View → Group project versions** (`V`) — off, every file lists individually and the head row keeps the badge.

The drawer lists every copy — head, increments, backups, crash — with age, size and per-file actions:

| Action | Effect |
|---|---|
| Launch | Launch that exact file (TD build detected from it) |
| Select | Put it in the launcher's picker to inspect / pick a version |
| Reveal | Show it in the file manager |
| Duplicate | Copy that file into a fresh `Name.N.toe` next to the project — same numbering TD's own incremental save uses, so it folds straight into the family. Works on any row, head included; the source is only ever read |
| Restore… | Make it the new head: the current `Project.toe` is preserved first as the next free increment, then the copy becomes `Project.toe`. Nothing is overwritten or deleted; the source file stays put |
| Recycle | Tick copies (never the head) and move them to the OS trash — the footer shows how much space the family's copies hold |

**Duplicate as new version** is also on every project's context menu (Recent / Templates), independent of the drawer — the way to start a family from a single-file project. Right-click → *Duplicate as new version* makes the first `Name.2.toe`, and the ⑂ badge appears from then on.

**Restore** is the "I kept working from `Backup/Project.30.toe`" fix: instead of hand-shuffling files in Explorer, promote the backup and the family has one unambiguous head again.

## Sessions

The **Sessions** tab is a stack of self-contained session cards, not a library list with a separate detail pane. Every running project shows what it *is* — TD version, PID, `Envoy :port` up/down, whether it was launched here or opened externally, uptime and optional performance — because the version is already decided. Expand a card for its companion capabilities and owned windows.

Actions on the selected session:

| Action | Effect |
|---|---|
| Focus | Bring the TD window to the front |
| Explore | Reveal the `.toe` in the file manager |
| Heartbeat | Hand the session to the Heartbeat watchdog |
| Relaunch… | Confirm dialog — **pick the TD version there**, optionally killing the current process first |
| Kill | Terminate the TD process |

Uptime only appears for sessions the launcher started; externally-opened ones report everything else.

### Stale sessions

A session the launcher started that ends — you **Kill** it, or it crashes — doesn't vanish from Sessions: it stays as a dimmed **ended card** (most-recent on top) so you can bring it straight back. This is deliberate accidental-kill insurance: Kill still asks for confirmation, and even if you go through with it, the card is one click from returning.

| Stale-row action | Effect |
|---|---|
| Relaunch | Start the project again with the build it last ran — no confirm, no kill-first (its process is already gone) |
| Dismiss | Remove the ended row from the list for good |

Stale rows are remembered only for the current launcher run (cleared on restart) and cover **sessions the launcher started** — an externally-opened TD that dies leaves no relaunch record. Relaunching a stale project (or reopening it externally) turns its row live again in place.

## Companion TOX

`release/TDXLauncherUtility.tox` (exported from the `utility/` TD project via Embody's Release All) runs inside a project and exposes actions over a TCP bus (Envoy `execute_python` is the fallback). When it's present, the session card gains companion actions and expandable capability rows:

**It re-lands itself at `/`.** Its address is `/TDXLauncherUtility` — beside `/FNSTools`, which FNSTools declares as `placement: "root"` — but a drag-drop lands a `.tox` wherever the network editor happened to be showing. So a copy that wakes up nested copies itself to the network root and retires the nested one a few frames later, before the misplaced copy binds a bus port or subscribes to drops. Tag the COMP `tdxlu_keepnested` to keep one where you put it; copies parked under `/sys`, `/local` or `/ui` are left alone. If `/TDXLauncherUtility` already exists, the new copy lands beside it as `TDXLauncherUtility1` rather than replacing it.

| Button | Action |
|---|---|
| Save | Save the `.toe` in place |
| Thumbnail | Capture `preview/preview.png` + the project icon |
| Preview video | Record `preview/preview.mp4` (length from **Rec Seconds**, up to 30s) |
| Load tox… | Pick a local `.tox` and load it into the network editor pane |
| From URL… | Download a `.tox` and load it — see [Adding components](#adding-components) |
| From package… | Install a package from the configured index and load its ToxFile — sets up the project's Python env first if it has none |
| Set up Python env | One click: TouchDesigner's own `TDPyEnvManager` builds the project's `.venv` — see [Python env and packages](#python-env-and-packages) |

> **Collect & Save, the media browser and Autosave are no longer in the
> companion.** They ship as FNSTools packages (`FNS_Collect`, `FNS_MediaBrowser`,
> `FNS_Autosave` — Autosave is free), and the phone touch receiver moved into
> `FNS_Remote`. A session that has them advertises them, and the launcher
> renders them in the expanded card automatically; install them from the
> **FNSTools** tab. They did not disappear — they moved to a rail the launcher
> can stock from, and Autosave got *freer* in the move: it now works for people
> who never install the companion at all.

**Autosave** opens a small dialog per session. Turn it on, set the interval in
minutes, and pick what a save means: **TouchDesigner Save** follows TD's own
*Increment Filename when Saving* / *Copy to Backup Folder* preferences (a new
numbered `.toe` each time when increment is on), or **Overwrite the open .toe**
which always writes back to the file you are working in, whatever those
preferences say. Two skips keep it out of the way of a show — *only save when
something changed*, and *skip while the project is in Perform Mode* — plus a
**Save now** that ignores both. A save stalls the frame while the `.toe` is
written, so the interval is yours to pick; the dialog shows when the last one
landed, or why the last scheduled one was skipped. Autosave ships as the **`FNS_Autosave`** FNSTools package (free), not in the
companion — its settings live on that component, so the whole feature works
inside TouchDesigner with no launcher running, and it is available to people
who never install the companion at all. The launcher renders this dialog when
a session advertises it; install it from the **FNSTools** tab.

Captured stills and clips land in `preview/` beside the `.toe` (paths are stored relative, so moving or renaming the project doesn't orphan them). The gallery picks them up automatically.

Collect ships as the **`FNS_Collect`** FNSTools package and works entirely inside TouchDesigner with no launcher needed: the component is standalone-capable and carries its own panel UI (pulse **Open UI**, or use the pulses on its Collect page). The panel has Scan / Collect & Save / freeze-toggle buttons, a live status line, and the scan plan as a clickable list — click a file row to include/exclude it, or a category header row to toggle the whole media type. With the launcher running, the same plan/confirm appears as the dialog described above.

### Palette tabs inside TouchDesigner

With the companion (v0.21.0+) loaded, TouchDesigner's own **Palette Browser**
(Alt+L) grows two extra tabs next to the stock palette: **TDXLU** — your
Toolbox, the FNSTools shelf, and a **Commands** list (every command your tools
announced to `FNS_CommandRegistry`, the same list the quick-launch `?` prefix
shows, with argument prompts, run in that session) — and **Patreon** — the
creators you support and their posts that carry a `.tox` (with a *Hide
locked* toggle). Every component row has a **↳** that places it straight into
that session's network editor (the same `load_tox` path as the desktop
Palette tab). URL tools and FNS packages not yet on disk show a **☁** and
download on first use; Patreon attachments download into the same cache the
desktop uses. The Toolbox sub-tab also works the other way: **⇱ Pin selected
COMP** saves whatever is selected in the session's network editor as a `.tox`
(into your TD user palette, under *TDXLU Toolbox*) and pins it. A session bar
above the footer carries the focused session card's everyday verbs — Save, Thumbnail,
Preview video, an Autosave toggle — and, with the Performance monitor setting on, a
one-line health readout (fps · cook ms · dropped frames · GPU memory). A
fourth **Session** sub-tab lists the bigger tools with a live summary each,
and every one opens full-height (a `Session › …` crumb brings you back):
**Collect & Save** (scan the project's external files, untick what to leave,
collect with progress — with a thumbnail of each file), **Media** (every
media reference the project uses, **previewed right in the row** — images and
clips render, anything the browser can't decode shows its kind — what is
missing, **click any row to swap its file** — TouchDesigner's own file
browser opens right where you are — and *Re-root* for the relative paths a
folder move broke),
**Git** (branch and change
count, a message field, *Commit all* with the project saved first),
**Backup** (what a backup to your configured folder would copy, *Back up
now*), **Phone Remote** (the link as a QR code you can scan right off the
palette, a one-click turn-on, and the COMPs the phone's Control page exposes
— *Expose selected COMP* puts whatever is selected in the network on the
phone) and **Windows** (the session's actual windows, exactly as the
launcher's session rows list them — main window, torn-off panes named by
what they show, the perform window — focus, minimize or restore each, bring
all forward, plus save/apply/clear of the project's window layout). When
the launcher carries a newer companion than the session runs, the tab says so
with a one-click **Update**.

How it works: the launcher serves the page on its localhost control server and
hands each session the link over the companion bus the moment the companion
says hello, so a launcher restart reconnects every open session. Inside TD the
tab strip belongs to **FNS_PaletteRegistry**, a small FunctionStore-style
registry the companion ships (any FNS tool can publish a native panel as a
tab the same way); the launcher's two tabs are one Web Render TOP registered
under two names — the stock palette is untouched (TD's native drag still works
on the first tab), and the browser process only runs while one of the
launcher's tabs is showing. The Patreon cookie stays in the launcher; TD only
ever sees the page.

Turn it off in **Settings → Control panel server → Palette tabs in
TouchDesigner**, or per session on the companion's **Palette** parameter page
(which also has Install / Remove / Reload / Open Palette Browser). Without a
running launcher the tabs show a hint instead. Design record:
[docs/palette-tabs.md](docs/palette-tabs.md).

## Toolbox

The Palette tab opens with a **Toolbox** — a favorites shelf for the components you reach for on every project, organized into categories you define (e.g. `Generators`, `Utils`, `Show Control`). It lives in the launcher config, so it's the same set no matter which palette folders are scanned.

A tool is one of:

| Kind | Source | Behavior |
|---|---|---|
| **Local** | Absolute `.tox` path (anywhere on disk — palette or not) | Drag straight into TD; flagged `(missing)` if the file vanishes |
| **URL / GitHub** | Direct `.tox` URL or `owner/repo[#Asset.tox]` | Fetched into `tox_cache` on pin (☁ = not fetched yet — click to fetch); ⟳ re-fetches, so a GitHub source updates to the latest release |
| **Package** | pip spec for the configured package index | Stores the spec; install into a running project via Sessions → Add to project → From package |

A **Load .tox into** bar at the bottom of the palette pane (same shape as the Patreon tab's target picker) names the running session with the companion utility — a dropdown when several are running — and its **Load** button sends the selected component into that session's network editor (the session card's `load_tox` path). Every `.tox` row also gets a quick **↳** hover action doing the same, no selection needed.

On first run the bundled **Launcher Utility** companion TOX is pre-pinned at the top level, ready to drag into any project; remove it like any tool and it stays gone.

Pinning: **＋ Tool** in the Toolbox header (or ＋ on a category row), select any palette `.tox` and hit **☆ Add to Toolbox**, or just **drop a `.tox` onto the Toolbox** — onto a category row to pin it there, anywhere else in the section for the top level. That works for files from Explorer and for items dragged up from the palette tree below (dropping on the tree still copies into User Palette, as before). Categories are created inline while pinning, or with **＋ Category**; rename / reorder / remove from the ✎ on the category row (removing a category keeps its tools). Tools carry an optional label and notes, and reorder with ▲▼.

## Adding components

**From URL…** accepts:

- Any direct `.tox` URL on any host — object storage, CDN, plain web server, LAN address. Query strings (presigned links) are fine.
- `owner/repo` or a GitHub URL — resolves the latest release asset; add `#Asset.tox` to pick a specific one.

Downloads are cached under `tox_cache` keyed by URL + filename, so two hosts serving the same filename don't collide. Redirects are followed (10 hops), 512 MiB cap.

The URL must contain the `.tox` in its path — share links that hide the filename behind a redirect aren't resolved yet.

**From package…** browses a **configurable package index** (Settings → Packages; defaults to PyPI) or takes a custom package / `git+https` spec, installs it into the project's Python env, resolves the package's ToxFile, and loads it. A project with no env gets one first, in the same click — see below.

The index is any Warehouse/PyPI-compatible index (serves `/simple/` + `/pypi/<name>/json`). A **name filter** (default `tdp-`) narrows a big shared index like PyPI to TD packages; clear it for a small/curated index to list everything. Installs resolve from `<index>/simple/`.

### Python env and packages

Packages live in a **project-local Python env** — `.venv` beside the `.toe` — which TouchDesigner puts on its Python path. Nothing is installed into TouchDesigner's own Python.

**Setting the env up is one click** (**Set up Python env** on the session card, or automatically the first time you use **From package…**). It is done by TouchDesigner's own **TDPyEnvManager** (palette `Tools/tdPyEnvManager`, TD 2025.31550+), exactly as if you clicked it yourself:

1. The companion drops the manager at `/` if the project has none (found through `app.paletteFolder`, so it works inside a macOS `.app` bundle too).
2. It switches the manager **Active**. **Derivative's disclaimer** ("Sideloading Python environments … at your own risk") appears in TD, and the launcher brings TD to the front — that is the one click you still make, and it is deliberately not bypassed: it is Derivative's consent step.
3. It presses the manager's **Create vEnv**. The env is built on TD's ThreadManager, so TD doesn't freeze.
4. The launcher follows the manager's own status and reports *ready*, the manager's error, or *disclaimer declined*.

Needs companion utility **0.23.5+**; an older utility only drops the manager (click **Create vEnv** on it in TD).

**Installing does not need anything extra on the machine.** The launcher uses **uv** when it finds it, and the env's own **pip** otherwise:

| | uv (optional) | pip (fallback) |
|---|---|---|
| Needs installing | Yes — [docs.astral.sh/uv](https://docs.astral.sh/uv/) | No — comes with the env |
| Speed | Much faster: parallel downloads, one shared cache across every project env | Fine for one package at a time |
| Env without pip | Works (installs into any Python) | pip is bootstrapped first with `python -m ensurepip` — offline, from the Python that built the env |
| Same index, same result | `uv pip install --index-url <index>/simple/` | `python -m pip install --index-url <index>/simple/` |

An env built by TDPyEnvManager (plain `python -m venv`) has pip; one built by uv (Embody's project env, for example) does not, which is what the `ensurepip` step covers. The session card's env chip tooltip says which installer the next install will use.

uv is looked for on `PATH`, then where its installers put it — Windows: WinGet's package folder, `%LOCALAPPDATA%\cargo\bin`, `%USERPROFILE%\.local\bin`; macOS/Linux: `~/.local/bin`, `~/.cargo/bin`, `/opt/homebrew/bin`, `/usr/local/bin`. (A Mac app started from Finder or the Dock gets a minimal `PATH`, so without that list an installed uv would be missed.)

Either way, a `git+https://…` spec needs **git** on the machine.

What uv is otherwise good for — locked, reproducible envs (`uv lock` / `uv sync`) and managing Python versions — is why tools like Embody use it for their own project env. The launcher's one-package installs don't depend on any of that.

Both dialogs remember what you've added before and offer it back as clickable **Recent** entries (successful adds only; `×` forgets one).

## FNSTools

User-facing tool names follow the FNSTools convention: a leading `FNS_` is omitted (`FNS_Autosave` displays as **Autosave**). Package names, registry identities, and wire keys keep their original value internally.

The **FNSTools** tab marries the launcher with the FNSTools
packaging system (buckets + manifests — the same catalog as
[tools.functionstore.xyz/get](https://tools.functionstore.xyz/get/)).

**Catalog** — the current release rendered by category, with each
package's description, version and docs link. What the target session
already has is pre-checked (with `installed` ✓ and `1.1.0 → 1.2.0`
update badges), and a dot marks what's already mirrored in the FNS
palette store. Pick tools, then:

- **Install** — stocks the palette store (sha256-verified
  downloads), writes a `selection.json`, and drives the toolkit's own
  `FNS_Installer` in the running session over the companion bus
  (`fns_install`; companion ≥ 0.9.0, Envoy fallback). No toolkit in the
  project yet? The one-drop bootstrap is loaded first. The confirm step
  shows **adds and removals** — the FNS installer edits the project's
  tool set to match the selection, it doesn't just add.
- **Download selection for offline use** — stock the store without touching any session
  (the store is machine-wide; TD's own installer/updater read it).
- **Copy Textport install script** — the website's one-line paste rail, for a
  machine or session the launcher can't reach.
- **Mirror the whole release** — download every package into the store.

**Tool settings** — the toolkit's global per-tool configuration:

- **Live**: when the target session carries the toolkit, the
  launcher talks to FNS_ConfigRegistry's own settings server
  (`fns_settings_url` starts it, requests proxy through Rust) — full
  parameter metadata, menus, ranges, and validated writes that TD
  persists itself. Bound/expression parameters show but stay read-only.
- **Offline**: no session → edit
  `<palette>/FNSTools/config/FNStools_config.json` directly (atomic,
  `.bak` kept). Tools re-apply their section when they next load.

The Palette tab also grows an **FNSTools shelf** next to the Toolbox:
every tool package grouped by category — ◆ in the store means drag it out;
◇ downloads on click; ◑ marks a stale store copy. What the row's action
does follows the package's own `placement` in the manifest: **↳** places a
component (`pane`, or the FNS operator family's `none`) into the pane like
any palette `.tox`, while **⊕** hands an install package to the toolkit's
FNS_Installer with a minimal one-package selection, so it arrives where
the toolkit puts it and is recorded for updates (the bootstrap is dropped
first if the project has no toolkit root). A package that stands in for a
stock operator shows *alternative for Noise CHOP* — once it is in the
store, TouchDesigner offers it when you create that operator with
alt+ctrl held.

**Settings → FNSTools** sets the release bucket URL (default the
official one; a mirror or staging bucket works). Design record:
[docs/fns-integration.md](docs/fns-integration.md).

### Patreon import

The **Patreon** tab (present only in builds compiled with the `patreon` feature) lists `.tox` components from creators you support and loads one into the selected running session — the same `load_tox` path as "From URL…".

Set your Patreon `session_id` cookie in **Settings → Patreon** (from DevTools → Application → Cookies → patreon.com). Then the tab shows your creators → recent posts carrying a `.tox` → **Load**.

Why a cookie and not OAuth: Patreon's official API structurally can't do this. A patron token only exposes *which* campaigns you support, never their posts or attachments, and the Post resource has no attachments field even for a creator's own token. So this uses Patreon's private web API with your own login — only content your account can already access. It's the unofficial API (no stability guarantee) and the cookie is full account access, so the whole feature is behind a build flag and off unless you opt in.

**Build toggle:** the feature is in `default` (Cargo). To ship without it — the tab, the Settings field, and all Patreon networking are excluded from the binary:

```bash
cargo tauri build --no-default-features
```

## Updates

### App

The app and the companion TOX are **two independent release channels** served from one Cloudflare R2 bucket. A new utility ships without an app release, and vice versa. Full setup and release procedure: **[docs/releases-r2.md](docs/releases-r2.md)**.

> Releases are not on GitHub Releases: this repo is private, so those assets need an auth token the updater can't present. R2 objects are public.

The launcher self-updates via the Tauri updater: a quiet check a few seconds after startup plus **About → Check for updates**; an available update offers Install & Relaunch. The update source is **baked in at build time** — `plugins.updater.endpoints` in `tauri.conf.json`. Set it (and the utility channel's base, which lives in `src-tauri/src/updates.rs`) together:

```bash
npm run set-release-host https://launchdl.functionstore.tools
```

A unit test fails the build if those two ever drift apart. Since 0.20.0 the
host is `launchdl.functionstore.tools` (a custom domain on the R2 bucket);
older installs still poll the bucket's `r2.dev` hostname, which serves the
same objects and must stay enabled.

Releasing (since 2026-09-08, local machines only — see
[docs/releases-local.md](docs/releases-local.md)): bump the version
(`tauri.conf.json` / `Cargo.toml` / `package.json`, plus the lockfiles),
update `RELEASE_NOTES.md`, commit, then on the Mac and on the Windows box:

```bash
npm run release:build && npm run release:ship
```

Each machine uploads its own platform; the second one to ship writes the
merged `app/latest.json` and the release goes live. Tags (`v*`) are history
only — they no longer trigger a build. The updater private key
(`~/.tauri/tdxlpp_updater.key` on each machine; the public half is committed
in `tauri.conf.json`) signs the updater artifacts — losing it means shipped
apps can no longer verify updates, so back it up. The Cloudflare token and
account id live in a gitignored `.env.release`.

`npm run tauri:build` (plain local build) uses the `tauri.ci-artifacts.conf.json` overlay to skip updater artifacts, so it needs no key and must not be used for a release.

### macOS signing

Release builds are Developer-ID-signed and notarized (`release:build`
notarizes and staples both the `.app` and the outer `.dmg`), so a downloaded
build opens without any Gatekeeper workaround. Builds older than 0.20.0 were
ad-hoc signed; for one of those, clear the quarantine flag once after copying
to Applications:

```bash
xattr -cr "/Applications/TDX Launcher Ultra.app"
```

### Utility TOX

The utility has its own version (`utility/UTILITY_VERSION`, mirrored in `TDXLUUtilityExt.UTILITY_VERSION` — bump both), reported over the TCP bus hello.

There are two hops, and they are separate:

**Host → launcher.** The utility has its own release channel (`utility/latest.json` on the release host), so a new TOX reaches installed launchers **without an app update** — bump, re-export the TOX from TouchDesigner (Embody → Release All), then `npm run release:prepare-utility && npm run release:publish -- --only utility`. The bundled copy inside the installers is `release/TDXLauncherUtility.tox` at build time, and `release:ship` refuses a release whose installers bundle a different TOX than the tree. The launcher checks a few seconds after startup and on About → *Check for updates*, and offers **Utility Update Available**. Accepting downloads the `.tox`, verifies its SHA-256 against the manifest, and stores it in `<config>/utility/`. The same channel is the first-install path for a build that ships no TOX at all — *Download Utility TOX* in Help and the Setup Wizard fetch through it. That download then *is* the utility the launcher hands out — what **Install to Palette** copies, what the Toolbox drag handle serves, and what a missing-companion card offers. If an app update ever bundles a newer TOX than the last download, the bundled copy wins again automatically.

**Launcher → running session.** Unchanged. When a running session's utility is older than the one the launcher holds, its expanded card shows **Update companion → v\<x\>**. Accepting it:

1. refreshes the palette copy (overwrite — a stable path that always tracks the launcher's current utility), then
2. tells the running utility to repoint its **External .tox** at that palette copy and reload in place. **Reload Custom Parameters is forced off first**, so parameter values the user already set survive; the reload itself is deferred half a second so the TCP reply gets out before the network (bus included) reinitializes.

Pre-versioning utilities don't report a version and are treated as outdated. Save the project afterwards to persist the new external path.

## Project media

### Media folders

Put images/videos next to the project in any of these (first match wins):

1. `media_dir` from the sidecar (if set)
2. `preview/` — what the Utility TOX writes
3. `{stem}_media/` e.g. `MyShow_media/` (legacy)
4. `{stem}.media/`
5. `media/`
6. `gallery/`
7. `_media/`

Supported: `png jpg jpeg webp gif bmp` · `mp4 webm mov m4v avi`

Select the project → thumbnails appear under the version header → **Browse** for fullscreen, **Folder** to open in Explorer. In gallery view, a project with a video plays it on hover (the still is the poster; clips stream only while hovered).

Video is served over a custom `media://` protocol with HTTP Range support — the built-in `asset` protocol doesn't satisfy `<video>` in a WebView.

### Sidecar schema (`MyProject.tdxlu.json`)

```json
{
  "version": 1,
  "tags": ["show/live", "client/acme"],
  "title": "Optional display title",
  "description": "Short blurb",
  "hero": "preview/hero.png",
  "media_dir": "preview",
  "media": [
    { "path": "extra/cover.png", "kind": "image", "caption": "Cover" }
  ],
  "gpu": { "monitor": 1 },
  "windows": {
    "apply_on_load": true,
    "items": [
      { "path": "/perform", "display": 1, "justify_to": "specifydisplay", "size": "fill", "open": true }
    ]
  }
}
```

Folder contents are merged with any explicit `media` entries. If `hero` is omitted, the first folder image or existing `*_icon` files are used.

#### `gpu` — GPU affinity (Windows, TD 2022.20000+)

Binds this project's TouchDesigner process to a single graphics card at launch, for machines running one instance per GPU. The launcher turns the block into TD's own [GPU affinity](https://docs.derivative.ca/Using_Multiple_Graphic_Cards) flags:

| Sidecar | Command line | Notes |
|---|---|---|
| `{ "gpu": { "monitor": 1 } }` | `-gpuformonitor 1` | Monitors DAT index — left to right, bottom to top, **not** the order Windows lists displays. Portable between machines. |
| `{ "gpu": { "bus_id": "0:1:0:0" } }` | `-gpubusid 0:1:0:0` | The exact card, from the Monitors DAT `gpu_bus_id` column. Not portable. |

`monitor` wins if both are set; omitting the block (or leaving it empty) launches normally. Malformed values are dropped rather than passed on — a sidecar can arrive with a shared project. Confirm a binding took in the Monitors DAT's `affinity` column.

Set it per project from the file list's right-click menu → **GPU affinity** (only shown on Windows, and only with more than one display or an affinity already set). It applies to the next launch — TD can only be bound at process start. Window *placement* is separate: which monitor a window opens on is a project setting (Window COMP → `Justify and Offset to` / `Display`, and the Window Placement Dialog), not a command-line option.

#### `windows` — window placement (companion TOX)

Which display a window opens on is **not** a command-line option in TouchDesigner — no such argument exists. Placement lives in Window COMP parameters, so it is the companion TOX, inside the running session, that reads and writes it (verbs `windows`, `window_set`, `window_apply`, `window_save`, `window_clear` — see [PROTOCOL.md](utility/heartbeat/PROTOCOL.md)).

`window_save` captures the current placement into the block above; the Utility re-applies it ~90 frames after the project loads, once TD's own startup Window Placement has run. Fields mirror the Window COMP: `display`, `justify_to` (`primarydisplay` / `specifydisplay` / `alldisplays`), `justifyh`, `justifyv`, `offsetx`/`offsety`, `size` (`automatic` / `fill` / `custom` / `exclusive`), `winw`/`winh`, `single`, `borders`, `alwaysontop`.

- `apply_on_load: false` keeps a layout on file without restoring it.
- A bare list (`"windows": [ … ]`) is shorthand for `apply_on_load: true`.
- `open: true` opens that window on restore; `open: false` means "closed when saved" and never force-closes.
- Placement pars driven by an expression are refused, not overwritten — they come back in the `locked` list instead.
- Saves cover project-level windows only by default: a loaded palette contributes dozens of internal popup windows that nobody wants in a sidecar.

This pairs with `gpu` above: affinity binds the process to a card at launch, placement puts the windows on that card's monitors afterwards. The wiki is explicit that you need both — a window straying onto another GPU's desktop copies pixels between cards, which is the cost affinity exists to avoid.

## Bundled extras

- `src-tauri/resources/toeexpand/` — Derivative toeexpand, bundled with the app and used to read the TD build a `.toe` requires
- `assets/` — original app icons
- `release/TDXLauncherUtility.tox` — companion TOX (see [Companion TOX](#companion-tox)), exported here by Embody's Release All from the `utility/` TD project; **bundled into the installer** as a resource. Help → **Install Utility to Palette** copies it into the user's Palette (via the existing palette-import path) so it can be dragged into any project; when the bundled copy isn't present (e.g. in dev), the same buttons fetch it from the utility release channel instead

## Where things live

| Path | Contents |
|---|---|
| `src/` | React frontend (`App.tsx` is the shell; panels are separate components) |
| `src-tauri/src/commands.rs` | Tauri command surface — the whole IPC API |
| `src-tauri/src/project_meta.rs` | Sidecar parsing + media folder discovery |
| `src-tauri/src/open_projects.rs` | Running-session discovery and control |
| `src-tauri/src/tox_cache.rs` | `.tox` URL / GitHub release resolution + cache |
| `src-tauri/src/tdp*.rs` | Package-index catalog (configurable) and installs — uv when present, else the env's pip (`install_with_env`) |
| `src-tauri/src/mcp_bridge.rs` | `.mcp.json` detection, Envoy ping / `execute_python` |
| `src-tauri/src/media_stream.rs` | `media://` protocol with Range support |
| `src-tauri/src/proc.rs` | Child-process spawning and blocking-work helpers |
| `utility/` | Companion TOX and its externalized Python |

### Platform notes

Child processes are spawned with `CREATE_NO_WINDOW` on Windows (`proc::command`) — a GUI Tauri binary has no console, so an unguarded spawn flashes one. Blocking HTTP runs through `proc::off_runtime`, since `reqwest::blocking` panics if it's dropped inside an async context, and most commands are `#[tauri::command(async)]` to keep work off the UI thread.

## Note

Legacy Python/DearPyGui sources were intentionally not carried over from TD-Launcher-Mac.
