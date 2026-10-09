# Palette tabs — the launcher inside TouchDesigner's palette

Design record for the in-TD palette tabs (branch `paletting`, utility ≥ 0.21.0).
Read this before touching `utility/TDXLauncherUtility/TDXLUPalette`,
`src/palette-standalone.tsx`, or the `/api/palette/*` routes.

## What it is

TouchDesigner's Palette Browser (`/ui/dialogs/palette/palette`, a
~314×1056 column) grows a folder-tab strip with three tabs:

| Tab | Content | Rendered by |
|---|---|---|
| **Palette** | TD's stock palette, untouched (including `TDX_SearchPalette` when the FNS toolkit installed it) | TD's own panel COMPs |
| **TDXLU** | The launcher's Palette tab, narrow: **Toolbox** (categories + pinned tools, plus **⇱ Pin selected COMP** — the inverse of ↳: saves the session's selected COMP into the user palette's `TDXLU Toolbox` folder and pins it) and the **FNS** shelf, one-click **place into this session**; a **Commands** sub-tab listing the session's `FNS_CommandRegistry` commands (the quick-launch `?` list, same user curation, ★ favourites first) with inline argument prompts, run in this session; a **companion update** notice when the launcher hands out a newer utility than the session runs; a **session bar** above the footer with the one-shot verbs only — Save · Snapshot · Record · Autosave chip (toggles the companion's autosave) — and an ambient health line (fps · cook ms · drops · GPU MB) while the launcher's Performance monitor setting is on; and a **Session** sub-tab: an overview list with live one-line summaries where each tool takes over the whole column behind a `Session › …` crumb (Patreon-style navigation) — **Collect & Save** (dry-run plan with per-file include + freeze-expressions toggle → chunked `collect_save` polled through `collect_status`), **Media** (the `media_list` inventory as a browsable list with **previews** — the file itself, rendered by the browser at row size — a missing filter, **click a row to replace its file** (`media_pick_replace` opens TD's own file browser over TouchDesigner and `media_pick_status` is polled for the outcome — the verb returns before the modal does), and the `repoint_assets` fixes with include → re-root, never saves), **Git** (branch · changes, message, save & commit all), **Backup** (plan to the configured backup folder, run), **Phone Remote** (the link as a QR, turn-on, and the COMPs the phone's Control page exposes — expose the selected COMP, remove) and **Windows** (the session's real OS windows as the desktop lists them — main, torn-off panes labelled by what they show, perform — focus / minimize / restore, raise-all / minimize-all, plus save / apply / clear of the sidecar window layout). Collect and Media scan only when opened; the other summaries load with the overview. No palette-folder view — TD's own palette is one tab over | a Web Render TOP showing `palette.html` served by the launcher |
| **Patreon** | The launcher's Patreon tab: creators → posts **that carry a `.tox`** (others are skipped; a *Hide locked* toggle, remembered, drops posts the tier can't view) → load into this session. The creator crumb bar is sticky so the way back never scrolls away | same Web Render TOP, `#/patreon` route |

The two web tabs share ONE Chromium (CEF) process. Switching tabs swaps the
page route via `executeJavaScript`; it never spawns a second browser.

## Why a web panel and not native TD widgets

- The launcher already owns every feature on those tabs (Toolbox config,
  tox cache, FNS store sync, Patreon cookie + private API, quick "place"
  routing). Re-implementing them as listCOMPs would fork the product.
- The Patreon `session_id` cookie never leaves the launcher: the page talks to
  the launcher's loopback control server with the control token, and the
  launcher talks to Patreon. TD never sees the cookie. That IS the
  "session_id sharing" — the launcher is the only holder, TD is a view.
- The Web Render TOP is available on every TD edition (Non-Commercial
  included) and on macOS since 2019.10000 — no license or platform gate
  beyond what the launcher already has.

Measured in the spike (TD 2025.33070, CEF 132): a 314×1024 page idles at
0.05 ms CPU / 0 ms GPU, clicks land via `interactMouse(u, v, leftClick=1)`
(`v` from the bottom), wheel needs `±120` per notch, and the page reflows when
the dialog is resized (it follows `parent().width/height`).

### What a web panel cannot do

Drag-and-drop FROM the web tab INTO a network — the page is a texture. The
gesture is **click to place**: the ↳ button on a row sends the component to
the session's current Network Editor through the launcher → utility bus
(`load_tox`, the same path the desktop Palette tab's ↳ uses). Tab 1 keeps
TD's native drag for everything in the stock palette.

## Pieces

### Companion: `/TDXLauncherUtility/TDXLUPalette`

Child COMP of the utility, standalone-capable like `TDXLUSensors` (its own
`pre_release.py` detaches the up-binds). `.py` DATs externalized individually,
no TDN tag (see `no-tdn-for-utility-children`).

Since 2026-08-23 the COMP is a **contributor to `FNS_PaletteRegistry`**
(contract: [fns-palette-registry.md](fns-palette-registry.md)) — it no longer
injects anything into the dialog itself. The registry master ships dormant at
`/TDXLauncherUtility/FNS_PaletteRegistry`, promotes to
`/sys/FNS_Registries/FNS_PaletteRegistry` (`op.FNS_PALETTEREGISTRY`) and owns
the strip, the mirrors, slot sizing and show/hide; any FNS tool can add a tab
the same way.

- `TDXLUPaletteExt.py` — `SetUrl(url)`, `Reload()`, `PaletteStatus()`,
  `Install()` / `Uninstall()` (publish / withdraw, which also flips `Active`),
  `OnPaletteTab(canonical, previous)`; `Status` readout.
- `FNS_PaletteRegistry` (stamped host): `Comp ..`, `Panel web`,
  `Canonicalname tdxlu`, `Tablabel TDXLU`, `Taborder 50`,
  `Callback palette_callbacks`, `Promotepars` off, `Autoregister` driven by
  `Active`. Sibling names on the OP pars — `../web` is the `comp.op()` form
  and evaluates to nothing on a COMP par.
- The **Patreon** tab is the same `web` panel under a second name, declared on
  the host's `Tab` sequence (`Tab0name patreon`, no `Source` → reuse the
  primary panel, `Tab0order 60`). Nothing registers it from code; the ext only
  flips the host's `Autoregister`.
- `web` — a container with a Web Render TOP as its background, a Panel
  Execute DAT forwarding mouse/wheel (`interactMouse`, wheel ×120; the
  container needs `mousewheel` on) and a Keyboard In DAT forwarding keys
  while the panel has focus. Built as a fixed 314×1024 constant; while
  registered the registry writes `w`/`h` slot expressions onto it
  (`SlotWidth()` / `SlotHeight()`, restored on unregister).
- `palette_callbacks` — `onPaletteTab(canonical, previous)` →
  `OnPaletteTab`: the browser's `active` becomes *"the Palette Browser is on
  screen AND one of my tabs is showing AND a URL is set"* (compare-before-set,
  so switching tdxlu ↔ patreon never restarts CEF) and the page is routed
  through `window.__tdxluRoute`. No launcher → no CEF process, a hint instead.
- **The browser runs only while someone can see it.** A Web Render TOP cooks a
  whole CEF process whether or not its page is on screen — the rule
  `/webBrowser` follows for its own `Active`. `PaletteVisible()` answers it
  with **two signals OR'd**, because neither covers both ways the palette
  opens: **`ui.showPaletteBrowser`** (*"get or set display of the palette
  browser"*) is `False` closed, `True` while the palette shows in the main
  window, and stays `True` if that showing palette is then floated — but
  **`ui.openPaletteBrowser()`, the alt+L / Dialogs-menu path, opens the
  palette straight into its own floating window and leaves
  `showPaletteBrowser` False**. For that case the dialog's **`winopen`** is
  the only signal there is. Neither ever reads true while the palette is
  closed, so the OR is safe. TD fires no callback for either, so
  `visibility_watch`
  (an Execute DAT `onFrameStart`) samples every `VISIBILITY_POLL_FRAMES` (15)
  frames; waking is immediate and the page is re-routed on wake, hiding waits
  `HIDE_TICKS` (2) consecutive ticks so a flicker never restarts CEF.
  Measured: palette closed → **0 cooks in 119 frames**; opened → active and
  cooking every frame within 20; closed again → off within 40. And the alt+L
  edge case end to end: floated from closed onto the TDXLU tab → active,
  cooking every frame; switched to another tool's tab → off; float closed →
  off, cooks flat.
  Everything more obvious is a dead end, all measured here: `COMP.visibleLevel`
  reads 0 on the panel, on both registry mirrors and on the palette panel
  itself *even while open with tabs being clicked*; no panel op in the dialog
  cooked once in 512 frames either way (only the Web Render TOP cooks); and
  the dialog's `display` par and its pane in `ui.panes` (a network editor
  someone parked inside the dialog, not its host) never move at all.
- What the registry does inside the dialog (all of it learned here, now
  generic): mirrors and strip are wired into `emptypanel`'s **panel tree**
  through its COMP connector and set to **`layer = 1`** (Dan's finds — the
  stock dialog is all layer 0 and its full-size background paints over later
  siblings); `emptypanel` is a **`verttb` stack** (spacing 2) placing
  children by `alignorder`, `list` (alignorder 3) is `panelh-32` tall so the
  strip takes alignorder 0.5 in TD's own 32 px and each mirror alignorder 2.5
  with `h = op("list").height`. Docked or floating makes no difference and no
  stock expression is touched.
- Utility page **Palette** (parent masters, child binds up):
  `Palettetabs` toggle (default on), `Paletteinstall` / `Paletteuninstall`
  pulses, `Paletteurl` + `Palettestatus` readouts (bind down).
- Bus verb `palette_url` `{url}` — the launcher hands the page URL to this
  session. Stored on the COMP so an extension reinit re-applies it.
- `ping`/`version`/`info` replies carry `palette: true` so the launcher knows
  the verb exists (older utilities answer `unknown action`).

### Launcher

- `control_server.rs`: `palette_page_url(app, session_id)` →
  `http://127.0.0.1:<port>/palette.html?sid=<hello id>#k=<author token>`.
  Always loopback, whatever the phone bind is (0.0.0.0 includes loopback).
  New routes (author tier only; the client tier's allow-list refuses them):

  | Route | Purpose |
  |---|---|
  | `GET /api/palette/catalog?sid=` | toolbox view + FNS manifest/store status + patreon flag, one round trip; with `sid`, a `companion` block (`session_version`, `available_version`, `update_available`) |
  | `POST /api/palette/place` | `{path, source}` → resolve a local `.tox` (local path / tox_cache URL / FNS store / Patreon download) → `run_utility_action(load_tox)` |
  | `POST /api/palette/fetch` | warm a url/GitHub Toolbox tool or FNS package into the cache |
  | `GET /api/palette/commands?sid=` | the session's `fns_commands`, curated like the quick-launch (`quick_shown_commands` / `quick_hidden_commands` beat the tool's `hidden`) |
  | `POST /api/palette/run` | `{path, key, kwargs?}` → `fns_run_command` (values cross as strings; the registry coerces by declared style) |
  | `POST /api/palette/favorite` | `{identity, favorite}` → pin / unpin a command (`tool#id`) in `quick_favorite_commands` — one list shared with the quick-launch (Ctrl+D / ★, favourites rank first) and Settings; the main window gets a `prefs-changed` event and re-reads its config. The commands listing carries `favorite` per row and the page shows a `★ Favourites` group first |
  | `POST /api/palette/update_companion` | `{path}` → the desktop's Update utility: refresh the palette copy of the effective TOX, then `update_utility` (repoint + reload in place) |
  | `POST /api/palette/pin_selected` | `{path, category?, label?}` → the inverse of ↳: the session saves its selected COMP (`toolbox_save_selected`) into `<user palette>/TDXLU Toolbox/<name>.tox` (uniquified) and the launcher pins it as a local Toolbox tool (not twice for the same file); refreshes TD's user-palette index |
  | `POST /api/palette/session` | `{path, action, payload?}` → one of the Companion-bar verbs, allow-listed. Free: `save` \| `pulse` \| `record` \| `autosave_get` \| `autosave_set` \| `autosave_now` \| `collect_save` \| `collect_status` \| `repoint_assets` \| `media_list` \| `selection`. Paid tier (gated like the desktop): `control_schema` \| `control_comps` \| `control_add` \| `control_remove` \| `windows` \| `window_set` \| `window_apply` \| `window_save` \| `window_clear`. Perf comes from the existing `/api/sessions/perf?td=` |
  | `POST /api/palette/media/ticket` · `GET /api/palette/media?t=` | previews. The launcher serves the **real file** through `media_stream::http_body` — the same allow-list and Range handling the desktop's `media://` protocol uses for its own WebView; nothing is resized, written or cached. An `<img>` / `<video>` cannot send the bearer and the token must never ride in a URL, so the page mints a **ticket** per file (opaque, one file, 5 min, capped at 512) and the element fetches with that alone; `handle_request` accepts a valid ticket in place of the header for this one route. A type the browser cannot decode is refused at mint time (415) so the row shows an honest glyph |
  | `GET /api/palette/oswindows?sid=` · `POST /api/palette/oswindows/action` | the session's real OS windows (`session_windows::list_for_pids`, panes labelled through the companion's `panes` verb — the same enumeration the desktop rows and the quick-launch drill-in use) and `{id, action: focus\|minimize\|restore}` / `{pid, action: raise\|minimize}` — the Windows drawer; the companion's sidecar layout (`window_save` / `window_apply` / `window_clear`) rides the session route underneath it |
  | `GET /api/palette/phone` · `POST /api/palette/phone/enable` | Phone Remote without side effects: `{running, lan, setting_lan, url (client-tier link, only when on the LAN), entitled}`; `enable` = the desktop's Phone button (binds the control server to the LAN, persists the setting) — the Phone drawer renders the link as a QR (`qrcode`, lazy-loaded) and lists / edits what the phone's Control page exposes (`control_schema` + `control_add` on the `selection` + `control_remove`) |
  | `GET /api/palette/git?sid=` · `POST /api/palette/git/commit` | the session project's repo status (`GitStatus`), and `{path, message, save?}` → save the project in the session (default on) then `git add -A` + commit — the Git drawer in the session bar |
  | `GET /api/palette/backup?sid=` · `POST /api/palette/backup/run` | destination + `backup`-mode plan to the launcher's configured backup root (local folder only — cloud remotes stay a desktop flow), and running it — the Backup drawer |
  | `GET /api/patreon/campaigns`, `GET /api/patreon/posts?campaign=&name=`, `GET /api/patreon/post?id=` | the desktop Patreon commands over HTTP (cookie stays server-side). `name` is only how the listing gets filed in the search index — the fetch itself never needs it |
  | `GET /api/patreon/search?q=` | name-search the cached `.tox` index (`patreon_index.rs`) — no cookie, no network, called on every keystroke |

