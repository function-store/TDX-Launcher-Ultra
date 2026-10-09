# FNS_CommandRegistry — tool command contract

How a tool registers runtime commands that surface in the TDXLU launcher's
quick-launch palette (and any other consumer). This document is
self-contained on purpose: it is the contract for the FunctionStore_tools
side (hand it to the agent working in that project), and the reference for
any tool author. The registry implementation lives in the TDXLPP repo at
`utility/TDXLauncherUtility/FNS_CommandRegistry/FNSCommandRegistryExt.py`.

## What it is

`FNS_CommandRegistry` follows the FNS registry-family shape
(`FNS_ConfigRegistry`, `FNS_ToolbarRegistry`, …):

- It ships inside the **TDXLauncherUtility** companion tox (the launcher
  injects that into sessions). The shipped copy is a *shipper*.
- On init the shipper promotes a copy of itself into the shared registry
  home **`/sys/FNS_Registries`** (`/sys/FNS_Registries/FNS_CommandRegistry`,
  alongside the FunctionStore `FNS_*Registry` globals) and that copy claims
  the global OP
  shortcut **`op.FNS_COMMANDREGISTRY`**. The global survives utility
  updates and removal for the lifetime of the TD process; a newer shipped
  version replaces an older global and carries its registrations across.
- Dormant shippers forward every call to the global, so it never matters
  which instance you reach.

A registered command says: *"here I am, I can do this and that."* The
launcher lists commands in its quick-launch overlay — under the commands
prefix (`>`) and the dedicated tools prefix (`?`) — and executes them over
the utility TCP bus. But the registry is a **generic API layer**: any
in-TD consumer (a navbar, a hotkey manager, an OSC surface) can read
`Commands()` and call `Run(key)` the same way.

## The recommended path — decorate + announce (registry ≥ 1.2.0)

Tool authorship is two touches: decorate the promoted methods, announce
once from a deferred init. Everything else is derived.

```python
FNSCommand = next(
	d for d in me.docked if 'ExtUtils' in d.tags
).mod('FNSCommand')  # import — docked, so available at class-compile time


class MyToolExt:
	@FNSCommand.fns_command(help='Set the project tempo')
	def SetBpm(self, bpm: float = 120, sync: bool = False):
		...

	def onInitTD(self):
		run('args[0]._announceCommands()', self, delayFrames=60)

	def _announceCommands(self):
		FNSCommand.announce(self.ownerComp)
```

- **The attribute is the contract, not the module.** `@fns_command` only
  sets a `_fns_command` dict on the function — pure metadata, no registry
  import, safe with no registry anywhere. The module ships in **ExtUtils**
  (master: `FNSTools/CustomParTools/QuickExt/ExtUtils/FNSCommand.py` in
  FunctionStore_tools, distributed with ExtUtils into every tool; the
  companion carries its own copy). A tool built against an older ExtUtils
  may vendor the two functions verbatim — any copy is compatible forever.
- **Everything omitted is derived at harvest**: label from the CamelCase
  method name, help from the docstring's first line, `params` from the
  signature — type hints map to styles, `typing.Literal[...]` becomes a
  menu, defaults become defaults, a missing default makes the param
  required. String annotations (PEP 563) resolve correctly.
- **`@fns_command(hidden=True)`** declares an "advanced" command:
  consumers keep it off their default listings until the user opts in
  (in the launcher: Settings → Quick Launch). Same field as the explicit
  spec's `hidden` — a default, not a secret, and user curation overrides
  it in either direction.
- **`@fns_command(state=...)`** (registry ≥ 1.6.0) declares where the
  command's live value lives — `'Parname'` or `{'method': 'GetX'}` — so
  consumers can chip it (ON/OFF on toggles, the number on setters). See
  "Live state" below for the evaluation contract.
