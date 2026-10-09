---
status: in-force
summary: What a tool must do to publish a native panel as a tab in TouchDesigner's Palette Browser through FNS_PaletteRegistry -- RegisterTab, the host's Registration page, the onPaletteTab callback, slot sizing, and the rejection rules.
since: branch paletting, 2026-08-23
verified: 2026-08-23 -- TDXLUPalette is the first contributor (tdxlu + patreon tabs on one shared panel), TD 2025.33070
canonical: FunctionStore_tools_PUB `FNSTools/FNS_PaletteRegistry/` -- the port back landed and THAT copy is now the source. This project consumes it as the embedded copy inside `TDXLUPalette` and no longer carries its own master or its source files.
---

# Contract: contributing a tab to the Palette Browser

`FNS_PaletteRegistry` is an FNS-family surface registry (the
[RegistryScheme](https://github.com/function-store/FNSTools/blob/main/docs/RegistryScheme.md) pattern:
a master ships dormant inside a tool, promotes itself to
`/sys/FNS_Registries/FNS_PaletteRegistry`, answers as `op.FNS_PALETTEREGISTRY`,
and stamped *hosts* inside tools register through it). Its surface is
TouchDesigner's own Palette Browser, `/ui/dialogs/palette/palette`: a
folder-tab strip across the top, TD's stock palette as the first tab, and one
tab per contributed **panel COMP**.

Source of truth: [PaletteRegistryExt.py](https://github.com/function-store/FNSTools/blob/main/modules/suspects/FNSTools/FNS_PaletteRegistry/PaletteRegistryExt.py)
(`RegisterTab`, `_validateTab`, `_syncSurface`, `_showTab`, `_sizePanel`).
It is **native-panel only** -- no web server, no browser, no dependency on
FNS_Console. A tool that wants a web page in its tab brings its own Web Render
container (that is what the launcher's `TDXLUPalette` does); the registry
neither knows nor cares.

## 1. The shape

A tab is a contribution. The tool carries a stamped `FNS_PaletteRegistry` host
whose Registration page names:

| Par | Meaning |
|---|---|
| `Comp` | the tool COMP (default `..`, the host's parent) |
| `Canonicalname` | tab id -- letters, digits, `_`, `-` |
| `Panel` | the **panel COMP** shown under the tab. Empty = the tool itself (it must then be a panel). **Sibling name, not `../name`**: OP-reference pars on a COMP resolve against the parent network, so `web` is right and `../web` is "Invalid path" (that form is `comp.op()` syntax) |
| `Callback` | optional DAT whose module defines `onPaletteTab(canonical, previous)` |
| `Tablabel` / `Taborder` | strip label (defaults to the canonical) and position (default 50; TD's own tab is pinned first) |
| `Displayed` | `False` registers the tab hidden -- kept, off the strip, until someone shows it |
| `Autoregister` | register on init and on every par change (the host's par callbacks re-apply). The **master** ships with it off |
| `Tab` sequence (`TabNname` / `TabNsource` / `TabNlabel` / `TabNorder` / `TabNshown`) | **extra tabs from the same host.** The Registration pars above are the FIRST tab; each non-empty block adds another. A block with **no `Source`** reuses the primary panel — that is how one panel serves several tabs, routed by `onPaletteTab`. An empty `Name` is how a host says "no extra tab here" (TD always keeps one block), never an error; a duplicate name is skipped with a `debug()` |
| `Register` / `Regstatus` | manual pulse and the read-only outcome: `Registered: <canonical> -> <panel path> (tab 2 of 4)` — the position is refreshed on every strip change, so an order edit that does not cross a neighbour still visibly did something (`hidden` when `Displayed` is off); `Idle`; `Error: ...`. A `Tab Panel` that names nothing is an error (`Tab Panel 'btn' not found`), never a silent fallback to the tool |
| `Promotepars` | mirror the page onto the tool COMP as a `Palette` page (`Pl` prefix) for hosts that hide their internals |

Stamp it the way every FNS host is stamped: copy the master into the tool,
name it `FNS_PaletteRegistry`, clear `enableexternaltox` / `externaltox`,
drop tracker tags, set the pars above. The host's DATs carry no file binding
(copies are snapshots -- re-stamp after editing the master's extension).

## 2. The call

```python
op.FNS_PALETTEREGISTRY.RegisterTab(comp, canonical, panel=None, label='', order=50,
                                   displayed=True, callback=None, source_registry=None)
```

| Arg | Meaning |
|---|---|
| `comp` | the tool COMP that owns the tab (stored by path **and** id) |
| `canonical` | tab id, see above |
| `panel` | the panel COMP to show; `None` = `comp` |
| `label` | strip label; defaults to `canonical` |
| `order` | strip position, default 50 (`palette` is -1 and always first) |
| `displayed` | `False` registers hidden |
| `callback` | DAT with `onPaletteTab(canonical, previous)` |
| `source_registry` | the host the tab belongs to; the healing sweep and the host's teardown then treat the tab as that host's |

Always guarded -- no registry is guaranteed to exist:

```python
reg = getattr(op, 'FNS_PALETTEREGISTRY', None)
if reg is not None and hasattr(reg, 'RegisterTab'):
    reg.RegisterTab(me.parent(), 'mytool', panel=me.parent().op('panel'), label='My Tool')
```

A host that is not the `/sys` global forwards to the global through
`_registryApi()`; with no global ready the call is a logged no-op.
`UnregisterTab(canonical)` removes a tab (aliased `UnregisterPanel`, the name
RegistryBase's host teardown calls). A host can publish **several** tabs: the
Registration pars are the first, its `Tab` sequence adds the rest (see §1).
The launcher shows one Web Render panel under `tdxlu` *and* `patreon` that
way — declared, not registered from code. Calling `RegisterTab` directly is
still available for genuinely dynamic sets; pass `source_registry=<its host>`
so the heal and teardown cascade treats the tab as that host's.

The rest of the API (all on the global):

| Method | Returns |
|---|---|
| `Tabs(include_hidden=False)` | `[{name, label, order, builtin, displayed, panel, tool, current}]`, TD's own tab first |
| `ShowTab(canonical)` / `CurrentTab()` | switch / read the current tab (`palette` is the stock one) |
| `SetTabDisplayed(canonical, displayed)` | show or hide a tab on the strip without unregistering |
| `PanelTarget(canonical)` | what the tab's mirror points at (the `selectpanel` expression target) |
| `SlotWidth()` / `SlotHeight()` | the live tab slot (dialog width, stock list height) -- what the contributed panel is sized to |
| `Resync()` | rebuild the strip and mirrors now (normally deferred) |
| `RemoveSurface()` | tear the strip and mirrors out of the dialog; the stock palette is back untouched |

## 3. Rejection rules (`_validateTab`)

Registration is refused with a `debug()` line and `{'ok': False, 'why': ...}`
(the host shows it as `Error: ...` in `Regstatus`) when:

- `comp` is None, or `canonical` is empty / not letters-digits-`_`-`-`;
- `canonical` is `palette` -- TD's own tab is built in, not a registration;
- `panel` is None, or is not a panel COMP (`isPanel`); on a host, a
  non-empty `Tab Panel` that resolves to nothing is refused before this
  (registry ≥ 0.1.2) instead of falling back to the tool COMP;
- `panel` lives under `/sys` or `/ui` -- contributed panels live in the
  project; the registry mirrors them into the dialog, it never moves them.

## 4. What the registry does with your panel

Your panel stays where it is. The dialog gets a **Select COMP mirror**
(`fnspal_<canonical>`, tag `PaletteRegistryMirror`) pointing at it, stacked in
the stock list's own slot of the dialog's `emptypanel` (a `verttb` stack:
alignorder 2.5, `layer 1`, wired to `emptypanel`'s COMP connector -- the only
way an injected panel renders inside, and above, the stock background). The
strip (`fnspal_tabs`, TD's shipped `folderTabs` widget) sits at alignorder 0.5
in the 32 px TD leaves free above the list; `fnspal_tabs_exec` forwards its
value to `ShowTab`.

A Select COMP does not push size, so the registry **sizes the panel to the
slot**: it writes `w`/`h` expressions on your panel
(`op.FNS_PALETTEREGISTRY.SlotWidth() if hasattr(op, 'FNS_PALETTEREGISTRY') else <your value>`)
and fixes `hmode`/`vmode`; the original `w`/`h` mode/expr/value is kept in the
entry and **restored on unregister**. Ship the panel with plain constants and
let your `pre_release` reset them (the launcher does) -- a released tox must
not carry expressions on a global that may not exist.

Showing a tab flips `display` on the stock ops (`list`, `pathfield`,
`explore`, `folder1`) vs the mirrors; the stock expressions are never edited.
Docked or floating makes no difference.

## 5. The callback

```python
def onPaletteTab(canonical, previous):
    """Fires on every tab change, once per distinct callback DAT (a tool
    with two tabs on one DAT hears each change once). `canonical` is the
    tab now showing -- yours, 'palette', or another tool's."""
```

Use it to start and stop what the panel costs while it is not showing (the
launcher activates its Web Render TOP only while `canonical` is one of its
own tabs, and routes the page). It runs on the main thread during the
switch -- keep it cheap. A DAT that fails to compile, or a handler that
raises, is logged and skipped; it never breaks the switch.

## 6. Nothing here is durable

`/ui` is never saved with a project and `/sys` is rebuilt on every open, so
the strip, the mirrors and every registration are **re-made on init**: the
global re-syncs the surface ~30 frames after init (`delayRef=op.TDResources`)
and every host re-applies its Registration page. Extension reinits (a save,
an edit of the master's `.py`) tear the surface down in `onDestroyTD` and
rebuild it. A project opened without any host shows a stock palette -- that is
the feature.

## 7. Shipping (pre_release)

A master or host that ships inside a tox must be inert: no `/sys` state
(`PaletteRegistryExtStored`, `PaneRegistry`, `HostCanonical` unstored),
`Regstatus` blank, `opshortcut` / `clone` / `externaltox` cleared, no
`fnspal_*` ops inside. A **host** keeps its Registration pars AND its `Tab`
sequence (they *are* the contribution); the **master** ships with both at
defaults, `Autoregister` off and no `pi_suspect` tag. The registry's own
[pre_release.py](https://github.com/function-store/FNSTools/blob/main/modules/suspects/FNSTools/FNS_PaletteRegistry/pre_release.py) does
this for a standalone export; **Embody runs only the ROOT COMP's hook**, so
the launcher's utility hook (`utility/TDXLauncherUtility/pre_release.py`,
`_scrubRegistryHost`) repeats it for both copies in a whole-utility export.

## 8. Living with the canonical copy (FNSTools)

The registry is authored in FunctionStore_tools_PUB and consumed here; this
project keeps no master of its own. What that cost the first time:

- **A lower version does not take over.** `RegistryBase._check_version_against`
  keeps the EXISTING `/sys` global unless the newcomer's `Version` is equal or
  higher, so dropping in a fresh 0.1.0 master while a local 0.1.2 global was
  live changed nothing. Retire the old master and destroy the old global, then
  re-init the new master and it promotes. Registrations do not survive that
  (a version *replace* merges them; a destroy does not) — every host
  re-registers on init, or force one with `_applyHostRegistration()`.
- **Embody's move detection re-matches orphaned rows.** Destroying the old
  master left its two `externalizations.tsv` rows without an op; the next
  reconcile bound them to the STAMPED HOST's DATs — and cleared the new
  master's own `file` / `syncfile` in the process. Fix: `remove_externalization_tag`
  on the mis-matched DATs, then restore the master's bindings by hand. A
  stamped host must carry **no** file binding at all; it is a snapshot.
- **The synced files must exist.** The master's DATs sync from FNSTools
  `modules/suspects/FNSTools/FNS_PaletteRegistry/*.py` and
  `scripts/shared/RegistryBase.py`; without those files TD warns
  "File not found for sync" and the DAT is unbacked. The master lives in
  FNSTools; this repo carries no copy of those files.
- `TDX_SearchPalette` is the proto-contribution: it already rewrites the stock
  palette in place, so it keeps doing that on the `palette` tab; the registry
  never touches the stock ops' expressions, only their `display`.
- The launcher's `TDXLUPalette` shows what a Web-Render contributor looks
  like; the contract above is all it uses.