- **Searching by `.tox` name** (`src-tauri/src/patreon_index.rs`). Browsing is
  creator-at-a-time, which is useless when you remember the filename and not
  whose it was — and creators rarely repeat the filename in the post title
  ("New patron component!" hides `God_Rays.tox`). Two scopes:
  - **Inside a creator**, the search box matches attachment filenames as well
    as the post title, filtering the already-loaded posts in memory. Live,
    free, no round trip — which is why there is deliberately no per-creator
    variant of the backend search.
  - **From the creator list**, the same box searches the whole cache and
    renders a *Components* section above *Creators*. Two corpora merged into
    one list: every creator's post listing, snapshotted to disk each time it is
    fetched (trimmed to names/urls — no post bodies), plus a walk of the
    Patreon download root, which is the only way to see `.tox` files unpacked
    from a `.zip` or downloaded before the index existed. A file both know
    about appears once, from the listing (it carries the post and campaign id);
    entries already downloaded are badged, and rank puts filename matches above
    title/creator-only ones. `cachedCreators: 0` is reported separately so the
    UI can say "nothing cached yet" rather than "no matches" — two empty
    results that mean opposite things.
  - Same feature on both surfaces: the desktop drags a hit into a network (the
    hit names its own creator, so the download still files under it) or clicks
    through to the post; the page offers **Add to Palette** / **Place in this
    session** on right-click, and resolves a local-only hit as `kind: "local"`.

