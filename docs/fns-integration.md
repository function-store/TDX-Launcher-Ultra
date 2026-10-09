# FNSTools integration — design record

Marrying the launcher with the FNSTools packaging system
(FNSTools `packaging/`, design record
`docs/ConfiguratorDistribution.md` there). That document's §2.3 rail 2 and
§4 step 4 name this exact feature as the open work: *"TDXLU store panel
over the `load_tox` bus"*. This file is the launcher-side half of the
contract.

## What the FNS side already provides (consumed, not built)

- **A bucket** — `https://storage.functionstore.tools/fnstools/manifest.json`
  is the ROLLING manifest (currently v3.0.1): 45 packages with category /
  description / `version` (the governed `Pkgversion`) / `help_url` /
  sha256-pinned artifact URLs, a 7-package `core` list, `category_meta`
  (glyph + pitch per category), and `rails` (sha256-pinned
  `FNSTools.tox` one-drop bootstrap + bare `FNS_Installer.tox`).
  Releases are pinned; the rolling copy only answers "what is current".
- **The palette folder** — `<user palette>/FNSTools/` is the toolkit's
  machine-wide folder (contract: [PaletteFolderContract.md](https://github.com/function-store/FNSTools/blob/main/docs/PaletteFolderContract.md),
  2026-09-18). It replaced `FNStools_ext`; `fns_palette_dir()` in
  `src-tauri/src/fns_store.rs` migrates a legacy folder into place the
  first time it is resolved (rename when lone, merge orphans when both
  exist), the same steps the toolkit runs, whoever gets there first.
- **The palette store** — `<user palette>/FNSTools/store/` is by
  contract a MIRROR of the bucket (nothing in it is anyone's work; stale
  files are re-fetched, never preserved). Both FNS rails (installer,
  FNS_Updater) read it, and artifacts resolve *beside whichever manifest
  is read* — so a store the launcher stocks is indistinguishable from one
  FNS_Updater stocked.
- **The installer contract** — `FNS_Installer` (inside the bootstrap
  container) takes a `selection.json`
  (`{schema:1, toolkit, core:[], tools:[], install:[]}`), resolves a plan
  against the store manifest, downloads nothing when the store is
  stocked, and **treats manifest tools present-but-unselected as removal
  candidates** (the picker edits project state). Core is never optional.
- **Global settings** — `FNS_ConfigRegistry` persists every tool's
  settings to `<user palette>/FNSTools/config/FNStools_config.json`
  and serves an **ephemeral settings HTTP server** (first free port in
  9871–9880, idle-stopped after 10 min): `GET /api/state` (tools + par
  metadata: label, style, menu entries, min/max, help, readonly for
  non-constant modes) and `POST /api/set {tool, par, value}` (validated,
  persisted via `SaveTool`). This is the *live* configurator; the JSON
  file is the *offline* one.
- **Standalone drops** — since v3.0.1 every package resolves through its
  own global shortcut and works as a single dropped `.tox` without the
  toolkit root. That is what makes a per-component Toolbox shelf valid.

## The three launcher features

### 1. FNS store + installer (new **FNS** tab)

`src/FnsPanel.tsx`, a mostly self-contained tab (Patreon-tab pattern).

- **Catalog**: `fns_manifest_cmd` fetches the rolling manifest (pref
  `fns_base_url`, default the bucket), caches it under
  `<config>/fns/manifest.json`, serves the cache offline. Categories
  render in manifest order with their glyph + pitch; core shows as one
  pinned "installed as a unit" block.
- **Store**: `fns_store_status_cmd` reports which artifacts sit in the
  palette store and whether their sha256 matches the manifest (stale =
  re-download, per the mirror contract). `fns_sync_store_cmd(names?)`
  downloads manifest + artifacts (+ rails) into the store,
  sha256-verified, `.partial`→rename, `transfer-progress` events
  (`op_id:"fns-store"`).
- **Install into a session**: target picker over live sessions with the
  companion (same source as the Load-tox-into bar). Flow:
  1. sync the needed artifacts + bootstrap rail into the store;
  2. `fns_write_selection_cmd(tools)` → `<user palette>/FNSTools/selection.json`
     (root level, the installer's own default; never inside the purgeable store);
  3. utility bus `fns_install` (new verb, below) — finds or bootstraps
     the `/FNSTools` root and pulses `FNS_Installer` on the selection;
  4. poll `fns_status` for the result (root, packages + Pkgversions).
  Because unselected tools get REMOVED, the panel pre-checks the target
  session's installed tools (from `fns_status`) and the confirm step
  lists adds *and* removals explicitly.
- **No session / no companion**: "Copy Textport script" emits the same
  one-line paste rail the FNS website emits (names-only; release, URLs
  and hashes resolve from the rolling manifest at paste time), so the
  launcher is never a dead end.

### 2. Global configurator (Settings view of the FNS tab)

Two modes, chosen by what's reachable:

- **Live** (preferred): a session reports FNS present → utility verb
  `fns_settings_url` ensures the ConfigRegistry settings server is up and
  returns its URL; the launcher proxies `GET /api/state` /
  `POST /api/set` through Rust (`fns_settings_state_cmd` /
  `fns_settings_set_cmd`, 127.0.0.1-only) and renders a native editor
  with the full par metadata. Writes go through `UiSet`, so validation,
  persistence and live application are all TD's — the launcher cannot
  fight a bind or an expression.
- **Offline**: no live session → edit
  `FNStools_config.json` directly (`fns_config_read_cmd` /
  `fns_config_write_cmd`, atomic write). Only CONSTANT-mode pars are
  editable; BIND/EXPR pars and the `Cf*` registration plumbing render
  read-only/hidden. Tools re-apply their section on next load
  (ConfigRegistry autoload), so offline edits land on the next TD start.
  The editor refuses to write while a live session is detected (a live
  `SaveAll` would clobber it — the live path exists for exactly that).

### 3. Toolbox shelf of standalone components (Palette tab)

`src/FnsToolboxSection.tsx`, rendered next to the user Toolbox, and its
twin `FnsShelf` in the in-TD palette page: every manifest `tool` package as
a row (grouped by category), with
- **place / install** into the target session, by the package's manifest
  `placement` (2026-09-19, following the toolkit's OpAlternatives and
  placement contracts): `pane` and `none` (the FNS operator family) drop
  into the pane as a frozen instance (`load_tox` on the store artifact);
  `root` and absent are installs and go through FNS_Installer with a
  minimal one-package selection (`write_selection(.., minimal=true)` +
  the companion's `fns_install`; additive, recorded, bootstrap dropped
  first when the project has no toolkit root). One branch, in
  `palette_tabs::place`; the desktop shelf reaches it through
  `fns_place_cmd`. Rust `placement_lands_in_pane` and TS
  `packageLandsInPane` must stay in step.
- an **alternative for …** hint on packages with `alternatives_for`: TD
  offers them in the OP Create dialog (alt+ctrl) once the tox is in the
  store, so the shelf's download is what enables that,
- **OS drag out** when the artifact is present in the store,
- **download** on demand when it isn't (`fns_sync_store_cmd([name])`).
This is a *virtual* section fed by manifest + store status — it never
writes rows into the user's `toolbox_tools` config, so it cannot drift.

## Utility TOX additions (0.8.6 → 0.9.0)

New bus verbs in `TDXLUUtilityExt` (+ Envoy mirrors in `mcp_bridge.rs`,
+ rows in `utility/heartbeat/PROTOCOL.md`):

| Verb | Params | Does |
|---|---|---|
| `fns_install` | `selection` (path), `bootstrap` (path), `parent?` | Find `/FNSTools`; if absent, `LoadTox(bootstrap)`; set `Selectionfile`, deferred-pulse `Install`; reply immediately (`started`) |
| `fns_status` | — | Toolkit root present?, installed packages + live `Pkgversion`s, installer `Status`, ConfigRegistry present? |
| `fns_settings_url` | `ensure?` | Ensure the ConfigRegistry settings server is active (no browser open) and return its URL |
| `fns_commands` (0.11.0) | — | Tool-registered quick-launch commands from `FNS_CommandRegistry`: `{ok, rev, commands}`; 0.12.0 adds per-command `params` (declared user arguments) |
| `fns_run_command` (0.11.0) | `key`, `args?`, `kwargs?` | Execute one registered command via the registry, relaying the tool's result; 0.12.0 coerces declared params in `kwargs` by style (strings ok) and fills defaults / refuses missing required |

### FNS_CommandRegistry (0.11.0)

Runtime command registry in the family shape of the FNS registries: ships
inside the companion tox, promotes a global copy into `/sys` that claims
`op.FNS_COMMANDREGISTRY`, version-replaces older globals (migrating
registrations), dormant shippers forward. Tools announce commands at
runtime (guarded — see `docs/fns-command-registry.md`, the standalone
contract for the FunctionStore_tools side); the quick-launch overlay
lists them under `>` and the dedicated `?` prefix (`quick_prefix_tools`)
and executes over the bus. The registry is deliberately a generic API
layer — any in-TD consumer can call `Commands()` / `Run(key)`.

Gathering is summon-driven (each palette open refetches, cached
module-side) PLUS hello-driven: when a utility peer freshly appears on
the bus (launcher started after TD, companion injected, or reloaded),
`watch.rs::apply_hello` emits a `utility-hello` event and the quick
window prefetches that session's commands (~1.5s later, letting the
registry's init rescan and the tools' deferred registrations land), so
the first summon opens warm. `WatchManager::set_app` hands the hub its
AppHandle at setup so bus events work before any Watch session starts.

The summon is focus-aware: `show_quick_window` captures the foreground
pid BEFORE the overlay shows (`session_windows::foreground_pid` —
Win32 `GetForegroundWindow`, macOS `NSWorkspace.frontmostApplication`;
any TD window counts, floating panes included) and sends it in the
`quick:open` payload. The summoned-over session ranks first (session
row, verbs, tool commands) and receives place-a-tox. Tool commands with
the same key across sessions merge into one row; a sole candidate or
the summoned-over session resolves the target silently, otherwise Enter
descends into a session picker listing the candidate projects (Esc
backs out to the view it was entered from).

Commands with declared `params` prompt for their arguments after the
target resolves (typed params via the input, menu/toggle via option
rows, Esc/← steps back with values restored) — or take them inline:
trailing query tokens that miss the command name map onto the params in
order ("? rec 1" → `seconds=1`, run on Enter when the rest is covered
by defaults; partial inline values pre-fill the prompt).

Registry 1.4.0 / utility 0.16.0: `builtin` spec/decorator flag — TD/
system commands badge COMMAND in the palette, rank in `>` after
third-party tool commands, and stay out of the `?` tools listing; the
seen-catalog and curation carry the flag through.

Built-in TD commands (0.15.0, restructured 0.17.0): the companion ships
`TDX_BuiltinCommands` holding two owners — `TD_Dialogs` (22: every
`ui.open*` dialog, pane maximize/tear-away/floating-copy/type-change
with a 9-entry PaneType menu, show-op-in-pane, home view) and
`TD_Session` (16: save / save+toxes, load-recent by index, quit,
realtime/perform/on-top/perform-on-start toggles, cook rate + master
volume, project & TD folder openers, selected-op path/params/viewer).
Both import the shared `FNSCommand` module from the companion's ExtUtils
via `op.TDXLU` (one source of truth — no vendored copies) and brand
`builtin` once through `functools.partial`. Every API name verified
against the live runtime; `set cook rate` and `toggle power` default
hidden. They work in projects with zero FNS tools. Survey/status
ledger: FunctionStore_tools_PUB/docs/CommandRegistryCandidates.md.

Registry 1.7.0 / utility 0.22.0 (2026-08-30, the FNSTools Plus work
order's P0 — docs/fns-plus-capabilities.md): commands may declare
`surface` (a token list naming consumer surfaces — `quick` default,
`session` = Current-view companion bar, `context-menu` = session
right-click; shape-validated only, consumers ignore unknown tokens) and
`capability` (a blessed-capability id like `fns.collect` letting a
consumer swap in rich native UI). Both ride the wire only when
declared; absent = 1.6.0 behaviour exactly. Decorator gains the same
kwargs; harvest carries them through. Master FNSCommand.py in
FunctionStore_tools needs the same two-kwarg addition (port note in
the work order).

Registry 1.5.0 / utility 0.18.0: promoted global moved into the shared
registry home `/sys/FNS_Registries` (FunctionStore's
RegistryHomeContract.md — location only, no API change; shortcuts
resolve from any depth so consumers see nothing). The shipper creates
the bare home on promotion only, scans both homes for peers, and
relocates a legacy bare-`/sys` global regardless of version so the two
homes never both hold a live copy.

Registry 1.6.0 / utility 0.19.0: live state chips + param prefill
(FunctionStore's CommandStateProposal.md). Commands declare `state`
('Parname' or {'method': 'GetX'}) and params declare `current`; the
registry evaluates them at QUERY time inside every Commands() build —
never stale, no re-registration, no rev churn; failures just omit the
key. Wire: `item.state` = bool or trimmed string (%g floats);
`param.current` likewise. Palette: ON/OFF/value chip after the label
(merged rows chip the resolved session's value or the unanimous one),
typed-param prompts open pre-filled from `current` (single-param
commands reuse `state`), menu/toggle option rows mark "current", the
footer hint shows "(now X)". First adopters: seven TD_Session built-ins
(realtime, perform, on-top, perform-on-start, power, cook rate, master
volume) via promoted-but-undecorated getter methods.

Presets (launcher-side only, no wire change): `quick_command_presets`
pref — user-authored aliases (`{label, target: "tool#id", kwargs}`) over
registered commands. They render as PRESET rows grouped first under `?`
with their chips pre-filled, run immediately when the remaining params
are covered by defaults (else the arg prompt continues pre-seeded),
resolve sessions/focus/picker like any command, bypass visibility
curation (authoring one IS the opt-in), and go dormant when the target
isn't live. Authored in Settings → Quick Launch: the editor's fields
generate from the seen-catalog's stored param specs (text / menu select /
on-off), so presets are authorable offline.

Registry 1.11.0 (FNSTools v3.2.15, companion carries it since 0.23.2):
multi-instance tools. Commands may carry `instance` (the owner's
`FnsInstance()` label); rows read `label · instance`, preset targets accept
`tool#id@instance`, and the seen-catalog records `instances` so a preset can
be pinned offline. Favourites and visibility stay per `tool#id`.

Registry 1.3.0 / utility 0.14.0 adds command curation: a `hidden` spec
field (tool-declared default visibility, decorator kwarg too) rides the
wire; the launcher stores sparse user overrides keyed on `tool#id`
(`quick_hidden_commands` / `quick_shown_commands` prefs), renders a
curation checklist in Settings from a seen-commands catalog (localStorage,
written by the quick window on every fetch — curatable with no session
live), and the palette filters by effective visibility (user override,
else spec default). The registry stays taste-free: it always reports
everything, so other consumers can curate differently.

Registry 1.2.0 / utility 0.13.0 adds the decorator contract: a
`_fns_command` dict attribute on a promoted method IS a command;
`Register(owner)` with no list harvests them (label/help/params derived
from name, docstring and signature — `typing.Literal` → menu) and
auto-tags the owner, `RescanTools` harvests tagged COMPs without
`FnsCommands()`, and the `FNSCommand` ExtUtils module (master in
FunctionStore_tools at `FNSTools/CustomParTools/QuickExt/ExtUtils`,
copy in the companion's ExtUtils) ships `fns_command` + `announce()`.

Old-companion fallback: an unknown action comes back `ok:false`, which
`run_utility_action` already converts to the Envoy fallback — and the
Envoy mirror executes the same logic through `op.TDXLU`, so a session
needs *either* companion ≥0.9.0 *or* Envoy for the new verbs. The panel
offers the existing companion-update flow when both are missing.

## Freemium

**The entire FNS surface is free** (owner decision, 2026-08-19): the
toolkit is free software and the launcher is just a nicer front door to
its own installer and settings server — gating it would charge for
someone else's tools. ~~Concretely: the `fns_*` verbs and the settings
proxies skip `require_entitled()`, and `load_tox` — normally Pro — is
free when the artifact lives inside the FNS palette store; a generic
`load_tox` from anywhere else stays Pro.~~ **Superseded 2026-08-31**
(docs/fns-plus-capabilities.md D3 executed): the WHOLE companion verb
surface is free — the per-verb allowlist and the store carve-out are
gone; pro capability gates at Plus-package STOCKING on the toolkit
rail. The launcher now also reads the manifest's Plus machinery
(`access` tier ids, `toolkit.tiers` labels, `support_url`): gated rows
badge with their tier label, lock when the claim doesn't name them,
and stock through `POST /token/download` + Bearer when it does.

## Non-goals (v1)

- `tdxlpp://` deep links (the FNS configurator site could hand off to
  the launcher one day; separate change, needs `tauri-plugin-deep-link`).
- Editing ConfigRegistry `state` tables (hotkey tables etc.) offline —
  shown as counts only.
- Per-package update orchestration — FNS_Updater owns updates inside TD;
  the launcher shows version drift (manifest vs `fns_status`) and can
  re-run an install, but does not replicate the updater.

## Status (2026-08-19, built overnight on `fnsing`)

Everything above is implemented. Verified:

- `cargo check` + `cargo test` (110 pass), `npm run build`, `npm run
  build:demo` all green.
- The whole UI flow exercised in the browser demo (`npm run dev:demo`):
  catalog render, session pre-selection, +N/−N confirm, install →
  poll → settle, live settings view, FNS shelf states (present / stale /
  fetch).
- The rolling manifest fetch verified against the real bucket (v3.0.1,
  45 packages, rails present).
- Utility 0.9.0 hot-synced into the live utility project;
  `fns_status` / `fns_settings_url` / `fns_install` answered correctly
  **over the real TCP bus** (raw socket, launcher-identical envelopes),
  including graceful errors on a toolkit-less project.
- `release/TDXLauncherUtility.tox` re-exported via Embody's
  `ExportPortableTox` from the live session and inspected: carries
  0.9.0, the new dispatch, stripped file refs.

**Still untested end to end**: a real FNS install into a fresh project
via the panel. Deliberately not run against the utility dev project —
a live install promotes the FNS registries into that session's `/sys`
(and per the FNS docs, install tests belong in a cooking-disabled
container, which the panel flow can't target). First real use: launch a
scratch project with the companion (0.9.0), open the FNS tab, install a
small selection. The utility R2 channel also still ships 0.8.6 — run
`npm run release:prepare-utility` + `release:publish` (user action) when
ready.

## Files

| Piece | Where |
|---|---|
| Rust store module | `src-tauri/src/fns_store.rs` (pattern: `updates.rs`) |
| Commands + registration | `commands.rs` + `lib.rs` `generate_handler` |
| Prefs | `config.rs` `fns_base_url` (+ `PREF_KEYS` export) |
| Envoy mirrors | `mcp_bridge.rs` `utility_action_code` |
| TS API + types | `src/api.ts`, `src/types.ts` |
| Store tab | `src/FnsPanel.tsx` (+ `TabId` union, tab bar, content switch) |
| Toolbox shelf | `src/FnsToolboxSection.tsx` in the Palette tab |
| Utility verbs | `utility/TDXLauncherUtility/TDXLUUtilityExt.py` + PROTOCOL.md + `UTILITY_VERSION` |
| Demo mocks | `demo/mock/backend.ts` (fake manifest, canned store status) |