- **`@fns_command(surface=[...], capability=...)`** (registry ≥ 1.7.0)
  target the command at additional consumer surfaces and mark it part
  of a blessed capability — see the `surface` / `capability` rows in
  the spec table. Both are pure metadata like everything else on the
  decorator; an older registry simply ignores unknown keys in the
  `_fns_command` dict, so declaring them early costs nothing.
- **`announce(comp)` = self-tag + guarded register.** The `fnscommands`
  tag is TD-native (needs no registry) and doubles as the DURABLE
  announcement: a registry that arrives later, or replaces itself on a
  version bump, rediscovers the COMP by rescanning tags and re-harvests
  the LIVE class — so registry upgrades pick up your current signatures,
  not stale specs. The registry also auto-tags on a successful harvest,
  belt-and-braces. Every ordering is covered: registry-first (announce
  lands), tool-edited-later (init re-fires announce), registry-injected
  or -replaced later (the tag).

## Explicit registration — the manual path

For specs that can't be derived (dynamic command sets, non-promoted
plumbing), register a spec list yourself. Nothing guarantees the
registry exists (no launcher, no companion, older companion), so every
call MUST be guarded and must never raise into your tool:

```python
def _registerLauncherCommands(self):
	reg = getattr(op, 'FNS_COMMANDREGISTRY', None)
	if reg is None or not hasattr(reg, 'Register'):
		return  # no registry in this session - fine
	reg.Register(self.ownerComp, self.FnsCommands())
```

`Register(owner)` with NO command list is the announce/harvest form —
the registry scans `owner` for decorated methods. Explicit-spec tools
are deliberately NOT auto-tagged (a rescan would harvest the markless
COMP and wipe the explicit set); they keep the classic legs: push on
init, plus the `fnscommands` tag ONLY if they also promote a
`FnsCommands()` method for the rescan to call.

`op.TDXLU.RegisterCommands(owner, commands)` /
`op.TDXLU.UnregisterCommands(owner)` exist as delegates on the companion
COMP and do the same thing (guard them identically); prefer the
`FNS_COMMANDREGISTRY` shortcut — it is the family idiom and works even
while the utility is being updated.

All registry methods return a dict, never raise: `{'ok': True, ...}` or
`{'ok': False, 'error': '...'}`. Check `ok` if you care; ignoring the
result is safe.

## The command spec

`Register(owner, commands)` **replaces** the owner's whole command set
(idempotent — re-register freely). `owner` is your tool's COMP (or its
path). `commands` is a list of dicts:

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique within your tool. `[A-Za-z0-9][A-Za-z0-9_-]*`, ≤48 chars |
| `label` | yes | What the user reads in the palette, ≤80 chars ("Toggle HydroHomie") |
| `method` | yes | **Promoted** (uppercase) extension method name on `owner` to call |
| `help` | no | One-line subtitle shown under the label, ≤200 chars |
| `args` | no | Positional args baked into the call (JSON-serializable) |
| `kwargs` | no | Keyword args baked into the call (JSON-serializable) |
| `params` | no | **User-suppliable** keyword arguments — consumers prompt for these (see below) |
| `hidden` | no | Tool-declared default visibility (registry ≥ 1.3.0): consumers keep the command off default listings until the user opts in — an "advanced" affordance, not a secret. User curation overrides it in either direction |
| `builtin` | no | TD/system functionality rather than a third-party tool's (registry ≥ 1.4.0): consumers list it with their native commands — the launcher badges it COMMAND, ranks it in `>` after tool commands, and keeps it out of `?`. FNS tools should not normally set it |
| `state` | no | Live state reference (registry ≥ 1.6.0): `'Parname'` (a custom par on `owner`) or `{'method': 'GetX'}` (a promoted no-arg method). Evaluated at **query time** on every `Commands()` build — see "Live state" below |
| `surface` | no | Consumer surfaces the command wants to appear on (registry ≥ 1.7.0): a token or list of tokens, lowercase alnum/underscore/dash, ≤24 chars, max 8. **Absent = exactly today's behaviour** (quick-launch only). Known surfaces: `quick`, `session` (the launcher's Current-view companion bar), `context-menu` (its session right-click menu). The registry validates shape only, never the value — consumers ignore tokens they don't serve, so new surfaces are additive |
| `capability` | no | Blessed-capability id (registry ≥ 1.7.0): a well-known namespaced marker (`fns.collect`, `fns.media-browser`, `fns.mobile-control`), lowercase alnum/dot/underscore/dash, ≤64 chars. Consumers that recognise the id may render rich native UI for the capability's command group; ones that don't fall back to generic rendering. Progressive enhancement — never a gate, never a secret |

