---
status: in progress -- built in TDXLPP (utility dev project), DESTINED FOR FNSTools
  as an FNSTools package (fns-gate.md §4.1's exception clause: it must work with
  the launcher not running). This document is the contract; it travels with the
  component.
summary: FNS_Remote -- one portable FNS-family component that turns a phone or any
  browser on the network into a remote for THIS TouchDesigner session. Consolidates
  the launcher's phone-remote surface: the touch receiver (absorbed from
  TDXLUSensors), the exposed-parameter Control surface (moved off TDXLUUtilityExt),
  and its OWN web server + page, so nothing depends on TDX Launcher Ultra.
since: 2026-08-31
related: docs/fns-plus-capabilities.md (D4 -- the standalone decision and its build
  requirements), docs/fns-command-registry.md (how it announces itself),
  utility/heartbeat/PROTOCOL.md (the launcher-relay design this REPLACES)
---

# FNS_Remote -- phone/browser remote for one TD session

## 0. Why it exists in one piece

Before this, "phone remote" was four things in two repos: a touch receiver in
the companion (`TDXLUSensors`), the Control verbs + their par sequence on the
companion's own extension, an HTTP server + auth + page in the launcher
(`control_server.rs`, `control-standalone.tsx`), and a WebSocket->TCP relay
bridging them (`touch_relay.rs`). It only worked with the launcher running,
and the touch relay could not even target a specific session (it port-scanned
12100-12199 and took the first companion that answered).

FNS_Remote is all of it in one COMP that works with nothing else installed.

**One session = one server = one link.** The component IS the session, so
there is no session-targeting problem to solve: what you point a phone at is
the project serving it.

## 1. Shape

FNS-family component, promoted global shortcut `op.FNS_REMOTE`, standalone by
construction (drop the .tox in any project, arm it, done).

```
FNS_Remote/                     base COMP  --  op.FNS_REMOTE
  FNSRemoteExt            text  --  the extension (server, auth, touch, control)
  remote_server      webserver  --  HTTP + WebSocket, ONE per session
  remote_server_callbacks text  --  onHTTPRequest / onWebSocket*
  remote_page             text  --  the served page (vanilla HTML+JS, no build step)
  script_touch          script  --  touch frames -> CHOP channels
  null_touch              null  --  THE touch output (reference this)
  table_clients          table  --  connected clients (readout)
  parexec_remote        parexec --  par callbacks
  pre_release             text  --  Embody standalone-export hook
```

## 2. Parameters

| Page | Par | Meaning |
|---|---|---|
| Remote | `Active` | Bind the server and serve. Off = nothing listens |
| Remote | `Port` | First port of the span it binds (default 9980, span 20) |
| Remote | `Boundport` | READONLY -- what it actually bound |
| Remote | `Lan` | OFF (default) = loopback only. ON = all interfaces -- an explicit, deliberate act |
| Remote | `Status` | READONLY -- one line of state |
| Remote | `Url` | READONLY -- the pairing URL (loopback), token in the fragment |
| Remote | `Openpairing` | Pulse: open the pairing page (QR) in the system browser |
| Remote | `Regeneratetoken` | Pulse: mint a new token; existing links die |
| Touch | `Maxtouches` | CHOP slots (default 10) |
| Touch | `Flipy` | Browser Y is top-down; TD is bottom-up |
| Touch | `Normalize` | Off = multiply back up by the reported screen size |
| Touch | `Createtarget` | Where the builder pulses drop operators |
| Touch | `Createselectchop` / `Createselectdat` / `Createreceiver` | Builder pulses |
| Control | `Control` (sequence) | Exposed COMPs: `Comp` / `Pages` / `Pars` / `Active` per block |
| Control | `Controlstatus` | READONLY -- what is exposed |

## 3. Security -- the rules, not preferences

Every one of these is a rule this component must not break. The first two are
paid-for lessons (FNSTools' `ExtAuth`, and the official Web Server DAT docs
which state it outright).

1. **The bind address is explicit, always.** A blank `localaddress` on a Web
   Server DAT listens on EVERY interface. `Lan` off pins `127.0.0.1`; `Lan`
   on is the only path to `0.0.0.0`, and it is off by default.
2. **Nothing blocks the frame.** Callbacks are quick; no synchronous I/O in a
   request handler.