- `watch.rs`: a **fresh** utility hello (new peer, or a peer back from stale)
  triggers `palette::push_url_to_peer` — ensures the loopback control server
  is running (feature + entitlement permitting) and sends `palette_url`. A
  launcher restart re-pushes to every session because every peer is fresh to
  it.
- `palette.html` + `src/palette-standalone.tsx` — third Vite entry (next to
  `control.html`, `quick.html`), same bearer-in-hash bootstrap as
  `control-standalone.tsx`. Narrow layout (≥300 px), theme follows the
  desktop via `/api/app`.
- Setting `palette_tabs_enabled` (default on) — Settings → Companion.
  Gated like Phone Remote / FNS / Patreon (`require_entitled`).

## Sequence

```
TD starts utility ──hello──▶ launcher (fresh peer)
                              │ ensure loopback control server
                              │ palette_url {url: http://127.0.0.1:11997/palette.html?sid=…#k=…}
                              ▼
                     TDXLUPalette.SetUrl → Web Render TOP loads page
page ──GET /api/palette/catalog──▶ launcher
user clicks ↳ ──POST /api/palette/place {path: sid, source}──▶ launcher
                              │ run_utility_action(sid, load_tox, {path})
                              ▼
                     utility LoadTox → component lands in the Network Editor
```