Max 24 commands per tool. An empty list unregisters. Duplicate ids and
non-JSON-serializable args are refused with `ok: False`.

### User-suppliable arguments (`params`, registry ≥ 1.1.0)

Each entry declares one keyword argument the consumer collects from the
user before running. The launcher's quick-launch prompts for them in
order (typed values in the input, menu/toggle values as pick rows) —
and also accepts them **inline**: trailing query tokens that don't match
the command's name spill into the declared params in order, so
`? set bpm 132 on` runs immediately with `bpm=132, sync=on` when the
remaining params are covered by defaults (single-token values only;
values with spaces go through the prompt):

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Python identifier — passed to your method as a keyword |
| `style` | no | `str` (default) \| `int` \| `float` \| `toggle` \| `menu` |
| `label` | no | Prompt label, defaults to `name`, ≤40 chars |
| `required` | no | Refuse the run when no value arrives (default False) |
| `default` | no | Used when the user supplies nothing; stored coerced |
| `menu` | menu style | The legal values (≤16 entries) |
| `help` | no | One-line prompt hint, ≤120 chars |
| `current` | no | Live prefill reference (registry ≥ 1.6.0): `'Parname'` or `{'method': 'GetX'}`, evaluated at query time like `state`; consumers seed the prompt with it instead of the static `default` (which stays the fallback) |

Max 6 params per command. **The registry owns validation**: values may
arrive as strings off the wire and are coerced by declared style before
your method is called (`"0.5"` → `0.5`, `"on"` → `True`, menu values
checked against the list). A bad value or a missing required param
refuses the run with a param-named error — your method never sees it.

```python
{'id': 'set_bpm', 'label': 'Set BPM', 'method': 'SetBpm',
 'help': 'Set the project tempo',
 'params': [
	{'name': 'bpm', 'label': 'BPM', 'style': 'float',
	 'required': True, 'default': 120, 'help': 'Beats per minute'},
	{'name': 'sync', 'label': 'Resync clips', 'style': 'toggle',
	 'default': False},
 ]}
# → def SetBpm(self, bpm=120.0, sync=False): ...
```

### Live state (`state` / param `current`, registry ≥ 1.6.0)

Toggle commands are blind without their current value; value-setters are
half-blind without a prefill. Declare where the live value lives and the
registry evaluates it **while building each `Commands()` item** — always
current, no re-registration on state change, no rev churn:

```python
@fns_command(state='Active')                 # custom par on the owner COMP
def ToggleActive(self): ...

@fns_command(state={'method': 'GetVolume'})  # promoted no-arg method —
def SetVolume(self, level: float): ...       # the escape hatch for computed
                                             # state (inverse pars, child
                                             # widget values)
```

- On the wire, the evaluated result rides as `item['state']`: `True` /
  `False` for toggle pars and bool returns, a trimmed string (≤16 chars,
  floats via `%g` so `120.0` reads `120`) for everything else. Param
  `current` rides inside the param dict the same way (≤64 chars). Both
  keys are simply **absent** when undeclared or when evaluation fails —
  fully backward compatible, and a broken tool never breaks the listing.
- Existence is NOT checked at register time (owners may build pars late);
  the query-time guard covers it.