3. **Activation and the token are MACHINE-LOCAL, never project-local.** They
   live in a plain JSON file in the toolkit's config AREA --
   `<user palette>/FNSTools/config/fns_remote.json`, written directly
   (`_configPath` / `_readConfig` / `_writeConfig`) -- NOT in the component's
   parameters. This is what makes the capability safe to carry in a
   travelling `.toe`: a stranger who opens your project gets a **dormant**
   component -- no token, no LAN, nothing listening -- until they arm it on
   their own machine. Without this rule, a shared project would ship a live
   LAN listener and its owner's token to whoever opened it.

   **It does NOT depend on `FNS_ConfigRegistry`, deliberately.** It shares
   the registry's config *directory* (so everything a user might clear lives
   in one place) but needs no registry host and no toolkit root: a bare drop
   of this component into an empty project works. That matters twice over --
   the whole premise is that it runs with nothing else installed, and this is
   a credential rather than a setting anyone edits in a config UI. An earlier
   draft of this document said the token "lives in FNS_ConfigRegistry"; that
   was never what the code did, and it briefly sent the toolkit side looking
   for a host to build.
4. **The token never lands in a log or a Referer.** It rides the URL
   **fragment** (`#k=...`), is kept in `localStorage` by the page, and is
   presented as a bearer on every request. Possession of the link is the gate
   -- the same posture the launcher's server has today, stated so it is a
   decision and not an accident.
5. **Every request is authenticated except the pairing page**, which is
   loopback-only (it is the thing that hands the token out) and refuses to
   answer over the LAN.

## 4. Routes

| Route | Auth | Does |
|---|---|---|
| `GET /` | token | The remote page |
| `GET /pair` | loopback only | Pairing view: the LAN URL + an inline-JS QR of it |
| `GET /api/state` | token | Control schema + values, touch/server state |
| `POST /api/set` | token | Write exposed parameters (refuses non-CONSTANT: never destroys an expression/bind/export) |
| `POST /api/action` | token | `save` / `snapshot` / `record` on this session -- but see the split below |
| WebSocket | first frame is the token | Touch frames -- see §5 |

**`/api/action` is not uniform, and the difference is deliberate.** `save`
calls `project.save()` and needs nothing else, so it works in a bare
project. `snapshot` and `record` are the COMPANION's jobs: `RunAction`
looks up `getattr(op, 'TDXLU', None)` and, when the companion is absent,
returns `{"ok": false, "error": "<action> needs the TDXLU companion in
this project"}` -- unavailable, never an exception. So "FNS_Remote works
with the launcher closed" is true of the page, touch, parameters and save;
two of the three session actions additionally want the companion IN the
project (which is not the same as the launcher running).

This is one of three guarded `op.TDXLU` lookups the ported packages keep
on purpose -- the others exclude the companion's own subtree from
FNS_Collect's and FNS_MediaBrowser's scans, so they never offer to
repoint its internals. FunctionStore records them as interop rather than
coupling in [LauncherToolkitBoundary.md](https://github.com/function-store/FNSTools/blob/main/docs/LauncherToolkitBoundary.md); noted here so
a decoupling pass on this side does not ask for their removal. Stripping
them would not separate the products, it would break both.

## 5. Touch wire (phone -> here, direct)

No launcher, no relay, no TCP hop. The page opens a WebSocket to the same
origin it was served from and sends one JSON object per frame:

```json
{"type":"touch","pts":[{"id":7,"x":0.25,"y":0.10,"f":0.5}]}
```

- `x`/`y` are 0-1 across the phone's touch area, `y` from the TOP (browser
  convention). `Flipy` converts to TD's bottom-up convention.
- The client key is assigned SERVER-SIDE from the WebSocket connection, so a
  page cannot impersonate another phone.
- Touch only, deliberately: browsers expose `DeviceMotion` only in a secure
  context, which would drag TLS and a per-phone trust install into a live rig.

## 6. What it announces

Via `FNS_CommandRegistry` (guarded -- no registry is ever guaranteed), under
capability `fns.mobile-control`:

| id | surface | Does |
|---|---|---|
| `remote` | session, context-menu | Visible entry: serve + return the pairing URL |
| `info` | (hidden) | `{active, url, lan, port, clients}` -- what a consumer renders a QR from |
| `pair` | (hidden) | Open the pairing page |

That is how TDX Launcher Ultra shows a per-session QR without owning any of
this: it reads `info` over the bus like any other consumer, and its own
control server keeps only the fleet job (docs/fns-plus-capabilities.md D5).

## 7. What this replaces

| Retired | Was |
|---|---|
| `touch_relay.rs` + `/ws/touch` | WebSocket->TCP bridge, first-companion-wins port scan |
| `control_server.rs`'s session half | `/api/control/*`, `/api/sessions/action` |
| `control-standalone.tsx` as the session page | React/Vite page served by the launcher |
| `TDXLUSensors` | absorbed here (nothing released, so no migration owed) |
| `TDXLUUtilityExt`'s Control verbs + sequence | moved here |