## Status (2026-08-22, branch `paletting`)

Verified live in TD 2025.33070 (utility dev project, CEF 132):

- Web Render panel inside `/ui/dialogs/palette/palette`: renders at the
  dialog's size, reflows on resize, `interactMouse(u, v, leftClick=1)` clicks
  land (`v` from the bottom), wheel scrolls with ±120 per notch, idle cost
  0.05 ms CPU / 0 ms GPU. Folder-tab switch → page route via
  `window.__tdxluRoute`.
- Launcher: `cargo check` / `cargo test` (121 passed) / `npm run build`
  clean; the debug launcher serves `palette.html` (200) and refuses every
  `/api/palette/*` call without the bearer (401); the fresh-hello push is
  live in its log (`palette tabs: handed the page URL to …`, and
  `unknown action: palette_url` from sessions running an older utility —
  the graceful-degradation path).

Verified end to end (same day, after the modal was cleared):

- Handoff: utility ext reinit → `bye` → fresh hello → launcher log
  `handed the page URL to …tdxlpp.8.toe` → companion **Connected to TDXLU**,
  `Paletteurl` readout shows the loopback URL (token stripped).
- The page renders live inside the Palette Browser with the real catalog
  (Toolbox row "Launcher Utility · local · ↳", desktop theme, session in
  the footer); `/api/palette/catalog` answers 1095 palette items + FNS
  manifest + store status + `patreon_connected`; `/api/palette/place`
  with a local `.tox` ran `load_tox` in the session (`ok: true`, landed in
  `/sys/quiet` because the current Network Editor pane was inside the
  utility — the desktop's own `load_tox` fallback, not a tabs issue).
- Tab strip: the widget's value-change script only fires for UI clicks, so
  the registry adds `fnspal_tabs_exec` (Parameter Execute on `Value0`); the
  callback lands one frame later — verify in a later frame, never in the
  same `execute_python`.

- Final layout (wired under `emptypanel`, see Pieces): tab row at the top
  (y 1030–1056 of a 1056-tall palette), the stock list or the web panel
  stacked right under it in the list's own slot (y 4–1028, 1024 tall), Web
  Render active and loaded at 300×1024 with the live page; identical docked
  or floating.

Verified 2026-08-23 after the move to `FNS_PaletteRegistry`:

- Host status `Registered: tdxlu -> /TDXLauncherUtility/TDXLUPalette/web`,
  `Tabs()` = `palette, tdxlu, patreon`, strip `Palette | TDXLU | Patreon`,
  mirrors `fnspal_tdxlu` / `fnspal_patreon` (layer 1, alignorder 2.5, wired
  to `emptypanel`), `web` sized by the slot expressions (300×1024).
- `ShowTab` round trip tdxlu → patreon → palette → tdxlu: stock list and
  mirrors flip `display` correctly, the browser is active only on the two
  launcher tabs, the ext's `_current_tab` follows, and the Toolbox page
  renders through the mirror (captured: `Launcher Utility · local · ↳`).
- Zero errors / warnings under `/TDXLauncherUtility`, 60 fps, no new
  hotspots.

Verified 2026-08-23, previews inside TD's CEF (Media + Collect lists):
a `.jpg` renders as a thumbnail, an **`.mp4` decodes and shows a frame**
(TD's CEF does carry H.264 here), a `.tif` — which no browser decodes —
falls back to its category glyph, and a missing file shows ✕. Ticket mint
refuses a non-media path (`Cursor.exe` → 415) and an unticketed
`/api/palette/media` is 401. `loading="lazy"` had to go: a row below the
fold never loaded at all.

Verified 2026-08-23, Commands sub-tab + update notice:

- Typing reaches the page: `webrender1.sendKey('l', char='l')` (the form the
  Keyboard In callbacks use — key *names*, digits as `ord`) fills the search
  field; `sendKey(ord('L'), …)` does not. The real-keyboard focus handoff in
  the docked dialog is still the one thing only a human at the desk can
  confirm.
- `/api/palette/commands` listed 38 commands (`CmdDemo` + TD built-ins,
  `rev 10`); **Hello** ran from the tab (toast `Ran Hello`, TD status bar
  `CmdDemo: hello from the quick launch!`); **Set status message** opened its
  inline form prefilled with the declared default, took a typed message +
  the `shout` toggle, and TD's status bar read `PALETTE TAB SAYS HI`.
- `companion` rides in the catalog (`0.21.0` / `0.21.0`, no notice). The
  banner markup was exercised with a stubbed catalog
  (`Companion 0.21.0 available · this session runs 0.20.0 · Update`) and
  clears on the next real load. **Not run live:** the Update button's
  `update_companion` — in the dev project it would repoint the live,
  externalized utility at the release copy; it is the desktop's existing
  `installBundledUtility` + `update_utility` pair, unchanged.

Still open:

- The ↳ click inside the rendered page has been driven through the API, not
  through `interactMouse` on the final build; the spike proved that input
  path on the same widget geometry.
- Building `TDXLUPalette` by re-importing it from `TDXLauncherUtility.tdn`
  (`TDNExt.ImportNetwork`) was followed twice by a hard TD freeze (main
  thread blocked, 0 CPU, no dialog). An untouched project does not freeze.
  The COMP is therefore rebuilt with plain `create()` scripts (the path that
  ran for 20 minutes without issue in the first session); treat TDN import of
  this module as suspect until proven otherwise.
- Embody's `Tdnlockedwarn` was switched to **quiet** on the dev project's
  Embody COMP: the "Locked Content Warning" modal (about the locked `icon`
  and `ui_mod/null2` TOPs, pre-existing) blocks TD's main thread on every
  root TDN re-export, which an unattended `externalize_op` triggers.
- The strip is TD's shipped widget
  (`Samples/Palette/UI/Basic Widgets/folderTabs.tox`), loaded by the
  registry at sync time — a TDN round-trip of the widget internals comes
  back broken (missing `menuOptions` callbacks, unconnected outputs), so no
  copy of it is kept in the project.

### Shipping checklist

1. All `.py` DATs are externalized (`externalizations.tsv` rows under
   `TDXLauncherUtility/TDXLUPalette/` and
   `TDXLauncherUtility/FNS_PaletteRegistry/`); the project was saved with
   `Palettetabs` on. The stamped host inside `TDXLUPalette` is a snapshot
   copy — re-stamp it after editing the master's extension.
2. Re-export `release/TDXLauncherUtility.tox` per `utility-tox-reexport-recipe`
   (utility is 0.21.0 in both `UTILITY_VERSION` and the ext) and verify the
   staged copy carries an empty `Url`, no stored `TDXLU_palette_url`, an
   inactive `web/webrender1`, `web` back at constant 314×1024, and both
   registry copies inert (no `/sys` storage, blank `Regstatus`, no
   `opshortcut`, master Registration pars at defaults) — the `pre_release`
   hooks do that.
3. macOS: run the spike checks once (Web Render TOP inside `/ui`, DPI scale).

## Decisions / open points

- **One shared browser** for both web tabs (route switch), not one per tab.
- **Click-to-place, not drag** (texture can't be a drag source) — see above.
- **Published through `FNS_PaletteRegistry`, re-applied every session**: `/ui`
  is never saved with a project and `/sys` is rebuilt on open, and that is a
  feature (a project opened without the utility shows a stock palette). The
  registry is generic on purpose — native panels only, no web dependency —
  so other FNS tools can add tabs. **The port back to FNSTools landed
  (2026-08-23): that copy is now canonical** and this project consumes it
  (the embedded copy inside `TDXLUPalette`); the master this repo used to
  carry is gone. The ported version adds a **`Tab` sequence** on the host, so
  `patreon` is now DECLARED beside `tdxlu` on the one stamped host instead of
  being registered from `TDXLUPaletteExt` — a block with no `Source` reuses
  the primary panel. See [fns-palette-registry.md](fns-palette-registry.md) §8
  for what the swap cost (version takeover, Embody move detection).
- **Entitlement**: the push is gated like its sibling companion features. The
  TD-side tabs still install without a launcher; the TDXLU/Patreon tabs then
  show a "start TDX Launcher Ultra" placeholder.
- Open: keyboard focus handoff inside the Palette Browser (TD gives panels
  focus on click; the Keyboard In DAT is active only while `panel.focus`),
  and macOS validation of the Web Render TOP inside `/ui`.