- **State references must be trivially cheap** — a par read, a one-line
  getter. They run on the main thread on every listing, for every
  command that declares one: the same spirit as the handler rule below.
- A single-param command declaring `state` gets prompt-prefill for free:
  consumers may reuse the state value when the param has no `current` of
  its own (explicit `current` wins).

**Handlers must be quick actions.** `Run` calls your method synchronously
on the main thread and relays its return value to the caller (the
launcher shows failures in the palette footer). Return nothing, a
JSON-serializable value, or a dict — a dict with `ok: False` marks the
run as failed. Never block (no I/O, no sleeps); kick long work off with
`run(..., delayFrames=1)` and return immediately.

### Multiple instances of one tool (registry ≥ 1.11.0)

Some tools live as several copies by design: two scopes, four deck
controllers, one recorder per output. Every copy registers the same ids
under its own owner path, so the registry keys stay distinct
(`/project1/scope_main#freeze`, `/project1/scope_preview#freeze`) and `Run`
always reaches the right copy. Two promoted hooks on the OWNER COMP make the
copies legible and keep curation shared:

```python
def FnsInstance(self):
	"""Short label for THIS copy, shown beside the command label."""
	return self.ownerComp.par.Target.eval() or self.ownerComp.name

def FnsToolName(self):
	"""Stable public tool name when the COMP name varies per copy."""
	return 'Scope'
```

- **`FnsInstance()`** is evaluated while building each `Commands()` item,
  the same way as `state`: always current, no re-registration when the
  label changes. The result rides as `item['instance']` (a trimmed string,
  at most 32 chars) and is absent when the hook is missing, returns
  nothing, or raises. Keep it as cheap as a state reference. Name what the
  copy acts on (its target, its output), since that is what a user picks
  between.
- **`FnsToolName()`** is read at `Register` time and replaces the default
  public name (COMP name minus a leading `FNS_`). It must match
  `[A-Za-z0-9][A-Za-z0-9_\-.]{0,63}`, otherwise the default applies.
  Without it, copies named `Scope1` and `Scope2` curate as two unrelated
  tools and a favourite on one never reaches the other. A copy whose COMP
  names already agree (the same name under different parents) does not
  need it.
- **Canonical arbitration picks a tool, not a copy.** When several
  packages declare the same `canonical` id, the winner is the winning
  *tool*, and every instance of that tool stays in the listing; only the
  losing tools are shadowed.
- **Consumers tell copies apart by `instance`**, and merge across sessions
  by `key` exactly as before (different paths never merge).

How curation treats copies:

- **Favourites and hidden/shown overrides stay on `tool#id`** and apply to
  every copy. A favourite is a machine-wide preference about a capability;
  a copy's label is project data that a different project may reuse for
  something else, so a per-copy favourite would silently star the wrong
  thing there. There is no per-copy favourite on purpose.
- **Presets may pin one copy**: the target grammar is
  `tool#id[@instance]`. An unpinned preset (`Scope#freeze`) lists once per
  live copy, each row titled with that copy's label. A pinned preset
  (`Scope#set_gain@Main out`) matches only the copy whose current
  `instance` equals the label, so it is effectively project-level: where
  no copy carries that label it stays dormant (kept, never
  deleted). Labels are compared exactly, case included.
- **Label collisions across projects**: two projects that both name a copy
  `Main out` share a pinned preset, because the file is machine-wide.
  That is usually what a user wants (the same role in a similar rig);
  when it is not, give copies project-specific labels.

## Lifecycle — the manual legs (explicit-spec tools)

Decorator tools get all of this from `announce()` and can skip this
section. Registrations are runtime state in the global registry
instance. `/sys` outlives project loads in one TD process, and entries
whose owner path no longer resolves are pruned lazily — but a *fresh*
global (first companion injection, utility version replacement, new TD
process) starts empty. To survive every load order, an explicit-spec
tool implements:

1. **Push on init** (covers: registry already present when you load, and
   re-registration after your own reinit):

```python
def onInitTD(self):
	# Deferred: the registry itself may still be promoting, and TDN
	# imports may still be rebuilding children.
	run('args[0]._registerLauncherCommands()', self, delayFrames=60)
```

2. **Rescan opt-in** (covers: registry arrives or is replaced AFTER you
   loaded — the companion is often injected post-load). Tag your COMP
   **`fnscommands`** and promote a **`FnsCommands()`** method returning
   the same spec list:

```python
def FnsCommands(self):
	"""Spec list for FNS_CommandRegistry - also called by its rescan."""
	return [
		{'id': 'toggle', 'label': 'Toggle HydroHomie',
		 'help': 'Show or hide the reminder overlay',
		 'method': 'Toggle'},
	]
```

```python
# once, at build time (or in your package's init):
me.parent().tags.add('fnscommands')
```

   Whenever a (new) global registry initializes it runs
   `root.findChildren(tags=['fnscommands'])` and registers every tagged
   COMP — via its promoted `FnsCommands()` when present, else by
   harvesting its decorated methods. With both legs in place, order
   never matters.

3. **Unregister on destroy** (optional but polite — dead owners are also
   pruned lazily):

```python
def onDestroyTD(self):
	try:
		reg = getattr(op, 'FNS_COMMANDREGISTRY', None)
		if reg is not None and hasattr(reg, 'Unregister'):
			reg.Unregister(self.ownerComp.path)  # path: comp may be mid-destroy
	except Exception:
		pass
```

## Consuming (any surface, not just the launcher)

```python
reg = getattr(op, 'FNS_COMMANDREGISTRY', None)
if reg is not None and hasattr(reg, 'Commands'):
	for c in reg.Commands():
		# {'key', 'tool', 'id', 'label', 'help', 'path', 'params'?,
		#  'hidden'?, 'builtin'?, 'state'?}
		# 'params' rides only when the command declares user arguments -
		# a consumer should collect those and pass them as kwargs.
		# 'hidden' rides only when True - keep such commands off default
		# listings unless your surface has its own opt-in.
		# 'builtin' rides only when True - TD/system functionality; list
		# it with your surface's native commands, not under tools.
		# 'state' rides only when declared AND it evaluated: True/False
		# (chip it ON/OFF) or a short string (show the value). It is
		# fresh as of this Commands() call - re-list after running a
		# state-bearing command if your surface stays open.
		# 'surface' rides only when declared - a token list naming the
		# consumer surfaces the command wants. Absent means the default
		# surface (quick-launch). Serve the tokens you recognise, ignore
		# the rest.
		# 'instance' rides only when the owner's FnsInstance() returned a
		# label (registry >= 1.11.0): several copies of one tool share
		# 'tool' and 'id', so show the label beside the command label.
		# 'capability' rides only when declared - a blessed-capability id
		# ('fns.collect'); render rich UI if you recognise it, generic
		# rendering otherwise.
		...
	reg.Run(key)                          # -> {'ok': bool, ...}
	reg.Run(key, kwargs={'seconds': '2'}) # strings fine - registry coerces
	rev = reg.Rev()                       # monotonic; bumps on every change
```

`key` is `"<owner path>#<id>"` — stable for the life of the owner COMP.
Cache against `Rev()` if you poll.

## How the launcher consumes it (for reference)

- Utility TCP bus verbs (see `utility/heartbeat/PROTOCOL.md` in TDXLPP):
  `fns_commands` → `{ok, rev, commands: [...]}` and
  `fns_run_command {key, args?, kwargs?}` → the run result. Envoy mirrors
  exist, so a session needs either the companion (≥ 0.11.0; `params` +
  kwargs coercion need ≥ 0.12.0) or Envoy.