The launcher keeps: the fleet page (list/launch/kill across sessions) and the
hand-off link that opens THIS component's page for a session that advertises
it.

## 8. Build status (2026-08-31)

**Built and verified live** in the utility dev project, as
`/TDXLauncherUtility/FNS_Remote` (FNS-family shape: it promotes its own
`op.FNS_REMOTE` shortcut, exactly like `FNS_CommandRegistry` ships inside the
companion). Built with scripts, never TDN, per the standing rule for this
component tree.

Walked end to end: the pairing page is served by TD itself; the QR renders
from the inline encoder for the LAN URL; token auth is enforced (401 without
a bearer); and touch reached the CHOP **directly from the browser** -- two
fingers at (0.25, 0.10) and (0.80, 0.60) came out as `tx 0.25 / ty 0.90` and
`tx 0.80 / ty 0.40` (Y flipped into TD's convention), 41 channels,
`touchcount 2`. Zero op errors, 60 fps with the server running. Left
disarmed afterwards (Active off, Lan off) -- the correct shipping default.

### What the walk cost, and what it caught

Three real bugs, each of which would have shipped silently:

1. **`appendInt` sets `default`, not the value.** `Port` read 0, so the first
   `Serve()` bound port **1**. Every par created in a build script needs
   `p.val = p.default` afterwards.
2. **TD delivers request headers at the TOP level of the request dict**, not
   under a `headers` key -- the authoriser looked in the wrong place and every
   authenticated route answered 401.
3. **`var ws = null` ran AFTER `connect()`** and nulled the live socket.
   Declarations hoist; their initialisers do not. The page now boots from the
   very END of its script, and the reason is written there.

### Not done yet (the migration half)

The component works; the old pieces have not been removed:

- `TDXLUSensors` still exists and still binds its own touch port. Absorbing
  it (nothing is released, so its `op.TDXLUSensors` shortcut may simply go)
  and repointing `select_touch` / `out_touch` at `FNS_Remote/null_touch` is
  the next step.
- `TDXLUUtilityExt` still carries its Control verbs and its own `Control`
  sequence. FNS_Remote now has its own; the utility's should forward here and
  then go.
- The launcher still owns `touch_relay.rs` and the session half of
  `control_server.rs`; retiring those is fns-plus-capabilities.md's P5, and it
  waits on this component shipping first.
- **Never scanned by a real phone.** The QR renders and its structure looks
  right, but a hand-rolled encoder is exactly the thing to verify with an
  actual camera before trusting it.
- Stale rows accumulate in `table_clients` across page reloads -- TD's
  `onWebSocketClose` did not fire for every closed tab during testing.
- Externalization tracking for these five files is NOT committed:
  `utility/externalizations.tsv` also carries unrelated Embody prunings
  (`FNS_Console`, `FNS_PaletteRegistry`) for files that still exist on disk,
  and that wants a look before it lands.

## 9. Client link and component browser -- agreed path (2026-09-11)

Coordinated with the FNSTools side. FNS_Remote builds the deferred
half of D5 itself: the restricted client link and the "expose a component"
browser that landed on the companion after D4 was written. Nothing here is
built on the launcher side yet; this section is the contract it will be
built against.

**FNS_Remote grows** (their side):

* Author-only `GET /api/comps?parent=`, `POST /api/add {comp}`,
  `POST /api/remove {key}` with the SAME JSON shapes as the companion's
  `ControlComps` / `ControlAddComp` / `ControlRemoveComp` verbs --
  `{ok, parent, comps:[{path, name, pars, added, has_children}]}` and
  `{ok, key}` / `{ok, already, key}` -- and the same `key` format, so the
  launcher's React panel drives either server unchanged while both exist.
  `ControlComps` semantics verbatim, excluding the companion's subtree and
  FNS_Remote's own; the block's Comp stored relative to FNS_Remote.
* Two machine-local tokens (`token`, `client_token`); `_authorized` returns
  a role. Client reaches `/api/state` (actions trimmed), `/api/values`,
  `/api/set`; `/api/action` and the three browse routes answer 403.
  `Regeneratetoken` clears both. `Info()` and the hidden `info` command gain
  `client_url` beside `url`; the pairing window gains a Client mode with its
  own QR; the `Url` par stays the author URL.

**The four answers from this side:**

1. **Touch rides the client link.** The launcher's client tier never had
   touch only because `/ws/touch` was a relay route older than the tier,
   not a product decision. Touch is a control surface; a client handed a
   page of sliders expects the pad. The WebSocket's first-frame token
   therefore accepts either token and the role decides nothing further.
   Recommended: an author-side toggle (default on) that drops the pad from
   the client page, so a rig can hand out a sliders-only link. Owner
   confirmation pending on the default.
2. **Yes, `client_url` beside `control_url` in `/api/sessions`.** Neither
   exists today (P5 is unbuilt); when it lands the launcher fills both from
   the same `info` reply, both optional, absent when the session does not
   advertise `fns.mobile-control` or is inactive. The fleet page is
   author-token only, so it may hand out either.
3. **The in-TD palette tab reads FNS_Remote first.** `/api/palette/phone`
   and `phone_enable` point at the launcher's own control server today
   (`palette_tabs.rs`), the page D5 retires. The tab runs inside the
   session, so the session's own QR is the right one: `phone_info` asks
   the session for `fns.mobile-control` and returns FNS_Remote's `url` /
   `client_url` when present, falling back to the launcher server until
   P5 removes it. One QR window serves both products. Ours to build; owner
   confirmation pending.
4. **Sequencing confirmed.** `/api/control/*`, `/api/sessions/action`, the
   companion's browse verbs and their mirrors retire only after FNS_Remote
   ships the routes above (P5). What keys on `control_comps` / `add` /
   `remove` here: the three author-only routes in `control_server.rs`;
   `api.ts` + `ControlPanel.tsx` (the "Expose a component" browser in the
   Current tab) + `control-standalone.tsx` (the phone page); the Envoy
   mirrors in `mcp_bridge.rs` (`control_comps` / `control_add` /
   `control_remove` for sessions reached without the bus); the verb
   allowlist in `palette_tabs.rs`; and `TDXLUUtilityExt` itself, whose
   verbs forward to FNS_Remote and then go (§8). Identical shapes are what
   make the swap a URL change.

**Shipped on their side (2026-09-11, FNS_Remote 1.0.3 in tree, unreleased until the next
FNSTools drop).** Verified live there: 401/403/200 across both tokens on
every route, add/remove round trip, the WebSocket dropping a wrong token
and honouring the touch toggle. What our consumers must know:

* Keys are `blockN`, the same as `/api/state`'s `control.targets[].key`.
* Annotation COMPs are skipped in the listing (shape unchanged).
* The client's `/api/state` carries no `url` / `client_url` / `pair_url`,
  an empty `actions` list, plus `role` and touch fields.
* The WebSocket hello frame carries `k=<token>`; a client's touch frames
  apply only while the author's `Clienttouch` toggle is on (default on).
* The hidden `info` command returns `client_url` beside `url`, plus
  `client_touch` and `paired` ("author" / "client" -- which link the
  pairing window is currently handing out). That is what `/api/sessions`
  and the palette tab read.
* The package's own phone page renders the component browser, so the
  launcher's React panel is only needed while the launcher still serves
  its own page (until P5).

**Launcher side built (2026-09-11).** `src-tauri/src/remote_handoff.rs`
asks a session's package for `info` through the registry (`fns_commands`
to find the key, `fns_run_command` to run it), caches the answer for a
few seconds per session, and shapes it so a loopback-only link never
reaches a phone: `url` / `client_url` ride only when serving on the LAN,
otherwise `loopback_url` plus a `state` of `off` / `loopback` / `lan`.
Consumers: every alive session with a companion in `/api/sessions` gains
`control_url`, `client_url` and a `remote` object, and the fleet page
shows Open remote / Client link per session (or says why there is
nothing to open); `/api/palette/phone?sid=` and `/api/palette/phone/enable`
answer from the package first, the palette drawer renders its QR with a
full / client switch, and its "Open pairing…" runs the package's `remote`
command so putting it on the LAN stays the explicit act made in TD. The
launcher's own control server remains the fallback for a session without
the package.

**The routes are retired (2026-09-11), now FNS_Remote is released** (v3.2.0 --
the toolkit unified every package version there, so the package is 3.2.0, not
the 1.0.3 its tree carried). `/api/control/*`, `/api/sessions/action` and
`/ws/touch` answer **410** with a line naming what took the job, listed once
in `control_server.rs::retired_route`. The launcher's client tier went with
them -- one token, no `Role`, and the pairing dialog is a single fleet link --
because a restricted link is this package's job now. The fleet page keeps the
process operations (launch / focus / relaunch / kill / dismiss / perf) and the
per-session links, and lost the parameter panel, the touch pad and
save / snapshot / record.

Not retired yet, and tracked as P6: the companion's own `control_*` verbs, the
Envoy mirrors in `mcp_bridge.rs`, the verb allowlist in `palette_tabs.rs` and
the desktop Current tab's `ControlPanel` that speaks them. A companion release
carries those, with a version of lag for companions already in the field.
