---
status: work order, executed except the companion-verb removal (ledger in §7; refreshed 2026-09-11). P0-P5 done on the launcher side; what is left is P6 on the companion. This is the "FNSTools Plus integration work order" that fns-gate.md §8.8 announces.
summary: Decouple pro capability from the launcher into FNSTools Plus packages. The Current view stops hard-coding session controls and becomes a consumer of capabilities advertised by the live session (FNS_CommandRegistry, extended with a surface/capability vocabulary). Gating flips from launcher-side require_entitled to possession-at-stocking on the toolkit rail. Mobile control becomes a standalone TD-side package (fns-gate.md §4.1's exception clause, first real instance); the launcher's control server survives rescoped to fleet operations plus hand-off links.
since: 2026-08-30, out of the pro-decoupling conversation on branch dev
depends-on: docs/fns-gate.md §1–§3 (the licensing rail this rides), the toolkit's fnstools/plus/ gated prefix (live), FNS_CommandRegistry ≥ 1.6.0 (utility 0.21.0 ships it)
related: docs/fns-integration.md, docs/fns-command-registry.md, docs/fns-palette-registry.md
---

# FNSTools Plus — capability injection into the launcher

## 0. The thesis

Today the launcher bakes in every session control (collect, save, media,
phone remote, …) and gates the pro ones itself (`require_entitled` +
the free-verb allowlist). The target shape inverts both:

* **The vanilla launcher has no pro session capability at all.** A
  capability exists in the Current view only because something in the
  *session* advertises it at runtime. The launcher renders what it is
  told, the way the quick-launch overlay already renders
  `FNS_CommandRegistry` commands.
* **The thing that advertises is an FNSTools Plus package** delivered on
  the toolkit's existing gated rail (`fnstools/plus/` + the entitlement
  claim). The gate is at *stocking* time; a project file carrying the
  package works for whoever opens it — "purchase gate, not DRM"
  (fns-gate.md §4.4), carried to its conclusion.
* **The utility tox stays thin**: transport (bus + heartbeat), the
  registry shippers, `load_tox`, and the generic `fns_run_command`
  execution path. Feature verbs migrate out.

The injection mechanism is ~90% built: `FNS_CommandRegistry` already
gives runtime announcement from any COMP, params with styles/menus/
coercion, live state chips (`state`/`current`, registry ≥ 1.6.0),
`hidden`/`builtin` curation, stable `tool#id` identity, session merging
— and its wire (`fns_commands`/`fns_run_command`) is already on the
free allowlist (`commands.rs` ~759–799). What is missing is a placement
vocabulary and a Current-view consumer.

## 1. Facts on the ground (verified 2026-08-30)

Anchors are as of `dev` @ 544b7f7; line numbers drift, descriptions don't.

* **The Current view is hand-written, four times over.** Companion bar
  `src/App.tsx` ~7878–8140 (Save/Autosave/Collect/Snapshot/Record free;
  Load ▾ and Ensure-env pro); toolbar panel chips ~6946–7005 (Control
  and Perf pro, Media free) mirroring `PANELS`/`togglePanel`
  ~5435–5501; session detail pane ~8274–8407; context menu
  `sessionMenu()` ~4886–5032 (which alone carries `Repoint assets…` and
  `Open media panel`). Gating is re-expressed in each; `Watch` is pro
  in two surfaces and free in the detail pane (~8354 vs ~4958, ~6940) —
  an inconsistency the rewrite deletes rather than fixes in place.
  Companion presence is a binary swap of the whole bar, not per-button.
* **Nothing in Current is registry-driven.** `fns_commands` is consumed
  only by the quick window (`src/quick.tsx`, prefetch on the
  `utility-hello` event, `Rev()`-cached) and the in-TD palette tab
  (`palette_tabs.rs`). App.tsx touches the registry only in Settings
  curation.
* **Capability discovery is implicit.** `hello` advertises
  `id`/`cmd_port`/`utility`/version only (`utility/heartbeat/PROTOCOL.md`,
  `watch.rs` peer record); consumers probe verbs and treat
  `unknown action` as absence. The frontend never version-compares
  (`openUtilityVersion` is read only for the "Update utility" button).