- Quick-launch overlay: commands ride the `>` command list and own the
  `?` prefix (both user-configurable); rows show `label` + `help` with a
  TOOL badge, and declared params render as ghost chips after the label
  that fill with values as they arrive. Executed queries are kept in a
  cycling history (Alt+↑/↓), so keep labels/ids stable — they become
  users' muscle memory.
- Arguments come from the prompt flow (typed values in the input,
  menu/toggle as pick rows) or inline — trailing query tokens map onto
  the declared params (`? rec 2` → `seconds=2`) and run immediately when
  the rest is covered by defaults. Values always cross as strings; your
  method receives them coerced.
- Favourites: the user pins commands (`tool#id`, `quick_favorite_commands`
  in the launcher config) from the quick-launch (Ctrl+D or the row's ★),
  Settings → Quick Launch, or TD's palette Commands tab; favourites list
  first on bare `>` / `?` and get a ranking nudge on typed queries. Purely
  launcher-side — nothing for a tool to declare.
- Declared `state` renders as a chip after the label (ON/OFF for
  booleans, the value otherwise). Merged rows chip the resolved session's
  value, or the value all candidate sessions agree on. Typed-param
  prompts open pre-filled from `current` (or the single-param `state`
  reuse); menu/toggle option rows mark the current value instead. The
  palette refetches on every summon, so chips are fresh per summon.
- Several sessions offering the same key merge into one row with a
  session-count badge. The session the palette was summoned over (any of
  its TD windows) receives the run; when focus can't disambiguate, the
  user picks the session from a list — so identical registrations across
  sessions are fine and expected.
- The user curates visibility in the launcher's Settings: overrides are
  keyed on the `tool#id` identity (one more reason ids and COMP names
  must stay stable) and beat the spec's `hidden` default in either
  direction. Curation is launcher-side preference — the registry always
  reports everything, so other consumers can curate differently.
- Users also author **presets**: named aliases over a command with baked
  argument values, targeted by the same `tool#id` identity — so a
  renamed id orphans not just history and curation but the user's saved
  presets too. Presets bypass curation (authoring one is the opt-in) and
  run through the normal params/coercion path.
- Multi-instance tools (registry ≥ 1.11.0): each copy is its own row,
  titled `label · instance` (for example `Freeze scope · Main out`), and
  the instance is searchable. A preset over such a tool spreads to one row
  per live copy unless its target pins one (`tool#id@instance`); Settings
  offers "every copy" or "only <label>" once the tool has been seen with
  instances. The seen-command catalogue records the labels it saw
  (`instances`) so presets can be pinned while TD is closed. Favourites
  and visibility never split per copy (see the multi-instance section
  above).

## Registry API summary (promoted on the registry COMP)

| Method | Does |
|---|---|
| `Register(owner, commands=None)` | Replace owner's command set; `None` harvests decorated methods (the announce form) and auto-tags on success |
| `Unregister(owner)` | Drop owner's commands (COMP or path) |
| `Commands()` | Flat list of every registered command |
| `Run(key, args=None, kwargs=None)` | Execute one command, relay the result (declared params coerced; carries `instance` when the owner has one) |
| `Rev()` | Monotonic change counter |
| `RescanTools()` | Re-collect from `fnscommands`-tagged COMPs |
| `Version()` | Registry version (family version-compare) |
| `Repromote()` | Dev helper: force-replace the `/sys` global with this shipper's code, migrating registrations |

**Dev note (editing the registry ext itself):** the `/sys` global is a
file-detached copy, and version-compare replacement fires on the FIRST
save that bumps `REGISTRY_VERSION` — a multi-save edit session strands
the global on that intermediate state while later saves reach only the
dormant shipper. After finishing an edit run, call
`op('/TDXLauncherUtility/FNS_CommandRegistry').Repromote()` once.

The registry COMP also carries a read-only `Status` par, a `Rescan`
pulse, and a `commands` table DAT mirroring the registry for debugging.
