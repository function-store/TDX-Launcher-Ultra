# TDXLU Utility TCP Bus

Shared localhost JSON line protocol between **TDXLU** (tray) and **TDXLauncherUtility** (in TD).

**TD side:** use **TCP/IP DAT** operators (`tcpip_cmd` server, `tcpip_out` client) + Timer CHOP callbacks - not Python `socket` / threads. Ext methods handle JSON; DATs own the wire.

## Multi-project

Many TD sessions can run Utility at once:

| Channel | Port | Scaling |
|---------|------|---------|
| Utility -> TDXLU | **11999** (shared) | Each Utility **connects out** - no bind conflict |
| TDXLU -> Utility | **12000-12099** (100 ports) | Each Utility binds the first free port from `Hbcmdport`; advertises `cmd_port` in `hello`. If the span is full, that Utility's command bus stays down and status reports exhaustion - raise the Command Port base or close a session. |
| ~~TDXLU -> Utility (**phone touch**)~~ | ~~12100-12199~~ | **RETIRED 2026-08-31.** Touch moved into the `FNS_Remote` package, which serves the phone from its OWN WebSocket - the phone reaches the session directly, so there is no relay and no port span. See [Phone touch](#phone-touch-retired). |

TDXLU keeps a peer map `project id -> cmd_port` from hellos and routes Companion cmds (Save / Pulse / Record / Load tox / Ensure env) to the right session. Commands include `id`; Utility refuses mismatches.

Heartbeat **Active** only enables watch dogfood pulses. Hello + command server stay up whenever Utility is loaded.

## Envelope

Newline-delimited JSON, UTF-8:

```json
{"type":"<kind>","v":1,"id":"<normalized .toe path>", ...}
```

`id` / `path` / `project` identify the `.toe` (forward slashes; lowercased on Windows). Untagged messages are ignored.

## Utility -> TDXLU (port 11999)

| type | When | Fields |
|------|------|--------|
| `hello` | Always (~every 2s) | `id`, `cmd_port`, `utility: true` |
| `heartbeat` | Only if Heartbeat **Active** | `id`, optional `fps` |
| `event` | Optional later | `name`, `payload` |

Legacy plain-text `HB id=... fps=...` still accepted for heartbeat only.

## TDXLU -> Utility (peer cmd_port)

```json
{"type":"cmd","v":1,"id":"<toe>","action":"save"|"pulse"|"record"|"ping"|"load_tox"|"ensure_tdpyenv","req":"<uuid>", ...}
```

| action | Extra fields | Effect |
|--------|--------------|--------|
| `save` / `pulse` / `record` / `ping` | - | Existing media / presence cmds |
| `version` / `info` | - | Utility version + build |
| `panes` / `get_panes` | - | Open panes + owner, so TDXLU can label torn-off OS windows |
| `perf` | - | `perform_stats` readout (gated on **Perfactive**) |
| `update_utility` | `tox_path` | Repoint own External Tox and reload in place (deferred ~30 frames so this reply escapes first) |
| `collect_save` | optional `dry_run`, `expressions`, `include` | Delegates to `TDXLUCollect`; chunked across frames so this call never blocks |
| `collect_status` | - | Progress / last-run summary for a running or finished collect |
| `media_pick_replace` | `ref` (`<op path>.<par>` from `media_list`) | Open **TD's own file browser** for that media reference and point it at what the user picks - the headless twin of the Media panel's Replace, for the in-TD palette page (the dialog opens over TouchDesigner, where the user is). Replies immediately with `{ok, started, ref}`: `ui.chooseFile` is modal and would otherwise hold the main thread, and this reply, for as long as the dialog is open. Refuses up front when the parameter is gone, is not a File par, or is driven by an expression / bind / export. Nothing is saved |
| `media_pick_status` | - | Outcome of the last `media_pick_replace`: `phase` is `idle` \| `picking` \| `done` \| `cancelled` \| `error`, plus the `Replace` result (`ref`, `value`, `file`, `inside`) when done |
| `autosave_get` | - | Autosave settings + readouts: `active`, `interval` (minutes), `mode`, `only_modified`, `skip_perform`, `status`, `last_save`, `next_in`, `modified`, and whether the project has ever been written to disk |
| `autosave_set` | `fields` (or the same keys flat) | Writes the settings on the utility COMP - the edit master; `TDXLUAutosave` binds up to them. Refuses an unknown mode and any parameter driven by an expression / bind / export, so a remote write can never destroy authored wiring. Replies with the refreshed state plus `applied` / `refused` |
| `autosave_now` | - | Save immediately in the configured mode, ignoring the skip toggles |
| `control_schema` | - | Full exposed-parameter schema + `hash` |
| `control_get` | - | Values only - the cheap ~1 Hz poll companion |
| `control_set` | `sets: [{target, par, value}]` | Writes. Refuses unexposed, read-only, or non-CONSTANT-mode pars, so a write can never destroy an expression / bind / export |
| `control_comps` | optional `parent` | One lazy layer of the COMP tree for the "expose a component" browser |
| `control_add` / `control_remove` | `comp` / `key` | Point a Control-sequence block at a COMP, or clear `blockN` |
| `windows` / `get_windows` | - | Every Window COMP in the project with its placement (`display`, `justify_to`, `justifyh`/`justifyv`, `offsetx`/`offsety`, `size`, `winw`/`winh`, `single`, `borders`, `alwaysontop`), live geometry while open, and the sidecar layout. `primary` flags project-level windows - a loaded palette contributes dozens of internal popup windows. `locked` lists placement pars driven by an expression, which are refused rather than written |
| `window_set` | `path`, optional `fields`, optional `open` | Place one window; only the given fields are touched. Refuses non-CONSTANT pars (never destroys an expression / bind / export), unknown fields, and bad menu values (the error lists the legal names). `open` true pulses **Open as Separate Window**, false pulses **Close** |
| `window_apply` | optional `items` | Apply a layout - the sidecar's when `items` is omitted. Windows no longer in the project are reported in `missing`, not raised. Only `open: true` acts; a window saved closed is left alone |
| `window_save` | optional `paths`, `apply_on_load`, `include_all` | Capture current placement into the sidecar `windows` block. Primary windows only unless `paths` or `include_all` says otherwise |
| `window_clear` | - | Remove the sidecar `windows` block |
| `load_tox` | `path` (or `tox_path`), optional `persist`, `parent`, `externaltox`, `toxfile_module` | Load into the **Network Editor** pane owner (current if `NETWORKEDITOR`, else first Network Editor - `/` allowed), else `/` if Global OP Shortcut, else `/sys/quiet`. If placed at `/`, focus a Network Editor on root. Result includes `resolved_from`. Optional `parent` overrides. `persist:true` also copies to `{project}/tox/`. When `toxfile_module` is set (e.g. `tdptdpbrowser.Browser`), bind External Tox to `mod.<module>.ToxFile`. URL/GitHub -> tox_cache; TDP -> uv into project vEnv then local `path`. |
| `ensure_tdpyenv` | - | Drop palette `tdPyEnvManager` at **`/`** if missing (`loadTox` direct - no quiet stage); focus a Network Editor on root |
| `fns_install` | `selection` (path to selection.json), optional `bootstrap` (path to FNSTools.tox), optional `parent` | Hand a selection to the project's FNS_Installer. No toolkit root -> load `bootstrap` first (its container is the install target). Manifest stays blank so the installer reads the palette store the launcher stocked. Replies immediately with `started`; the Install pulse runs deferred - poll `fns_status` for the outcome |
| `fns_status` | - | FNS toolkit presence: root path, installed packages with their live `Pkgversion`, installer path + `Status`, whether `op.FNS_CONFIGREGISTRY` exists |
| `fns_settings_url` | optional `ensure` (default true) | URL of the FNS settings server (`GET /api/state`, `POST /api/set`), starting it if needed - no browser open. Since FNS_Console took over the settings UI that server is the console's (`op.FNS_CONSOLE`: loopback, first free port of its UI_PORTS 36710-36759, idle-stopped; reply carries `via: "console"`); a toolkit without a promoted console falls back to the ConfigRegistry's ephemeral server (9871-9880). `ok: false` names which half is missing |
| `fns_commands` | - | All tool-registered quick-launch commands from `FNS_CommandRegistry`: `{ok, rev, commands: [{key, tool, id, label, help, path, params?, hidden?}]}`. `rev` is a monotonic change counter. `params` (0.12.0) declares user-suppliable arguments: `[{name, label, style: str\|int\|float\|toggle\|menu, required, default?, menu?, help}]` - consumers prompt for them. `hidden` (0.14.0) is the tool-declared default visibility - consumers keep such commands off default listings unless the user opts in. `builtin` (0.16.0) marks TD/system commands (the companion's own TDX_BuiltinCommands owners, TD_Dialogs / TD_Session) - consumers list them with their native commands rather than under tools. `state` (0.19.0) rides when the command declares a live state reference AND it evaluated: `true`/`false` for toggles, a short string for values - evaluated at query time, fresh per call; params may carry a `current` prefill value the same way. `surface` (0.22.0, registry 1.7.0) rides when declared: a token list naming the consumer surfaces the command wants (`quick` is the default when absent; `session` = the launcher's Current-view companion bar, `context-menu` = its session right-click menu) - consumers serve the tokens they recognise and ignore the rest. `capability` (0.22.0) rides when declared: a blessed-capability id (`fns.collect`) telling consumers they may swap in rich native UI for the command group. An older utility answers `unknown action` - treat as "no commands" |
| `palette_url` | `url` | Point the Palette Browser's **TDXLU / Patreon tabs** (utility ≥ 0.21.0, `TDXLUPalette`, published through `FNS_PaletteRegistry`) at the launcher's loopback palette page: `http://127.0.0.1:<control port>/palette.html?sid=<id>#k=<token>`. The utility stores it, activates the Web Render TOP only while one of the launcher's tabs is the current tab, and re-applies it across extension reinits. An empty `url` disconnects (the tabs fall back to a "start TDX Launcher Ultra" hint). The launcher sends this on every **fresh** hello, so a launcher restart re-connects every session. Replies `{ok, installed, url_set}` |
| `selection` | - | What the Network Editor has selected (utility ≥ 0.21.0): `{ok, owner, ops, comps}` — the current editor first, then any other; `comps` is what the palette's *Expose selected* / *Pin selected* act on. Empty lists when nothing is selected |
| `toolbox_save_selected` | `dir`, optional `name` | The inverse of `load_tox` (utility ≥ 0.21.0): save the current Network Editor's selected COMP as `<dir>/<name or COMP name>.tox` (uniquified, never overwrites) and reply `{ok, path, name, comp, selected}`; the launcher then pins the file as a local Toolbox tool (palette tab: *Pin selected COMP*). Refuses with `ok: false` when nothing is selected or the selection is the utility itself |
| `palette_status` | - | Tab state: `{ok, active, installed, registry, current_tab, url, status}` - `installed` means the `tdxlu` tab is published on the promoted registry (`registry` = its `/sys` path, `null` when no registry is up), `current_tab` is the tab the Palette Browser shows (`palette`, `tdxlu`, `patreon`, or another tool's), `url` has the token stripped. `ping` / `info` replies carry `palette: true` when the verbs exist - an older utility answers `unknown action` |
| `fns_run_command` | `key` (`<owner path>#<id>` from `fns_commands`), optional `args` / `kwargs` overrides | Execute one registered command: calls the owning tool's promoted method synchronously and relays its result (`ok:false` + `error` when the tool is gone, the method is missing, or it raised). Declared params in `kwargs` may ride as strings - the registry coerces + validates them by style (`"0.5"` → `0.5`; a bad value or missing required param refuses the run with a param-named error); missing optional params fall back to their declared default. Registered handlers are expected to be quick actions |

Reply on the same connection:

```json
{"type":"result","v":1,"req":"<uuid>","ok":true,"id":"<toe>","cmd_port":12001, ...}
```

or `ok: false` with `error`.

Examples:

```json
{"type":"cmd","v":1,"id":"c:/proj/a.toe","action":"load_tox","req":"...","path":"C:/lib/Foo.tox","persist":false}
{"type":"cmd","v":1,"id":"c:/proj/a.toe","action":"ensure_tdpyenv","req":"..."}
{"type":"cmd","v":1,"id":"c:/proj/a.toe","action":"window_set","req":"...","path":"/perform","fields":{"justify_to":"specifydisplay","display":1,"size":"fill"},"open":true}
```

### Removed verbs (D7 — window CLOSED, 2026-08-31)

Twelve verbs are **gone**, not deprecated. `collect_save`, `collect_status`,
the seven `media_*`, and `autosave_get` / `autosave_set` / `autosave_now`
now answer `unknown action` like any other verb this bus never had.

The deprecation window was dropped after the owner confirmed the product has
**beta testers only** — no installs in the wild running an older companion.
The window existed solely to protect those users; with none, keeping a second
path would have meant maintaining a delegator nobody exercises, which can only
rot. Their features live on the FNS package rail
(`FNS_Collect`, `FNS_MediaBrowser`, `FNS_Autosave`), reached through
`fns_run_command` and the capability ids.

The launcher is capability-only for all three: no legacy fallback remains, and
a session without the package gets a message naming the package to install.

**NOT removed, and not part of this window:**

| Verb | Why it stays |
|---|---|
| `repoint_assets` | `TDXLURepoint` is still IN the companion. This is the real path, not a delegator |
| `control_schema` / `get` / `set` / `comps` / `add` / `remove` | The desktop Control panel and the in-TD palette page drive these directly, and no capability path exists yet. FNS_Remote owns Control conceptually; until the launcher can reach it that way, deleting these is a regression, not a simplification |
| `save` / `pulse` / `record`, autosave-free bus, windows, panes, perf, `load_tox`, `ensure_tdpyenv`, `fns_*`, `palette_*` | Companion's own, or launcher transport |

### Window placement

TouchDesigner has **no command-line option for window placement** - the only
monitor-adjacent launch flags are GPU affinity (`-gpuformonitor` /
`-gpubusid`), and those bind the process to a *card*, not a window to a
*screen* ([wiki](https://docs.derivative.ca/Using_Multiple_Graphic_Cards)).
Placement lives in Window COMP parameters, inside the running session - which
is why it is a Utility verb and not a launcher argument.

A layout saved with `window_save` is re-applied by the Utility ~90 frames
after load (`WINDOW_LAYOUT_DELAY_FRAMES`), late enough that TD's own startup
Window Placement has already run. Set `apply_on_load: false` in the block to
keep a saved layout without restoring it.

### Autosave

`TDXLUAutosave` (nested, standalone-capable) drives a Timer CHOP and saves the
project when a cycle completes. Two modes:

| `mode` | Call | Result |
|---|---|---|
| `td` | `project.save()` | TouchDesigner's own Save, so it follows the user's **Increment Filename when Saving** / **Copy to Backup Folder** preferences |
| `overwrite` | `project.save()` with `general.inc` held at `0` for the call | Always lands back in the `.toe` already open |

`overwrite` goes through the preference rather than `project.save(<path>)` on
purpose: an explicit-path save is Save As, and TD answers an existing target
with a **modal overwrite prompt** - one click for a person, a hung session for
something on a timer. The preference is restored afterwards, including when
the save raises.

The save is synchronous and stalls the frame, so the timer callback never runs
it inside the CHOP cook - it defers by one frame through `run()`. Two skips
keep it out of the way: **Only If Modified** (`project.modified` empty) and
**Skip In Perform Mode**. Neither applies to `autosave_now`.
## Phone touch (RETIRED)

**This relay no longer exists.** It was: phone -> a WebSocket on the
launcher's control server -> a long-lived TCP stream into the companion's
`TDXLUSensors` on ports 12100-12199.

`TDXLUSensors` has been absorbed into the **`FNS_Remote`** package, which
runs its own Web Server DAT and holds the phone's WebSocket itself. The
phone now talks to the SESSION, on the session's own origin:

```
phone browser --WebSocket--> FNS_Remote (in TouchDesigner)
```

What that bought, beyond one less hop:

- **Targeting works.** The relay port-scanned 12100-12199 and drove
  whichever companion answered first, which is simply wrong with two
  sessions live. One server per session cannot be aimed at the wrong one.
- **No launcher required.** The whole point of the package: a phone drives
  a rig with nothing else running.

Wire format is unchanged in spirit (one JSON object per frame, `x`/`y`
0-1 with `y` from the top, browser convention, `Flipy` converting to TD's
bottom-up) - it just arrives over the session's own socket now. The client
key is still assigned server-side so one page cannot impersonate another.

Contract: `docs/fns-remote.md`. Launcher side: `touch_relay.rs` and the
`/ws/touch` route are deleted; the launcher's remaining phone job is the
fleet page plus a hand-off link to a session's own remote
(`docs/fns-plus-capabilities.md` D5).

## Watch (rare)

Settings -> Heartbeat timeout / grace / relaunch only apply when TDXLU has an active **Watch** session for that `id`. Missed heartbeats then may kill/relaunch that session's PID - leave Watch off unless you need it.