* **One Rust command carries all companion verbs**
  (`open_project_utility_cmd` → `run_utility_action`, TCP bus first,
  Envoy fallback). Free verbs are a hardcoded allowlist (~759–799,
  both `fns_commands` and `fnscommands` spellings needed); `load_tox`
  is free only when the artifact is inside the FNS palette store.
* **Collect is a two-phase flow**, not a fire-and-forget verb:
  `collect_save {dry_run:true}` → plan → confirm modal (per-file
  include list + freeze-expressions toggle) → `collect_save
  {include, expressions}` → poll `collect_status`.
* **Mobile today is one global launcher-hosted server**
  (`src-tauri/src/control_server.rs`, tiny_http, default port 11997,
  loopback unless `control_server_lan`, two machine-wide bearer tokens
  in the URL fragment, client tier server-enforced by route allowlist).
  The page (`control.html` → `src/control-standalone.tsx`) shows
  per-session *tabs* — a workaround for the server being global.
  Pro-gated at the start/link-minting commands, not per request.
* **Touch relay targeting gap**: `touch_relay.rs` `connect_td`
  (~62–73) port-scans 12100–12199 and takes the first companion that
  accepts — untargetable with two live sessions. (Dissolves under D4.)

## 2. Decisions

### D1 — Capability injection rides FNS_CommandRegistry, extended

Registry spec (bump to 1.7.0) gains two optional fields per command:

| Field | Meaning |
|---|---|
| `surface` | List of consumer surfaces the command wants to appear on. Known values today: `quick` (the default when absent — exact current behaviour), `session` (the Current view's companion bar area), and `context-menu` (the session right-click menu — in scope from P1, owner call 2026-08-30). Future values are additive; consumers ignore unknown entries. |
| `capability` | Optional well-known id (e.g. `fns.media-browser`, `fns.collect`, `fns.mobile-control`) marking this command as part of a *blessed capability* (D6). Consumers that recognise the id may swap in rich native UI; ones that don't render the command generically. Namespaced, stable forever — it becomes UI identity the way `tool#id` already is. |

Both ride the existing `fns_commands` wire untouched (fields are simply
present or absent, like `hidden`/`builtin`/`state` before them). No new
PROTOCOL.md verbs, no Envoy mirror changes, no allowlist edits. The
decorator (`@fns_command(surface=['session'], capability='fns.collect')`)
and the explicit-spec path both carry them.

Rejected alternative: a `caps` list in `hello`. It would duplicate the
registry as a second source of truth and need protocol + peer-record
changes; the registry already survives companion updates, migrates
registrations across version replacement, and handles late arrival via
the `fnscommands` tag rescan. `hello` stays minimal.

### D2 — The Current view becomes a registry consumer

* On session selection and on the `utility-hello` event (the prefetch
  plumbing the quick window already uses), fetch `fns_commands` for the
  selected session; cache against `Rev()`.
* Render `surface: session` commands into the companion bar area,
  grouped by tool, using the machinery the quick window already has:
  label + help, live `state` chips (ON/OFF or value), `params` prompt
  flow, `hidden` + user curation honoured (same `quick_hidden_commands`
  / `quick_shown_commands` identity — one curation store, two surfaces).
* Execution goes through the existing `fns_run_command` path and the
  existing result/footer handling.
* **What stays hardcoded**: launcher-native *process* operations that
  act on the OS process, not through the session — Focus / Reveal /
  Kill / Relaunch / Dismiss / Watch, the companion-not-loaded drop
  panel, and the Update-utility button. Everything that talks *through*
  the bus is a candidate to become a registered command.
* **Endgame**: even Save can ride the rail — `TDX_BuiltinCommands`'
  `TD_Session` owner already registers save/save-toxes as `builtin`
  commands; giving those `surface: ['quick','session']` makes the bar
  registry-driven end to end. The four-way duplication (bar / chips /
  PANELS / context menu) collapses to one render loop + one gate story.
* **Three-state UX** replaces the binary swap: no companion → drop
  panel (unchanged); companion, no Plus packages → builtins only (thin
  bar); companion + Plus → full bar. State 2 is the dormant-slot
  contract and gets an explicit test (§5, gate G2).

### D3 — Gating flips to possession-at-stocking

For every capability that moves to a Plus package, the launcher
**stops gating the action**. The capability simply does not exist in a
session without the package, and the package's bytes were gated when
they were stocked (toolkit rail, `fnstools/plus/`, entitlement claim —
all live per fns-gate.md). Consequences:

* The free-verb allowlist stops growing — new capability arrives as
  registry commands over `fns_run_command`, which is already free.
* `require_entitled` call sites for moved features are **deleted**, not
  relocated (phone remote's four sites among them, D4/D5).
* Consistent with fns-gate.md §7: a lapsed/offline/signed-out user
  keeps every package already stocked; they lose only the next version.
* The launcher's remaining pro surface is genuinely launcher-native
  (Patreon browser, backups, git, GPU affinity, …) — untouched here.

### D4 — Mobile control is a standalone FNSTools Plus package

The standalone requirement ("works with only TD running") triggers
fns-gate.md §4.1's exception clause verbatim: this is not a companion
module, it is an FNSTools package on the toolkit's rail. First real
instance of that clause. Shape:

* **TD-side server**: the package carries a Web Server DAT and serves
  its own mobile page. Page assets ship *inside the package*, so page
  and server version together and update via FNS_Updater — the
  launcher-page-vs-companion skew problem never exists. The launcher
  stops bundling `control.html` for session control.
* **Per-session by construction**: each session with the package runs
  its own server on the first free port in a declared range (the
  ConfigRegistry 9871–9880 pattern). One session = one origin = one
  link/QR. No token-scoping machinery — the server *is* the session.
  The page loses its session tabs; scope is honestly this-session:
  control-page params, save/snapshot/record, touch, this session's
  perf.
* **Touch terminates in the session** that serves the page — the
  launcher-side relay and its first-companion-wins port scan are
  retired for this path.
* **The ExtAuth lessons are build requirements, not advice**
  (fns-gate.md §4.2 records both):
  1. **Explicit Local Address, always.** Blank = all interfaces is the
     documented trap. Loopback by default; LAN is an explicit opt-in.
  2. **Async transport discipline** — quick callbacks, no blocking I/O
     in the serve path, Web Client DAT patterns where the package
     itself fetches.
* **Activation and credentials are machine-local, never
  project-local.** Enable flag, LAN flag, and bearer token live in
  `<user palette>/FNSTools/config/` via FNS_ConfigRegistry — the
  same "credential never travels, never lives where a cleaner deletes"
  doctrine as the shared gate-session file. A traveling `.toe` carries
  the capability *dormant*: on a foreign machine it is off, LAN-less
  and token-less until that user activates it. This is what makes
  "advertised by the live project file" safe.
* **Auth pattern unchanged**: bearer token in the URL fragment,
  localStorage for PWA relaunch, constant-time compare, possession of
  the URL is the gate (same posture as today's launcher server).
* **Pairing without the launcher**: the package registers a palette
  tab (FNS_PaletteRegistry — the PhoneDrawer precedent, minus its
  `palette_tabs.rs` backing) showing its own QR/URL in TD. **QR is
  generated by a tiny inline JS library in the package's own pairing
  HTML** (decided 2026-08-30), rendered via the Web Render tab — no
  Python dependency, no TD-env verification, and the same code serves
  the phone page.
* **Advertisement**: capability id `fns.mobile-control`, with an info
  command (e.g. `mobile.info` → `{active, url, lan}`) the launcher and
  the fleet page read to render QR / hand-off links (D5).

### D5 — The launcher's control server survives, rescoped to fleet

Fleet control from the phone is kept (owner call, 2026-08-30): list
sessions, launch a recent project, kill / relaunch / dismiss / focus —
the OS-process operations only the launcher process can perform.
`control_server.rs` shrinks to exactly that:

* **Routes that stay**: `/api/app`, `/api/sessions`, `/api/sessions/
  kill|dismiss|focus|relaunch`, `/api/recents` + `/api/launch`,
  `/api/sessions/perf` (process CPU/RAM is OS-level).
* **Routes that leave** (their job moves to the per-session package):
  `/api/sessions/action` (save/snapshot/record), `/api/control/*`,
  `/ws/touch` + `touch_relay.rs`. The `/api/palette/*` surface is a
  separate concern (in-TD palette tabs) and is out of scope here.
* **The hand-off is the glue**: each `/api/sessions` entry gains an
  optional `control_url` — present when that session advertises
  `fns.mobile-control` and is active. The launcher learns it over the
  loopback bus (the `mobile.info` command) and the fleet page renders
  "open control surface" per session. Tap → the session's own origin
  and token. Launch-from-fleet composes: launch a recent, watch it
  appear in the list, follow its control link once the package inside
  it comes up. The fleet token and the per-session tokens stay
  independent (different trust scopes: fleet = this launcher install,
  session = this project on this machine).
* Client tier: fleet is inherently author-ish (it kills processes) —
  the fleet page is **author-token only**. The restricted-link concept
  moves conceptually to per-session pages, where it is deferred past
  P4 v1 (§6.7); the current `client_route_allowed` split maps poorly
  onto the rescoped route set and retires with it.
* **Fleet is FREE** (owner call, 2026-08-30). The story reads clean:
  fleet is free, per-session control is a Plus capability — the fleet
  page alone cannot control a session without a Plus package
  advertising a surface. The `require_entitled` sites on the
  server-start/link commands are deleted with the rest (§3).

### D6 — Blessed capabilities: rich launcher UI for known ids

Generic rendering (a button; a params prompt; a state chip) covers
simple commands. Flows that need real UI get **blessed capability
ids**: the launcher recognises the `capability` value and swaps in a
native rich modal, driving the tool through *registry commands with
agreed ids and structured returns* (`Run` already relays
JSON-serializable dicts). Unknown consumers — and old launchers — fall
back to whatever generic rendering the commands allow. Progressive
enhancement; the registry stays taste-free.

First two blessed capabilities (**concrete contracts as built, P2**):

* **`fns.collect`** — the owner registers exactly: `collect` (the
  visible entry, `surface: [session, context-menu]`, baked
  `kwargs {dry_run: true}` so a generic consumer's run is a harmless
  dry-run plan → the CollectPlan dict), `apply` (hidden; caller kwargs
  `{dry_run: false, expressions, include}`), `status` (hidden; poll).
  The launcher's existing confirm modal (per-file checkboxes,
  freeze-expressions toggle, include-list discipline so files appearing
  between scan and apply are not swept) is kept and re-pointed at these
  keys; kwargs ride as real JSON so `include` lists and bools survive
  both the TCP bus and the Envoy mirror. First registrant:
  `TDXLUCollectExt.FnsCommands()`.
* **`fns.media-browser`** — the owner registers: `media` (visible
  entry; generic run just lists refs), plus hidden `list`, `replace
  {ref, path}`, `sync_timeline {ref, timeline}`, `probe {ref}`,
  `unreferenced {subfolder}`, `pick_replace {ref}`, `pick_status` —
  1:1 with the legacy `media_*` verbs, same kwargs keys, same reply
  shapes. The launcher's MediaPanel is the blessed UI (a `commandKeys`
  prop routes it down the command rail when advertised, legacy verbs
  otherwise). First registrant: `TDXLUMediaExt.FnsCommands()`. **Previews ride as local
  filesystem paths in command results** (decided 2026-08-30): launcher
  and TD share the machine, so commands return paths and the launcher
  reads the files directly — zero transport. Caveat to honour in P2: a
  preview that must be *generated* (a TOP capture rather than an
  existing media file) is the tool's job — capture to a temp/cache
  path and return that path; the launcher never asks TD for bytes. A
  missing/unreadable path degrades to a placeholder tile, never an
  error.

A standardized long-job pattern (a generic `job: true` +
status-command convention, so unknown job-shaped tools get a generic
progress UI) is **deferred** until a second job-shaped tool exists;
`fns.collect` is blessed bespoke first.

### D7 — Thin utility, with a deprecation window

Feature verbs migrate to Plus packages as registry commands. The
utility keeps: heartbeat + bus, registry shippers
(FNS_CommandRegistry, TDX_BuiltinCommands, the palette registry host),
`load_tox`, `update_utility`, and `fns_*`. Bespoke verbs
(`collect_save`, `collect_status`, `media_*`, `repoint_assets`)
answer for **one deprecation version** after their package equivalent
ships (companions in the wild lag), then drop from the utility and
PROTOCOL.md. **Autosave stays free as a builtin command** (decided
2026-08-30): it guards user work, so it migrates to
`TDX_BuiltinCommands` with `surface: ['session']` rather than to a
Plus package — the `autosave_*` bespoke verbs still retire on the same
deprecation schedule.

## 3. What this deletes

* The pro gates on moved features: `open_control_server_cmd`,
  `phone_remote_start_cmd`, `phone_remote_client_url_cmd`,
  `control_regenerate_token_cmd` `require_entitled` sites (and
  `palette_tabs.rs::phone_enable`'s), the Load ▾ / Ensure-env
  `proClass`+`openUpgrade` wiring in the bar for anything that moves.
* `touch_relay.rs` and `/ws/touch` (after phase 4).
* `/api/control/*` and `/api/sessions/action` from `control_server.rs`
  (after phase 5); `control.html`'s session-control role.
* The four-way duplication of the Current control surface, and with it
  the Watch pro-gating inconsistency and the context-menu-only
  orphans (`Repoint assets…`, `Open media panel`) — they become
  registered commands and appear wherever their `surface` says.
* Eventually: the moved bespoke verbs from `TDXLUUtilityExt` and
  PROTOCOL.md (after the D7 window).

## 4. Phased work plan

Phases are independently landable; each names its gate. Frontend gates
include `npm run build`; Rust gates `cargo check` + `cargo test`
(memory: these are the project's gates, not the Envoy/TD workflow).

* **P0 — Registry 1.7.0**: `surface` + `capability` fields (spec,
  decorator, harvest, wire passthrough, `docs/fns-command-registry.md`
  update). Old consumers must be byte-for-byte unaffected when the
  fields are absent. *Gate*: registry unit checks; quick window
  behaviour unchanged against a 1.7.0 registry.
* **P1 — Current-view + context-menu consumer (generic rendering)**:
  fetch-per-selected-session + `utility-hello` prefetch + `Rev()`
  cache; render `surface: session` commands grouped by tool in the
  companion bar area, and `surface: context-menu` commands into
  `sessionMenu()` (both surfaces in one pass — owner call, accepting
  the larger App.tsx blast radius to kill the duplication faster),
  with state chips, params prompts, curation. Hardcoded buttons stay
  untouched beside them. *Gate*: a scratch tool registering commands
  on each surface appears/disappears live in both; G2 dormant-slot
  test (below) passes.
* **P2 — Blessed framework + `fns.collect` + `fns.media-browser`**:
  capability recognition, the two rich modals re-pointed at registry
  commands (tool side may still live in the utility at this phase —
  blessing is orthogonal to packaging). *Gate*: collect plan→confirm→
  apply→poll works end to end through `fns_run_command` only; media
  panel drives through commands only.
* **P3 — Packaging**: collect + media move into FNSTools Plus
  package(s) on the toolkit rail (`access` tier, `fnstools/plus/`,
  sha256-pinned — PackagingScheme rules apply: pinned hashes, live
  version off the component, `min_td_build`). Utility enters the D7
  deprecation window. *Gate*: fresh session + stocked package =
  capabilities appear; vanilla companion alone = thin bar, zero
  errors.
* **P4 — Mobile package**: TD-side server per D4 (bind discipline,
  machine-local activation via ConfigRegistry, per-session port,
  in-package page, palette-tab QR, `fns.mobile-control` + info
  command). Launcher renders per-session QR in Current. *Gate*: phone
  controls a session with the launcher **closed**; second session gets
  its own working QR; a copied project on a token-less machine serves
  nothing until activated; loopback-only until LAN opt-in.
* **P5 — Fleet rescope**: `control_server.rs` down to the D5 route
  set; `control_url` hand-off in `/api/sessions`; retire touch relay;
  settle the client-tier question. *Gate*: fleet page launches a
  recent, follows the hand-off link into the new session's control
  surface; removed routes 404; `client_tier_route_gate`-style test
  updated, not deleted.
* **P6 — Cleanup**: delete the gates and dead code in §3, drop
  deprecated verbs after the window, prune PROTOCOL.md, update
  `docs/fns-integration.md` freemium section and `tiers.ts` copy.
  *Gate*: `git grep` finds no `require_entitled` on moved features; no
  references to removed verbs outside CHANGELOG/history.

**Test called out by name (G2, dormant-slot)**: vanilla companion,
zero Plus packages, Current view renders the thin bar with builtins
only — no errors, no phantom buttons, no layout collapse. This is the
"base tolerates absent modules" contract fns-gate.md §4.3 flags as the
part most likely to fail quietly.

## 5. Sequencing and dependencies

* P0–P2 have **no dependency on the gate cutover** — they restructure
  free, already-shipped capability and can land now.
* P3+ needs the toolkit rail to carry the package(s): `access` tier
  rows, and the FNSTools Plus product/tier naming settled on the
  toolkit side (fns-gate.md §8.8's work order — this document is the
  launcher half; the toolkit half is authoring the packages).
* P4's package is authored in the FunctionStore_tools project (it is
  an FNSTools package, §4.1), but its page today lives in this repo
  (`control-standalone.tsx`) — expect a code move or a shared build
  step; decide when P4 starts.
* fns-gate.md's own L5 walk (creator-authenticated end-to-end) remains
  the licensing precondition for anything *stocked* as gated.

## 6. Resolved questions (owner, 2026-08-30)

All seven original open questions were put to the owner and decided;
each resolution is also folded into its owning section above.

1. **Package granularity → per-feature packages** (collect / media /
   mobile each their own). Matches the manifest's category model, lets
   mobile ship first; pricing copy may still present a "Plus" bundle.
2. **Fleet → FREE.** "Fleet is free, per-session control is a Plus
   capability." The start/link `require_entitled` sites go (D5, §3).
3. **Autosave → builtin command**, free everywhere via
   `TDX_BuiltinCommands` (D7).
4. **QR in TD → inline JS QR** in the package's own pairing HTML,
   rendered via the Web Render palette tab (D4). No Python dependency.
5. **Media previews → local filesystem paths** in command results;
   generated previews are captured to a temp/cache path by the tool;
   missing paths degrade to placeholder tiles (D6). *(Against the
   drafted recommendation of base64-v1 — chosen for zero transport.)*
6. **Context menu → registry-driven in P1**, same pass as the Current
   bar (D1, D2, P1). *(Against the drafted recommendation of
   deferring — chosen to kill the four-way duplication faster,
   accepting the larger App.tsx blast radius.)*
7. **Client tier on per-session pages → deferred past P4 v1.** P4
   ships author-token only; a command-allowlist-by-token design is a
   later iteration (§2 D5 note stands).

## 7. Execution status (2026-08-30/31, overnight run on `dev`)

* **P0 — DONE** (`365dfd9`): registry 1.7.0 ships `surface` +
  `capability` (validation, harvest, decorator, wire passthrough);
  utility 0.22.0. 17/17 offline checks pass; absent fields are
  byte-identical to 1.6.0 behaviour. FNSCommand.py master port is
  OPEN (the local ExtUtils copy is
  gitignored; port before the next ExtUtils distribution).
* **P1 — DONE** (`721164c`): Current bar + session context menu render
  `session` / `context-menu` surface targets (tool-grouped buttons,
  state chips, curation via the quick stores, generic argument-prompt
  modal). Fetch on selection / `utility-hello` / after every run.
  Verified in the browser demo end to end.
* **P2 — DONE** (`82d9036`): blessed dispatch (`fns.collect` →
  collect modal, `fns.media-browser` → Media panel); both rich flows
  prefer the command rail and fall back to legacy verbs (launcher-side
  deprecation window). TDXLUCollect / TDXLUMedia announce the
  contracts above. Verified in the browser demo (collect plan →
  confirm → apply → poll through `fns_run_command` only).
* **Live-TD pass — DONE** (same night, against the running utility dev
  project TDXLPP.8): the 1.7.0 registry auto-promoted by
  version-compare (registrations migrated), `Repromote()` was needed
  once — the documented multi-save stranding hit exactly as the dev
  note predicts (the global promoted on the first save carrying the
  version bump, before `_cleanSurface` existed; collect's early
  announcement came back field-stripped until the repromote + rescan).
  After it: all 11 blessed commands live with `surface`/`capability`
  intact, `ListCommands()` (the fns_commands wire) carries the fields,
  and `RunCommand` executed fns.collect's entry (real dry-run plan,
  8 files, correct modal keys) and fns.media-browser's `list` (4 real
  refs, MediaPanel's shape). Zero op errors after every hot-sync.
* **Caveat found — then measured and FIXED (2026-08-31)**: TDXLUMedia's
  `onInitTD` did not fire on hot-reinit, and a real fresh TD boot
  showed why the caveat was worse than assumed: **TD initializes child
  extensions lazily**, so on a fresh load nothing touches TDXLUMedia
  and its init-time registration never runs (collect's does only
  because something touches it at startup). A controlled
  `reinitextensions` pulse proved the mechanism itself sound (tag +
  all 8 commands land). Fix: `TDXLUUtilityExt.postInit` now nudges
  both capability tools (`_announceChildCapabilities`, deferred 90
  frames) — the utility ext always initializes because it runs the
  bus, and touching the child ext forces its init. Verified live
  (all 11 commands + both tags after the nudge); the fresh-boot leg of
  the fix itself still wants one restart walk. The `fnscommands` tags
  persist only when the project/tox is saved and re-exported (Dan's
  save).
* **Still open for P1/P2 acceptance**: the G2 dormant-slot walk
  (vanilla companion, zero Plus capability) and a real
  launcher-app-to-TD pass (the dev launcher wasn't relaunched
  overnight — two launchers can't share the 11999 hello bind). The
  hardcoded Collect…/Media buttons stay beside the injected ones until
  P6 by design.
* **D3/D5 gating flip — EXECUTED EARLY** (2026-08-31, owner decision
  "session surface + phone", `f2c40cb` + `490ead4`): everything
  Current-reachable is free in Rust and badge-free in the UI — the
  companion verb allowlist is deleted wholesale, phone/fleet, Control,
  Perf, Load ▾ (all three paths), Ensure env, windows management and
  Watch are ungated; palette-tab mirrors follow by parity. Launcher-
  native panels (Patreon, Toolbox fetch, git, backup, GPU affinity)
  keep `require_entitled`, and `place` gained kind-targeted gates so
  the free verb can't side-door Patreon/remote-Toolbox fetching.
  tiers.ts copy moved accordingly.
* **FNS tab Plus support — DONE** (`3ce9786`): the live manifest
  (v3.0.9) already carries the Plus rail (per-package `access`,
  `toolkit.tiers` with labels, `support_url`, FNS_TimelineTools under
  `fnstools/plus/`). The store list + Palette shelf badge gated rows
  by tier label (from the routes projection, never hardcoded), lock
  them when the claim's products don't name them, and
  `licensing::download_token()` + a Bearer on gated rows lets
  `sync_store` stock what the claim covers (sync-all skips uncovered
  gated rows quietly; explicit requests let the fail-closed gate
  answer). Untested against a real entitled claim — fold one gated
  stock into the L5 walk.
* **D7 deprecation window — OPEN (2026-08-31).** Its precondition is met:
  the capability tools landed in the toolkit as FNS packages
  (`FNSTools/FNS_Collect`, `FNS_MediaBrowser`, `FNS_Remote` in FNSTools),
  so the bespoke verbs now have shipping equivalents. The ledger is in
  `utility/heartbeat/PROTOCOL.md` ("Deprecated verbs"): collect_*, media_*,
  autosave_*, control_* and the phone-touch relay are deprecated-but-
  answering, each naming its replacement capability and new owner;
  `repoint_assets` is NOT (no package equivalent yet). Removal is one
  utility version after a package reaches users — companions in the wild
  lag the launcher, so same-day removal would break yesterday's tox.
  - **Autosave joined the rail rather than a package** (the standing
    decision): the utility COMP itself announces capability `fns.autosave`
    (`autosave` visible + hidden `autosave_now`/`get`/`set`, state chip on
    `Asactive`), announced from the COMP that is its EDIT MASTER so the
    write verb and the settings share an owner. The launcher blesses the
    id and opens its existing autosave modal.
  - **`fns.mobile-control` is blessed too**, routing to FNS_Remote's own
    pairing flow.
  - **Location independence** was the other half: with the tools moving
    out of the companion, `_announceChildCapabilities` no longer names
    child paths — it drives the registry's tag rescan, which finds a
    tagged tool anywhere in the project and forces its extension to
    initialize (the lazy-init trap). The direct child nudge survives only
    as a fallback for a tool present but not yet tagged.
* **P3 — DONE** (toolkit side, v3.0.14 and after): Collect, MediaBrowser,
  Autosave and Remote ship as FNSTools packages; companion 0.23.0 dropped
  the moved components and PROTOCOL.md records the twelve bespoke verbs
  as removed, window closed.
* **P4 — DONE**: FNS_Remote built and verified (docs/fns-remote.md §8),
  at 1.0.3 with the client link and the component browser (§9); the
  Current tab routes `fns.mobile-control` to the package's own pairing.
* **P5 — DONE on the launcher side** (2026-09-11, FNSTools v3.2.0
  released FNS_Remote): the touch relay went at `d3475a8`, the client
  tier moved into the package (fns-remote.md §9), the hand-off is built
  (`remote_handoff.rs` fills `control_url` / `client_url` / `remote` per
  session in `/api/sessions`; the fleet page opens them; the palette
  tab's Phone drawer reads the package first), and the routes are
  retired. `/api/control/*`, `/api/sessions/action` and `/ws/touch`
  answer **410 with a pointer** at the session's own remote rather than
  404 -- a phone holds a cached page and a bookmark, and "gone, here is
  what took the job" is debuggable where a 404 reads as a broken
  launcher. `retired_route()` is the single list and
  `retired_session_routes_answer_gone` replaced the client-tier gate
  (updated, not deleted, as the plan asked). The client tier is gone
  whole: one token, `Role` deleted, the pairing dialog is one fleet
  link, and the fleet page lost its parameter panel, touch and
  save/snapshot/record -- it is the process surface plus the links.
  STILL OPEN, and it belongs to P6: the companion's own `control_*`
  verbs and their Envoy (`mcp_bridge.rs`) and palette
  (`palette_tabs.rs`) mirrors, plus the desktop Current tab's panel
  that speaks them. Those come out in a companion release, with a
  version of lag for companions in the field.
* **P6 — gate deletion largely done**; the remaining `require_entitled`
  sites are launcher-native panels, kept on purpose. The D7 verb removal
  is done and PROTOCOL.md pruned. Left: the companion's `control_*`
  verbs + mirrors named above, and `ControlPanel.tsx` with them once the
  desktop Current tab hands parameter control to the package too.

## 8. Sources

* `docs/fns-gate.md` — §3.2 (pro → FNSTools Plus), §4.1 (the decision
  rule and its exception clause D4 instantiates), §4.2–§4.4 (rail,
  ExtAuth lessons, purchase-gate stance), §7 (what must not change),
  §8.8 (the work-order pointer this document answers)
* `docs/fns-command-registry.md` — the injection rail and its spec
* `docs/fns-palette-registry.md` — the in-TD tab surface D4's pairing
  view uses
* `docs/fns-integration.md` — freemium rationale, `load_tox` store
  carve-out, registry history
* `src/App.tsx` (Current view clusters), `src/quick.tsx` (the consumer
  pattern P1 copies), `src-tauri/src/commands.rs` (free-verb
  allowlist), `src-tauri/src/control_server.rs` + `touch_relay.rs`
  (what D5 rescopes and retires), `utility/heartbeat/PROTOCOL.md`
  (wire), `utility/TDXLauncherUtility/FNS_CommandRegistry/` (registry
  implementation)
