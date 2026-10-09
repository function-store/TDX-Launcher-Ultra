CustomParHelper: CustomParHelper = next(
	d for d in me.docked if 'ExtUtils' in d.tags
).mod('CustomParHelper').CustomParHelper  # import
###

import hashlib
import json
import os
import platform
import re
import socket
import time

# These features left the companion for the FNS package rail (D7): the
# delegating verbs stay for the deprecation window, but a project without
# the package now gets a reply that says WHERE the feature went rather than
# naming a COMP the user never installed.
MOVED = '%s now ships as the %s package - install it from the FNSTools tab'


class TDXLUUtilityExt:
	"""TDXLU companion: sync TD recents + project icons into launcher config.

	Nested module convention: when a child COMP owns user-facing settings,
	mirror the relevant custom parameters onto this COMP on a dedicated page
	(parent = edit master; child binds up; status/readouts bind down; pulses
	forward via onPar* here). Example: Heartbeat page -> ./TDXLUHeartbeat.
	Bus page owns shared TCP transport (host / TDXLU port / cmd port).

	Envoy page: keep op.Embody.par.Envoyport aligned with .embody config /
	envoy.json (written by TDXLU MCP panel or this COMP).
	"""

	# Version of THIS utility build, reported over the bus so TDXLU can offer
	# an update when its bundled copy is newer. Independent of the app version.
	# Keep in sync with utility/UTILITY_VERSION (compiled into the launcher).
	UTILITY_VERSION = '0.23.8'

	def __init__(self, ownerComp):
		CustomParHelper.Init(self, ownerComp, enable_properties=True, enable_callbacks=True)
		self.ownerComp = ownerComp
		self.icon_source = self.ownerComp.op('null_icon')
		self._envoy_mtime = None
		self._envoy_sync_running = False
		# True while LoadTox owns unwrap - skip dragDropExt double-pass
		self._load_tox_inflight = False
		self._unwrap_drop_ids = set()
		run(lambda: self.postInit(), endFrame=True)

	def postInit(self):
		# The companion belongs at the network root (see _landAtRoot): a
		# nested copy hands over to a root copy and retires, so nothing below
		# ever starts a bus, subscribes to drops or answers the launcher from
		# the wrong address.
		if self._shouldLandAtRoot() and self._landAtRoot():
			return
		self.SaveRecents()
		self.SyncEmbodyEnvoy()
		self._scheduleEnvoySync()
		self._ensureBusConnectedPar()
		self._ensureBus()
		self._ensurePaletteDropPar()
		self._ensureDragDropSubscribe()
		# Sidecar-saved window placement, once TD has finished opening the
		# project's own startup windows (see WINDOW_LAYOUT_DELAY_FRAMES).
		run(
			lambda: self._applyWindowLayoutOnLoad(),
			delayFrames=self.WINDOW_LAYOUT_DELAY_FRAMES,
		)
		# Capability announcements (docs/fns-plus-capabilities.md D6): the
		# nested tools register their blessed commands from their own init,
		# but TD initializes child extensions LAZILY — on a fresh load
		# nothing may touch TDXLUMedia, so its onInitTD never fires
		# (measured: collect announced on a fresh boot, media did not).
		# THIS extension always initializes (it runs the bus), so nudge
		# them once the registry's own promotion has settled. Touching the
		# ext forces init; registration is idempotent.
		run('args[0]._announceChildCapabilities()', self, delayFrames=90)

	# --- root landing ------------------------------------------------------

	# The companion's address is `/TDXLauncherUtility`: the launcher's bus,
	# the docs and the FNSTools boundary all put it at the network root beside
	# `/FNSTools` (which FNS declares as `placement: "root"` in its manifest).
	# A drag-drop, though, lands a .tox wherever the network editor happened
	# to be showing — so a copy that wakes up nested re-lands itself at `/`
	# and retires. Same convention FNS registries use to reach their `/sys`
	# home (RegistryBase._become_global_registry): copy into the home, then
	# destroy the original a few frames out through a delayRef that outlives
	# it — never from inside our own init.

	KEEP_NESTED_TAG = 'tdxlu_keepnested'
	# TD's own areas: a copy parked there is deliberate (a cooking-disabled
	# verification load, a registry parking spot), never a placement.
	_STAGING_ROOTS = ('/sys', '/local', '/ui')
	# Root children that are TD's own plumbing, not layout neighbours.
	_ROOT_PLUMBING = ('sys', 'ui', 'local')

	def _shouldLandAtRoot(self):
		"""True when this copy sits anywhere but the network root."""
		comp = self.ownerComp
		try:
			parent = comp.parent()
			if parent is None or parent.path == '/':
				return False
		except Exception:
			return False
		try:
			if self.KEEP_NESTED_TAG in comp.tags:
				return False
		except Exception:
			pass
		path = comp.path or ''
		for staging in self._STAGING_ROOTS:
			if path.startswith(staging + '/'):
				return False
		try:
			if not parent.allowCooking:
				return False
		except Exception:
			pass
		return True

	def _rootLandingName(self, root):
		"""Our name at the root, uniquified when an incumbent already holds it."""
		name = self.ownerComp.name
		if root.op(name) is None:
			return name
		i = 1
		while root.op('%s%d' % (name, i)) is not None:
			i += 1
		debug(
			f'TDXLUUtility: /{name} already exists — landing this copy as '
			f'{name}{i}; delete whichever one you do not want'
		)
		return '%s%d' % (name, i)

	def _landAtRoot(self):
		"""Copy ourselves to `/`, then retire this misplaced copy.

		True when the hand-over started — the caller must stop initializing,
		so the retiring copy never binds the bus or subscribes to drops.
		"""
		comp = self.ownerComp
		root = op('/')
		if root is None:
			return False
		try:
			landed = root.copy(comp, name=self._rootLandingName(root))
		except Exception as e:
			debug(f'TDXLUUtility: could not land at root: {e}')
			return False
		if landed is None:
			return False
		try:
			landed.allowCooking = True
		except Exception:
			pass
		# One tidy column at the root: below the lowest neighbour, spaced by
		# our own height so a tall COMP never overlaps what is already there.
		try:
			sibs = [
				c for c in root.children
				if c is not landed and c.name not in self._ROOT_PLUMBING
			]
			if sibs:
				step = ((int(landed.nodeHeight) + 100 + 199) // 200) * 200
				landed.nodeX = int(min(c.nodeX for c in sibs))
				landed.nodeY = int(min(c.nodeY for c in sibs)) - step
			else:
				landed.nodeX = 0
				landed.nodeY = 0
		except Exception:
			pass
		# The only thing selected at the root, and current.
		try:
			for c in root.children:
				if c is not landed and c.selected:
					c.selected = False
			landed.current = True
			landed.selected = True
		except Exception:
			pass
		self._revealLanded(landed, comp.parent())
		debug(f'TDXLUUtility: re-landed {comp.path} at {landed.path}')
		# Our extension DAT travels with the copy, so the destroy must not be
		# owned by the DAT it destroys.
		try:
			run('args[0].valid and args[0].destroy()', comp,
				delayFrames=5, delayRef=op.TDResources)
		except Exception:
			run('args[0].valid and args[0].destroy()', comp, delayFrames=5)
		return True

	def _revealLanded(self, landed, dropNetwork):
		"""Follow a re-landed drop to the root: every network editor that was
		showing `dropNetwork` moves to `/` and centres on `landed`.

		Otherwise the drop looks as if it vanished. Only panes showing the
		drop network move — the network a drag-drop lands in is the one
		under the mouse — so a load-time re-landing, which nobody is looking
		at, leaves the user's view alone. Same rule as FNSTools' reveal()
		for its own nested drops.
		"""
		if dropNetwork is None:
			return
		try:
			dropPath = dropNetwork.path
			root = landed.parent()
		except Exception:
			return
		for pane in ui.panes:
			try:
				if (pane.type == PaneType.NETWORKEDITOR
						and pane.owner is not None
						and pane.owner.path == dropPath):
					pane.owner = root
					pane.home(zoom=False, op=landed)
			except Exception as e:
				debug(f'TDXLUUtility: could not show {landed.path} in a pane: {e}')

	def onDestroyTD(self):
		# Best-effort farewell so the launcher drops this peer immediately
		# instead of waiting out the hello-staleness window (deleting the
		# utility from a project otherwise reads as "loaded" for seconds).
		# Fires on extension reinit too — the fresh instance re-hellos within
		# ~2s, so the blip is invisible at the launcher's poll cadence. During
		# comp deletion / TD quit the wire may already be gone; never raise.
		try:
			self._sendBusLine({
				'type': 'bye',
				'v': 1,
				'id': self._projectWatchId(),
				'utility': True,
			})
		except Exception:
			pass

	def _heartbeat(self):
		return self.ownerComp.op('TDXLUHeartbeat')

	# --- Utility TCP bus via TCP/IP DATs (no Python sockets) ---------------

	CMD_PORT_SPAN = 100

	def _cmdPortBase(self):
		try:
			if hasattr(self.ownerComp.par, 'Hbcmdport'):
				return int(self.ownerComp.par.Hbcmdport.eval())
		except Exception:
			pass
		return 12000

	def _cmdPort(self):
		"""Actual bound command port (may be base+N when multiple Utilities are open)."""
		bound = getattr(self, '_cmd_port_bound', None)
		if bound:
			return int(bound)
		cmd = self.ownerComp.op('tcpip_cmd')
		if cmd:
			try:
				return int(cmd.par.port.eval())
			except Exception:
				pass
		return self._cmdPortBase()

	def _setBusStatus(self, msg):
		text = str(msg)[:120]
		try:
			if hasattr(self.ownerComp.par, 'Busstatus'):
				self.ownerComp.par.Busstatus.val = text
		except Exception:
			pass
		# Legacy fallback if Busstatus missing (older tox)
		try:
			if not hasattr(self.ownerComp.par, 'Busstatus') and hasattr(
				self.ownerComp.par, 'Hbstatus'
			):
				self.ownerComp.par.Hbstatus.val = text
		except Exception:
			pass

	def _refreshBusStatus(self, hello_ok=None):
		"""Stable bus readout: cmd bind + last hello result (no tcpip_out flap)."""
		cmd = getattr(self, '_cmd_port_bound', None)
		if cmd is None:
			cmd_op = self.ownerComp.op('tcpip_cmd')
			if cmd_op:
				try:
					cmd = int(cmd_op.par.port.eval())
				except Exception:
					cmd = '?'
			else:
				cmd = '?'
		parts = [f'Cmd :{cmd}']
		if hello_ok is True:
			parts.append('Hello ok')
		elif hello_ok is False:
			parts.append('Hello down')
		self._setBusStatus(' | '.join(parts))
		# hello_ok None = a bind-time refresh with no hello attempted; leave the
		# lamp alone rather than blinking it off on every rebind.
		if hello_ok is not None:
			try:
				if hasattr(self.ownerComp.par, 'Busconnected'):
					self.ownerComp.par.Busconnected.val = 1 if hello_ok else 0
			except Exception:
				pass

	def _busHostPort(self):
		"""TDXLU listen address (Utility -> launcher). Shared - many Utilities may connect out."""
		host, port = '127.0.0.1', 11999
		hb = self._heartbeat()
		if hb:
			try:
				host = (hb.par.Host.eval() or host).strip() or host
				port = int(hb.par.Port.eval())
			except Exception:
				pass
		else:
			try:
				if hasattr(self.ownerComp.par, 'Hbhost'):
					host = (self.ownerComp.par.Hbhost.eval() or host).strip() or host
				if hasattr(self.ownerComp.par, 'Hbport'):
					port = int(self.ownerComp.par.Hbport.eval())
			except Exception:
				pass
		return host, port

	def _projectWatchId(self):
		hb = self._heartbeat()
		if hb:
			try:
				return hb.ProjectWatchId()
			except Exception:
				pass
		try:
			folder = project.folder  # type: ignore[name-defined]
			name = project.name  # type: ignore[name-defined]
		except Exception:
			return None
		if not folder or not name:
			return None
		toe = name if str(name).lower().endswith('.toe') else f'{name}.toe'
		p = os.path.normpath(os.path.abspath(os.path.join(folder, toe)))
		if p.startswith('\\\\?\\'):
			p = p[4:]
		p = p.replace('\\', '/')
		if os.name == 'nt':
			p = p.lower()
		return p

	def _ensureBus(self):
		"""Configure tcpip_cmd (server) + tcpip_out (client) + hello timer.

		Operators must exist in the Utility network (TD-native TCP/IP DATs).
		"""
		cmd = self.ownerComp.op('tcpip_cmd')
		out = self.ownerComp.op('tcpip_out')
		if cmd is None or out is None:
			self._setBusStatus('Missing tcpip_cmd / tcpip_out')
			debug('TDXLUUtility: create tcpip_cmd + tcpip_out DATs')
			return
		host, port = self._busHostPort()
		try:
			out.par.mode = 'client'
			out.par.address = host
			out.par.port = port
			out.par.format = 'perline'
			# Exclusive socket - Shared Connection fights multi-bind / leftover listeners.
			if hasattr(out.par, 'shared'):
				out.par.shared = False
			out.par.active = True
		except Exception as e:
			debug(f'TDXLUUtility: tcpip_out config: {e}')
		self._bindCmdServer(cmd)
		self._ensureHelloTimer()

	def _opHasErrors(self, o):
		try:
			errs = o.errors(recurse=False)
			if errs:
				return True
		except Exception:
			pass
		try:
			return int(o['errors']) > 0 if hasattr(o, '__getitem__') else False
		except Exception:
			return False

	def _bindCmdServer(self, cmd):
		"""Activate tcpip_cmd as server on first free port in Hbcmdport span."""
		base = self._cmdPortBase()
		end = min(base + int(self.CMD_PORT_SPAN), 65535)
		self._cmd_port_bound = None
		try:
			cmd.par.active = False
		except Exception:
			pass
		if hasattr(cmd.par, 'shared'):
			cmd.par.shared = False
		for port in range(base, end):
			# Probe with a raw socket BEFORE handing the port to the DAT: the
			# TCP/IP DAT binds asynchronously, so its error flag right after a
			# forced cook is not trustworthy — a taken port could scan as
			# "bound" (hijacking a peer's traffic) or poison every later
			# attempt with a stale error. EADDRINUSE from a plain bind is
			# synchronous and unambiguous on every platform.
			try:
				probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
				try:
					probe.bind(('127.0.0.1', port))
				finally:
					probe.close()
			except OSError:
				continue
			try:
				cmd.par.active = False
				cmd.par.mode = 'server'
				cmd.par.localaddress = '127.0.0.1'
				cmd.par.port = port
				cmd.par.format = 'perline'
				if hasattr(cmd.par, 'shared'):
					cmd.par.shared = False
				cmd.par.active = True
				cmd.cook(force=True)
			except Exception as e:
				debug(f'TDXLUUtility: tcpip_cmd :{port}: {e}')
				continue
			if self._opHasErrors(cmd):
				try:
					cmd.par.active = False
				except Exception:
					pass
				continue
			self._cmd_port_bound = port
			self._refreshBusStatus()
			return
		self._setBusStatus(
			f'Cmd ports exhausted ({base}-{end - 1}) - close a TD or raise Command Port base'
		)

	def _ensureHelloTimer(self):
		timer = self.ownerComp.op('timer_hello')
		if timer is None:
			return
		try:
			timer.par.length = 2
			timer.par.lengthunits = 'seconds'
			timer.par.cycle = True
			# Default Cycle Limit + Max Cycles=4 kills hellos after ~8s -> peer goes stale.
			if hasattr(timer.par, 'cyclelimit'):
				timer.par.cyclelimit = False
			timer.par.play = True
			timer.bypass = False
			try:
				timer.par.initialize.pulse()
				timer.par.start.pulse()
			except Exception:
				pass
		except Exception as e:
			debug(f'TDXLUUtility: timer_hello: {e}')

	def _sendBusLine(self, payload):
		"""Send one JSON object on tcpip_out (hello / heartbeat)."""
		out = self.ownerComp.op('tcpip_out')
		if out is None:
			return False
		try:
			if not out.par.active.eval():
				out.par.active = True
			line = json.dumps(payload)
			out.send(line, terminator='\n')
			return True
		except Exception as e:
			debug(f'TDXLUUtility: tcpip_out send: {e}')
			return False

	def _sendBusHello(self):
		"""Presence pulse so TDXLU knows this session + cmd_port (not gated by Hbactive)."""
		wid = self._projectWatchId()
		if not wid:
			self._refreshBusStatus(hello_ok=False)
			return False
		if not getattr(self, '_cmd_port_bound', None):
			cmd = self.ownerComp.op('tcpip_cmd')
			if cmd:
				self._bindCmdServer(cmd)
			if not getattr(self, '_cmd_port_bound', None):
				self._refreshBusStatus(hello_ok=False)
				return False
		ok = self._sendBusLine({
			'type': 'hello',
			'v': 1,
			'id': wid,
			'path': wid,
			'utility': True,
			'utility_version': self.UTILITY_VERSION,
			'cmd_port': self._cmdPort(),
			# The rename-proof session key: the launcher's recorded path goes
			# stale on Increment and Save, but this process id matches its
			# session row no matter what the project file is called today.
			'td_pid': os.getpid(),
		})
		self._refreshBusStatus(hello_ok=bool(ok))
		return ok

	def _handleCmdLine(self, line):
		"""Parse one cmd JSON line from tcpip_cmd onReceive. Returns result dict."""
		my_id = self._projectWatchId()
		result = {'type': 'result', 'v': 1, 'ok': False, 'error': 'bad request'}
		try:
			msg = json.loads(line) if line else None
		except Exception:
			msg = None
		if not isinstance(msg, dict) or msg.get('type') != 'cmd':
			return result
		req = msg.get('req')
		action = (msg.get('action') or '').strip().lower()
		target = (msg.get('id') or '').strip()
		result['req'] = req
		if target and my_id and target.replace('\\', '/').lower() != my_id.lower():
			return {
				'type': 'result',
				'v': 1,
				'req': req,
				'ok': False,
				'error': f'id mismatch (this={my_id})',
				'id': my_id,
				'cmd_port': self._cmdPort(),
			}
		try:
			if action == 'save':
				result = {**(self.SaveProject() or {}), 'type': 'result', 'v': 1, 'req': req}
			elif action == 'pulse':
				result = {**(self.PulseIcon() or {}), 'type': 'result', 'v': 1, 'req': req}
			elif action == 'record':
				result = {**(self.RecordPreview() or {}), 'type': 'result', 'v': 1, 'req': req}
			elif action in ('load_tox', 'loadtox'):
				tox_path = (
					msg.get('tox_path') or msg.get('path') or msg.get('tox') or ''
				)
				persist = bool(msg.get('persist', False))
				parent = (msg.get('parent') or '').strip() or None
				externaltox = bool(msg.get('externaltox', False))
				toxfile_module = (
					msg.get('toxfile_module')
					or msg.get('toxfileModule')
					or msg.get('module')
					or ''
				)
				toxfile_module = str(toxfile_module).strip() or None
				result = {
					**(self.LoadTox(
						tox_path,
						persist=persist,
						parent=parent,
						externaltox=externaltox,
						toxfile_module=toxfile_module,
					) or {}),
					'type': 'result',
					'v': 1,
					'req': req,
				}
			elif action in ('ensure_pyenv', 'setup_pyenv'):
				result = {
					**(self.EnsurePythonEnv() or {}),
					'type': 'result',
					'v': 1,
					'req': req,
				}
			elif action == 'pyenv_status':
				result = {
					**(self.PythonEnvStatus() or {}),
					'type': 'result',
					'v': 1,
					'req': req,
				}
			elif action in ('ensure_tdpyenv', 'ensure_tdpyenvmanager'):
				result = {
					**(self.EnsureTdPyEnvManager() or {}),
					'type': 'result',
					'v': 1,
					'req': req,
				}
			elif action in ('update_utility', 'updateutility'):
				tox_path = msg.get('tox_path') or msg.get('path') or ''
				result = {
					**(self.UpdateUtility(tox_path) or {}),
					'type': 'result',
					'v': 1,
					'req': req,
				}
			elif action in ('panes', 'get_panes'):
				result = {**(self.GetPanes() or {}), 'type': 'result', 'v': 1, 'req': req}
			elif action in ('windows', 'get_windows', 'getwindows'):
				result = {**(self.GetWindows() or {}), 'type': 'result', 'v': 1, 'req': req}
			elif action in ('window_set', 'windowset'):
				fields = msg.get('fields')
				result = {
					**(self.SetWindow(
						msg.get('path'),
						fields if isinstance(fields, dict) else {},
						show=msg.get('open'),
					) or {}),
					'type': 'result',
					'v': 1,
					'req': req,
				}
			elif action in ('window_apply', 'windowapply'):
				items = msg.get('items')
				result = {
					**(self.ApplyWindowLayout(
						items if isinstance(items, list) else None,
					) or {}),
					'type': 'result',
					'v': 1,
					'req': req,
				}
			elif action in ('window_save', 'windowsave'):
				paths = msg.get('paths')
				result = {
					**(self.SaveWindowLayout(
						paths if isinstance(paths, list) else None,
						apply_on_load=bool(msg.get('apply_on_load', True)),
					) or {}),
					'type': 'result',
					'v': 1,
					'req': req,
				}
			elif action in ('window_clear', 'windowclear'):
				result = {**(self.ClearWindowLayout() or {}), 'type': 'result', 'v': 1, 'req': req}
			elif action in ('repoint_assets', 'repointassets'):
				dry = bool(msg.get('dry_run', False))
				include = msg.get('include')
				if include is not None and not isinstance(include, list):
					include = None
				result = {
					**(self.RepointAssets(dry_run=dry, include=include) or {}),
					'type': 'result',
					'v': 1,
					'req': req,
				}
			elif action in ('palette_refresh', 'paletterefresh'):
				result = {
					**(self.PaletteRefresh() or {}),
					'type': 'result', 'v': 1, 'req': req,
				}
			elif action in ('sidecar_get', 'sidecarget'):
				result = {**(self.SidecarGet() or {}), 'type': 'result', 'v': 1, 'req': req}
			elif action in ('sidecar_set', 'sidecarset'):
				fields = msg.get('fields')
				if not isinstance(fields, dict):
					# Also accept the authoring keys at the top level, the
					# same flat shape media_replace / control_set use.
					fields = {
						k: msg[k] for k in self._SIDECAR_KEYS if k in msg
					}
				result = {
					**(self.SidecarSet(fields) or {}),
					'type': 'result', 'v': 1, 'req': req,
				}
			elif action in ('sidecar_hero', 'sidecarhero'):
				result = {
					**(self.SidecarHeroFromPreview() or {}),
					'type': 'result', 'v': 1, 'req': req,
				}
			elif action == 'perf':
				result = {**(self.PerfStats() or {}), 'type': 'result', 'v': 1, 'req': req}
			elif action in ('control_schema', 'controlschema'):
				result = {**(self.ControlSchema() or {}), 'type': 'result', 'v': 1, 'req': req}
			elif action in ('control_get', 'controlget'):
				result = {**(self.ControlGet() or {}), 'type': 'result', 'v': 1, 'req': req}
			elif action in ('control_set', 'controlset'):
				sets = msg.get('sets')
				if sets is None and msg.get('par'):
					sets = [{
						'target': msg.get('target') or msg.get('key') or '',
						'par': msg.get('par'),
						'value': msg.get('value'),
					}]
				result = {**(self.ControlSet(sets) or {}), 'type': 'result', 'v': 1, 'req': req}
			elif action in ('control_comps', 'controlcomps'):
				result = {
					**(self.ControlComps(msg.get('parent')) or {}),
					'type': 'result', 'v': 1, 'req': req,
				}
			elif action in ('control_add', 'controladd'):
				result = {
					**(self.ControlAddComp(msg.get('comp') or msg.get('path')) or {}),
					'type': 'result', 'v': 1, 'req': req,
				}
			elif action in ('control_remove', 'controlremove'):
				result = {
					**(self.ControlRemoveComp(msg.get('key')) or {}),
					'type': 'result', 'v': 1, 'req': req,
				}
			elif action in ('fns_install', 'fnsinstall'):
				result = {
					**(self.FnsInstall(
						msg.get('selection') or msg.get('selection_path'),
						bootstrap_path=msg.get('bootstrap')
						or msg.get('bootstrap_path'),
						parent=msg.get('parent'),
					) or {}),
					'type': 'result', 'v': 1, 'req': req,
				}
			elif action in ('fns_status', 'fnsstatus'):
				result = {**(self.FnsStatus() or {}), 'type': 'result', 'v': 1, 'req': req}
			elif action in ('fns_settings_url', 'fnssettingsurl'):
				result = {
					**(self.FnsSettingsUrl(ensure=bool(msg.get('ensure', True))) or {}),
					'type': 'result', 'v': 1, 'req': req,
				}
			elif action in ('fns_commands', 'fnscommands'):
				result = {**(self.ListCommands() or {}), 'type': 'result', 'v': 1, 'req': req}
			elif action in ('fns_run_command', 'fnsruncommand'):
				result = {
					**(self.RunCommand(
						msg.get('key') or msg.get('command') or '',
						args=msg.get('args'),
						kwargs=msg.get('kwargs'),
					) or {}),
					'type': 'result', 'v': 1, 'req': req,
				}
			elif action in ('palette_url', 'paletteurl'):
				result = {
					**(self.PaletteSetUrl(msg.get('url') or '') or {}),
					'type': 'result', 'v': 1, 'req': req,
				}
			elif action in ('palette_status', 'palettestatus'):
				result = {**(self.PaletteStatus() or {}), 'type': 'result', 'v': 1, 'req': req}
			elif action in ('selection', 'get_selection', 'selected'):
				result = {**(self.Selection() or {}), 'type': 'result', 'v': 1, 'req': req}
			elif action in ('toolbox_save_selected', 'toolboxsaveselected'):
				result = {
					**(self.ToolboxSaveSelected(msg.get('dir') or '', name=msg.get('name')) or {}),
					'type': 'result', 'v': 1, 'req': req,
				}
			elif action in ('ping', 'version', 'info'):
				result = {
					'type': 'result',
					'v': 1,
					'req': req,
					'ok': True,
					'utility': True,
					'utility_version': self.UTILITY_VERSION,
					'id': my_id,
					'cmd_port': self._cmdPort(),
					'td_pid': os.getpid(),
					# Capability flag: this build understands palette_url /
					# palette_status (an older utility answers 'unknown action').
					'palette': self._paletteTabs() is not None,
				}
			else:
				result = {
					'type': 'result',
					'v': 1,
					'req': req,
					'ok': False,
					'error': f'unknown action: {action}',
				}
		except Exception as e:
			result = {
				'type': 'result',
				'v': 1,
				'req': req,
				'ok': False,
				'error': str(e),
			}
		return result

	# --- Remote control panel (Control page) -------------------------------
	# The Control page sequence exposes chosen COMPs' custom parameters to the
	# launcher; the perform section exposes the perform Window COMP's built-in
	# parameters. ControlSet only writes what the schema currently exposes.

	_CONTROL_OP_STYLES = (
		'OP', 'COMP', 'PanelCOMP', 'Object', 'TOP', 'CHOP', 'SOP', 'DAT',
		'MAT', 'POP',
	)

	def _setControlStatus(self, msg):
		try:
			if hasattr(self.ownerComp.par, 'Controlstatus'):
				self.ownerComp.par.Controlstatus.val = str(msg)[:120]
		except Exception:
			pass

	def _performWindowComp(self):
		"""Window COMP for the perform section. Explicit par wins; blank =
		auto: root 'perform' child when it is a Window COMP, else the first
		Window COMP found near root."""
		par = getattr(self.ownerComp.par, 'Performwindow', None)
		w = par.eval() if par is not None else None
		if w is not None:
			return w if w.OPType == 'windowCOMP' else None
		w = root.op('perform')
		if w is not None and w.OPType == 'windowCOMP':
			return w
		wins = root.findChildren(type=windowCOMP, maxDepth=2)
		return wins[0] if wins else None

	def _controlTargets(self):
		"""Resolved control sources: active sequence blocks + perform window."""
		targets = []
		seq = getattr(self.ownerComp.seq, 'Control', None)
		if seq is not None:
			for i, b in enumerate(seq.blocks):
				try:
					if not b.par.Active.eval():
						continue
					comp = b.par.Comp.eval()
					if comp is None:
						continue
					targets.append({
						'key': f'block{i}',
						'comp': comp,
						'pages': str(b.par.Pages.eval() or '').strip() or '*',
						'pars': str(b.par.Pars.eval() or '').strip() or '*',
						'builtin': False,
					})
				except Exception:
					continue
		try:
			expose = getattr(self.ownerComp.par, 'Exposeperform', None)
			if expose is not None and expose.eval():
				w = self._performWindowComp()
				if w is not None:
					pages = ''
					if hasattr(self.ownerComp.par, 'Performpages'):
						pages = str(self.ownerComp.par.Performpages.eval() or '').strip()
					pars = ''
					if hasattr(self.ownerComp.par, 'Performpars'):
						pars = str(self.ownerComp.par.Performpars.eval() or '').strip()
					targets.append({
						'key': 'perform',
						'comp': w,
						'pages': pages or 'Window',
						'pars': pars or '*',
						'builtin': True,
					})
		except Exception:
			pass
		return targets

	def _controlTargetPars(self, target):
		"""Parameters of one target matched by its page/name filters."""
		comp = target['comp']
		pages = comp.pages if target['builtin'] else comp.customPages
		matched_pages = set(tdu.match(target['pages'], [pg.name for pg in pages]))
		out = []
		for pg in pages:
			if pg.name not in matched_pages:
				continue
			pars = [p for p in pg.pars if p.valid and p.style != 'Header']
			# Match par names AND ParGroup (tuplet) names, so 'winoffset'
			# pulls in winoffsetx/winoffsety and 'Color' the whole RGB group.
			keep = set(tdu.match(target['pars'], [p.name for p in pars]))
			keep |= {
				p.name
				for p in pars
				if p.tupletName and tdu.match(target['pars'], [p.tupletName])
			}
			out.extend(p for p in pars if p.name in keep)
		return out

	def _controlConfigFingerprint(self):
		"""Cheap tuple of everything on the Control page that shapes the
		resolved par list -- a change invalidates the resolve cache."""
		u = self.ownerComp
		parts = []
		seq = getattr(u.seq, 'Control', None)
		if seq is not None:
			for b in seq.blocks:
				try:
					parts.append((
						str(b.par.Comp.val),
						str(b.par.Pages.val),
						str(b.par.Pars.val),
						bool(b.par.Active.eval()),
					))
				except Exception:
					parts.append(None)
		for name in ('Exposeperform', 'Performwindow', 'Performpages', 'Performpars'):
			p = getattr(u.par, name, None)
			parts.append(str(p.val) if p is not None else None)
		return tuple(parts)

	def _resolvedControlTargets(self, use_cache=True):
		"""Targets with their matched Par objects. The filter matching
		(tdu.match over every page/par name) is the expensive part of a
		1 Hz poll, so the result is cached until the Control page config
		changes or a cached Par goes invalid (target deleted/rebuilt).
		ControlSchema resolves fresh, so target-side par additions surface
		on the panel's periodic schema refresh."""
		fp = self._controlConfigFingerprint()
		cache = getattr(self, '_control_cache', None)
		if use_cache and cache and cache.get('fp') == fp:
			fresh = True
			for t in cache['targets']:
				for p in t['pars']:
					try:
						if not p.valid:
							fresh = False
							break
					except Exception:
						fresh = False
						break
				if not fresh:
					break
			if fresh:
				return cache['targets']
		targets = []
		for t in self._controlTargets():
			try:
				pars = self._controlTargetPars(t)
			except Exception:
				continue
			targets.append({**t, 'pars': pars})
		self._control_cache = {'fp': fp, 'targets': targets}
		return targets

	def _controlParValue(self, par):
		try:
			if par.style == 'Pulse':
				return None
			if par.style in self._CONTROL_OP_STYLES:
				return str(par.val)
			v = par.eval()
			if isinstance(v, (bool, int, float, str)):
				return v
			if hasattr(v, 'path'):
				return v.path
			return str(v)
		except Exception:
			return None

	def _controlParDescriptor(self, par):
		d = {
			'name': par.name,
			'label': par.label,
			'style': par.style,
			'page': par.page.name,
			'mode': par.mode.name,
			'value': self._controlParValue(par),
			'enabled': bool(par.enable),
			'readonly': bool(par.readOnly),
			'tuplet': par.tupletName,
			'vecindex': par.vecIndex,
			'tupletsize': len(par.tuplet),
		}
		if par.style in ('Float', 'Int'):
			d.update({
				'min': par.min,
				'max': par.max,
				'clampmin': bool(par.clampMin),
				'clampmax': bool(par.clampMax),
				'normmin': par.normMin,
				'normmax': par.normMax,
			})
		if par.style in ('Menu', 'StrMenu'):
			d['menunames'] = list(par.menuNames)
			d['menulabels'] = list(par.menuLabels)
		if par.style != 'Pulse':
			try:
				dv = par.default
				d['default'] = dv if isinstance(dv, (bool, int, float, str)) else str(dv)
			except Exception:
				pass
		return d

	def ControlSchema(self):
		"""Full exposed-parameter schema for the TDXLU control panel."""
		out = []
		n_pars = 0
		for t in self._resolvedControlTargets(use_cache=False):
			pars = t['pars']
			if not pars:
				continue
			n_pars += len(pars)
			out.append({
				'key': t['key'],
				'path': self._compPath(t['comp']),
				'name': t['comp'].name,
				'builtin': t['builtin'],
				'pars': [self._controlParDescriptor(p) for p in pars],
			})
		sig = json.dumps(
			[[t['path'], [(p['name'], p['style']) for p in t['pars']]] for t in out],
			sort_keys=True,
		)
		self._setControlStatus(f'{len(out)} comp(s) / {n_pars} par(s) exposed')
		return {
			'ok': True,
			'targets': out,
			'hash': hashlib.md5(sig.encode()).hexdigest()[:12],
		}

	def ControlGet(self):
		"""Current values of all exposed parameters (cheap poll companion)."""
		out = []
		for t in self._resolvedControlTargets():
			out.append({
				'key': t['key'],
				'path': self._compPath(t['comp']),
				'values': {p.name: self._controlParValue(p) for p in t['pars']},
			})
		return {'ok': True, 'targets': out}

	def _controlCoerce(self, par, value):
		"""Coerce an incoming wire value for one parameter; raises ValueError."""
		if par.style == 'Toggle':
			if isinstance(value, str):
				return 1 if value.strip().lower() in ('1', 'true', 'on', 'yes') else 0
			return 1 if value else 0
		if par.style == 'Int':
			return int(float(value))
		if par.style == 'Float':
			return float(value)
		if par.style == 'Menu':
			names = list(par.menuNames)
			if isinstance(value, (int, float)) and not isinstance(value, bool):
				idx = int(value)
				if 0 <= idx < len(names):
					return names[idx]
				raise ValueError(f'menu index {idx} out of range')
			if str(value) in names:
				return str(value)
			raise ValueError(f'invalid menu value {value!r} (valid: {names})')
		return str(value)

	def ControlSet(self, sets):
		"""Write values to exposed parameters only.

		sets: list of {'target': key-or-path, 'par': name, 'value': any}.
		Pulse pars fire regardless of value. Refuses parameters outside the
		current schema, read-only pars, and pars not in constant mode (a
		write would silently destroy the expression/bind/export).
		"""
		if isinstance(sets, dict):
			sets = [sets]
		if not isinstance(sets, list) or not sets:
			return {'ok': False, 'error': 'control_set requires sets: [{target, par, value}]'}
		exposed = {}
		for t in self._resolvedControlTargets():
			pars = {p.name: p for p in t['pars']}
			path = self._compPath(t['comp'])
			exposed.setdefault(t['key'], pars)
			if path:
				exposed.setdefault(path, pars)
		results = []
		ok_all = True
		for item in sets:
			if not isinstance(item, dict):
				ok_all = False
				results.append({'ok': False, 'error': 'bad set item'})
				continue
			tkey = str(item.get('target') or item.get('key') or '')
			pname = str(item.get('par') or '')
			r = {'target': tkey, 'par': pname, 'ok': False}
			pars = exposed.get(tkey)
			par = pars.get(pname) if pars else None
			if par is None:
				r['error'] = 'parameter not exposed by control schema'
			elif par.readOnly:
				r['error'] = 'parameter is read-only'
			elif par.style == 'Pulse':
				par.pulse()
				r['ok'] = True
			elif par.mode.name != 'CONSTANT':
				r['error'] = f'parameter is in {par.mode.name} mode -- write refused'
			else:
				try:
					par.val = self._controlCoerce(par, item.get('value'))
					r['ok'] = True
					r['value'] = self._controlParValue(par)
				except Exception as e:
					r['error'] = str(e)
			if not r['ok']:
				ok_all = False
			results.append(r)
		return {'ok': ok_all, 'results': results}

	def ControlComps(self, parent=None):
		"""ONE layer of the COMP tree, lazily: the immediate COMP children of
		`parent` (root when omitted). Each entry carries its custom-parameter
		count (`pars` — what it would expose) and `has_children` (whether it has
		COMP children to expand). The remote walks the tree a layer at a time
		instead of scanning the whole network up front. Excludes this utility
		and anything inside it; marks comps already targeted by a Control block."""
		targeted = set()
		for t in self._controlTargets():
			p = self._compPath(t['comp'])
			if p:
				targeted.add(p)
		me = self.ownerComp
		me_prefix = me.path + '/'
		base = op(str(parent)) if parent else root
		if base is None or not hasattr(base, 'findChildren'):
			return {'ok': False, 'error': 'no COMP at %r' % (parent,)}
		try:
			children = base.findChildren(type=COMP, maxDepth=1)
		except Exception as e:
			return {'ok': False, 'error': str(e)}
		out = []
		for c in children:
			try:
				# Skip the utility itself and anything inside it. Ancestors are
				# NOT skipped — you must be able to traverse through them.
				if c is me or c.path.startswith(me_prefix):
					continue
				n_pars = sum(
					1 for pg in c.customPages
					for p in pg.pars if p.valid and p.style != 'Header'
				)
				try:
					has_children = len(c.findChildren(type=COMP, maxDepth=1)) > 0
				except Exception:
					has_children = False
				# Keep anything actionable (has params) or traversable (has COMPs).
				if n_pars == 0 and not has_children:
					continue
				out.append({
					'path': c.path,
					'name': c.name,
					'pars': n_pars,
					'added': c.path in targeted,
					'has_children': has_children,
				})
			except Exception:
				continue
			if len(out) >= 400:
				break
		out.sort(key=lambda x: x['name'].lower())
		return {'ok': True, 'parent': ('' if parent is None else base.path), 'comps': out}

	def ControlAddComp(self, path):
		"""Expose a COMP remotely: point a Control-sequence block at it.
		Reuses the first empty block before growing the sequence; the stored
		reference is relative to this utility so the project stays portable."""
		comp = op(str(path or ''))
		if comp is None or not comp.isCOMP:
			return {'ok': False, 'error': f'no COMP at {path!r}'}
		for t in self._controlTargets():
			if t['comp'] is comp:
				return {'ok': True, 'already': True, 'key': t['key']}
		seq = getattr(self.ownerComp.seq, 'Control', None)
		if seq is None:
			return {'ok': False, 'error': 'utility has no Control sequence'}
		block = None
		for b in seq.blocks:
			try:
				if not str(b.par.Comp.val).strip():
					block = b
					break
			except Exception:
				continue
		if block is None:
			seq.numBlocks += 1
			block = seq.blocks[seq.numBlocks - 1]
		block.par.Comp = self.ownerComp.relativePath(comp)
		block.par.Pages = '*'
		block.par.Pars = '*'
		block.par.Active = True
		self._control_cache = None
		return {'ok': True, 'key': f'block{block.index}'}

	def ControlRemoveComp(self, key):
		"""Stop exposing one Control-sequence block (by its schema key,
		'blockN'). The perform window is a toggle, not a block -- refused
		here. A lone remaining block is cleared instead of destroyed so the
		sequence never fights its minimum block count."""
		key = str(key or '')
		if not key.startswith('block'):
			return {'ok': False, 'error': f'not a removable target: {key!r}'}
		try:
			idx = int(key[len('block'):])
		except ValueError:
			return {'ok': False, 'error': f'bad target key: {key!r}'}
		seq = getattr(self.ownerComp.seq, 'Control', None)
		if seq is None or not (0 <= idx < seq.numBlocks):
			return {'ok': False, 'error': f'no Control block {idx}'}
		if seq.numBlocks > 1:
			seq.destroyBlock(idx)
		else:
			b = seq.blocks[idx]
			b.par.Comp = ''
			b.par.Pages = '*'
			b.par.Pars = '*'
			b.par.Active = True
		self._control_cache = None
		return {'ok': True}

	def onParHbsendnow(self):
		hb = self._heartbeat()
		if hb:
			hb.SendHeartbeat()

	def onParHbcopyid(self):
		hb = self._heartbeat()
		if hb:
			hb.CopyWatchId()

	def onParHbactive(self):
		hb = self._heartbeat()
		if hb:
			hb.ext.TDXLUHeartbeatExt._syncTimer()

	def onParHbinterval(self):
		hb = self._heartbeat()
		if hb:
			hb.ext.TDXLUHeartbeatExt._syncTimer()

	# --- Embody / Envoy -------------------------------------------------

	def _embody(self):
		try:
			return op.Embody  # type: ignore[name-defined]
		except Exception:
			pass
		try:
			return self.ownerComp.parent().op('Embody')
		except Exception:
			return None

	def _findEmbodyProjectRoot(self):
		"""Walk up from the .toe folder for .embody / .mcp.json."""
		try:
			folder = project.folder  # type: ignore[name-defined]
		except Exception:
			return None
		cur = os.path.abspath(folder)
		for _ in range(8):
			if os.path.isdir(os.path.join(cur, '.embody')) or os.path.isfile(
				os.path.join(cur, '.mcp.json')
			):
				return cur
			parent = os.path.dirname(cur)
			if parent == cur:
				break
			cur = parent
		return None

	def _readDesiredEnvoyPort(self, root):
		"""Prefer .embody/config.json Envoyport, else envoy.json instance port."""
		config_path = os.path.join(root, '.embody', 'config.json')
		envoy_path = os.path.join(root, '.embody', 'envoy.json')
		mtime = 0.0
		for p in (config_path, envoy_path):
			try:
				mtime = max(mtime, os.path.getmtime(p))
			except OSError:
				pass

		port = None
		if os.path.isfile(config_path):
			try:
				with open(config_path, 'r', encoding='utf-8') as f:
					cfg = json.load(f)
				val = (cfg.get('params') or {}).get('Envoyport') or {}
				if isinstance(val, dict) and 'val' in val:
					port = int(val['val'])
				elif isinstance(val, (int, float)):
					port = int(val)
			except Exception as e:
				debug(f'TDXLUUtility: Envoy config read failed: {e}')

		if port is None and os.path.isfile(envoy_path):
			try:
				with open(envoy_path, 'r', encoding='utf-8') as f:
					ej = json.load(f)
				active = ej.get('active')
				instances = ej.get('instances') or {}
				inst = instances.get(active) if active else None
				if not inst and instances:
					inst = next(iter(instances.values()))
				if inst and 'port' in inst:
					port = int(inst['port'])
			except Exception as e:
				debug(f'TDXLUUtility: envoy.json read failed: {e}')

		return port, mtime

	def _writeDesiredEnvoyPort(self, root, port):
		"""Mirror port into Embody config + envoy registry + .mcp.json args."""
		port = int(port)
		embody_dir = os.path.join(root, '.embody')
		os.makedirs(embody_dir, exist_ok=True)

		config_path = os.path.join(embody_dir, 'config.json')
		cfg = {}
		if os.path.isfile(config_path):
			try:
				with open(config_path, 'r', encoding='utf-8') as f:
					cfg = json.load(f)
			except Exception:
				cfg = {}
		params = cfg.setdefault('params', {})
		entry = params.get('Envoyport')
		if not isinstance(entry, dict):
			entry = {}
		entry['val'] = port
		params['Envoyport'] = entry
		with open(config_path, 'w', encoding='utf-8') as f:
			json.dump(cfg, f, indent=2)
			f.write('\n')

		envoy_path = os.path.join(embody_dir, 'envoy.json')
		if os.path.isfile(envoy_path):
			try:
				with open(envoy_path, 'r', encoding='utf-8') as f:
					ej = json.load(f)
				active = ej.get('active')
				instances = ej.setdefault('instances', {})
				key = active if active in instances else (next(iter(instances)) if instances else None)
				if key:
					instances.setdefault(key, {})['port'] = port
					with open(envoy_path, 'w', encoding='utf-8') as f:
						json.dump(ej, f, indent=2)
						f.write('\n')
			except Exception as e:
				debug(f'TDXLUUtility: envoy.json write failed: {e}')

		mcp_path = os.path.join(root, '.mcp.json')
		if os.path.isfile(mcp_path):
			try:
				with open(mcp_path, 'r', encoding='utf-8') as f:
					mcp = json.load(f)
				servers = mcp.get('mcpServers') or {}
				for _name, server in servers.items():
					args = server.get('args')
					if isinstance(args, list):
						for i, a in enumerate(args):
							if a == '--port' and i + 1 < len(args):
								args[i + 1] = str(port)
								break
					url = server.get('url')
					if isinstance(url, str) and '://' in url:
						# http://127.0.0.1:9870/mcp
						try:
							pre, rest = url.split('://', 1)
							hostport, _, pathrest = rest.partition('/')
							host, _, _old = hostport.rpartition(':')
							if host:
								server['url'] = f'{pre}://{host}:{port}/{pathrest}'
						except Exception:
							pass
				with open(mcp_path, 'w', encoding='utf-8') as f:
					json.dump(mcp, f, indent=2)
					f.write('\n')
			except Exception as e:
				debug(f'TDXLUUtility: .mcp.json write failed: {e}')

	def SyncEmbodyEnvoy(self):
		"""Apply desired Envoy port from disk onto op.Embody (and Utility readout)."""
		root = self._findEmbodyProjectRoot()
		if not root:
			self._setEnvoyStatus('No .embody project root')
			return False

		port, mtime = self._readDesiredEnvoyPort(root)
		if port is None:
			self._setEnvoyStatus('No Envoy port in config')
			return False

		# Keep Utility page in sync (constant) without fighting user mid-edit
		try:
			if hasattr(self.ownerComp.par, 'Envoyport'):
				cur = int(self.ownerComp.par.Envoyport.eval())
				if cur != port and self._envoy_mtime != mtime:
					self.ownerComp.par.Envoyport.val = port
		except Exception:
			pass

		embody = self._embody()
		if embody is None:
			self._setEnvoyStatus(f'Port {port} (Embody not found)')
			self._envoy_mtime = mtime
			return False

		try:
			par = embody.par.Envoyport
			current = int(par.eval())
			if current != port:
				par.val = port
				self._setEnvoyStatus(f'Set Embody Envoyport={port}')
			else:
				self._setEnvoyStatus(f'Embody Envoyport={port}')
			self._envoy_mtime = mtime
			return True
		except Exception as e:
			self._setEnvoyStatus(f'Embody error: {e}')
			return False

	def ApplyEnvoyPort(self, port=None):
		"""Write Utility Envoyport to disk + Embody."""
		if port is None:
			try:
				port = int(self.ownerComp.par.Envoyport.eval())
			except Exception:
				port = 9870
		port = max(1024, min(65535, int(port)))
		root = self._findEmbodyProjectRoot()
		if not root:
			self._setEnvoyStatus('No .embody project root')
			return False
		try:
			self._writeDesiredEnvoyPort(root, port)
		except Exception as e:
			self._setEnvoyStatus(f'Write failed: {e}')
			return False
		embody = self._embody()
		if embody is not None:
			try:
				embody.par.Envoyport.val = port
			except Exception as e:
				debug(f'TDXLUUtility: Embody set failed: {e}')
		self._envoy_mtime = None
		self.SyncEmbodyEnvoy()
		self._setEnvoyStatus(f'Applied port {port}')
		return True

	def _setEnvoyStatus(self, msg):
		try:
			self.ownerComp.par.Envoystatus.val = str(msg)[:120]
		except Exception:
			pass

	def _scheduleEnvoySync(self):
		if self._envoy_sync_running:
			return
		self._envoy_sync_running = True

		def tick():
			# Idle rate. Embody is an optional third-party package, so MOST
			# projects have no .embody at all -- there the 2s poll was walking
			# up to 8 directories stat-ing the disk on the main thread forever,
			# to reach the same answer every time. Back off to 30s whenever
			# there is nothing to sync (no root, no port, no Embody COMP), and
			# return to 2s the moment a sync succeeds. The Sync From Disk pulse
			# still checks immediately, so installing Embody later is picked up
			# without restarting TD.
			delay = 30000
			try:
				auto = True
				try:
					auto = bool(self.evalEnvoysync)
				except Exception:
					pass
				if auto and self.SyncEmbodyEnvoy():
					delay = 2000
			finally:
				run(tick, delayMilliSeconds=delay)

		run(tick, delayMilliSeconds=2000)

	def onParEnvoysyncnow(self):
		self.SyncEmbodyEnvoy()

	def onParEnvoyapply(self):
		self.ApplyEnvoyPort()

	def onParEnvoyport(self):
		# Live edit from Utility page -> push to Embody + disk
		try:
			if bool(self.evalEnvoyapplylive):
				self.ApplyEnvoyPort()
		except Exception:
			pass

	# --- Recents / icons ------------------------------------------------

	def getConfigPath(self, app='tdxlu'):
		"""Return config.json path for TDXLU or the sibling Plus app."""
		system = platform.system()
		if app == 'plus':
			if system == 'Windows':
				base = os.environ.get('APPDATA', os.path.expanduser('~'))
				config_dir = os.path.join(base, 'TD Launcher Plus')
			elif system == 'Darwin':
				config_dir = os.path.expanduser('~/.config/td-launcher')
			else:
				xdg = os.environ.get('XDG_CONFIG_HOME', os.path.expanduser('~/.config'))
				config_dir = os.path.join(xdg, 'td-launcher')
		else:
			if system == 'Windows':
				base = os.environ.get('APPDATA', os.path.expanduser('~'))
				config_dir = os.path.join(base, 'TDXLU')
			elif system == 'Darwin':
				config_dir = os.path.expanduser('~/.config/tdxlu')
			else:
				xdg = os.environ.get('XDG_CONFIG_HOME', os.path.expanduser('~/.config'))
				config_dir = os.path.join(xdg, 'tdxlu')
		return os.path.join(config_dir, 'config.json')

	def loadConfig(self, path):
		if not os.path.exists(path):
			return {}
		try:
			with open(path, 'r', encoding='utf-8') as f:
				return json.load(f)
		except Exception as e:
			debug(f'TDXLUUtility: Error loading {path}: {e}')
			return {}

	def _writeTdRecents(self, path):
		"""Merge app.recentFiles into config.json as td_recents (preserves other keys)."""
		config = self.loadConfig(path)
		config['td_recents'] = list(app.recentFiles)
		config['td_recents_timestamp'] = time.time()
		os.makedirs(os.path.dirname(path), exist_ok=True)
		with open(path, 'w', encoding='utf-8') as f:
			json.dump(config, f, indent=2)
		return path

	def SaveRecents(self):
		"""Write TD recent files into TDXLU config; optionally mirror to Plus."""
		written = []
		try:
			written.append(self._writeTdRecents(self.getConfigPath('tdxlu')))
			mirror = True
			try:
				mirror = bool(self.evalMirrorplus)
			except Exception:
				pass
			if mirror:
				written.append(self._writeTdRecents(self.getConfigPath('plus')))
			self._setLastSync(f'OK {time.strftime("%H:%M:%S")} -> {len(written)} file(s)')
		except Exception as e:
			debug(f'TDXLUUtility: Error saving recents: {e}')
			self._setLastSync(f'Error: {e}')

	def _setLastSync(self, msg):
		try:
			self.ownerComp.par.Lastsync.val = str(msg)[:120]
		except Exception:
			pass

	def onParSaverecents(self):
		self.SaveRecents()

	def SaveIcon(self, is_temp=True):
		"""
		Save {project_base_name}_icon.png or {project_base_name}_icon_temp.png
		beside the .toe so TDXLU can pick a unique icon per project.
		"""
		if is_temp and not self.evalSavetempicon:
			return

		name = project.name
		if name.lower().endswith('.toe'):
			name = name[:-4]

		# Strip TD version suffix (Project.1 -> Project)
		if '.' in name:
			parts = name.rsplit('.', 1)
			if parts[1].isdigit():
				name = parts[0]

		suffix = '_icon_temp' if is_temp else '_icon'
		filename = f'{name}{suffix}.png'
		self.icon_source.save(
			filename,
			quality=0.5,
			metadata=[
				('source', 'TDXLUUtility'),
				('project_name', project.name),
			],
		)
		return os.path.join(project.folder, filename)

	# --- Project / media (callable from TDXLU via Envoy) -----------------

	def _projectStem(self):
		name = project.name
		if name.lower().endswith('.toe'):
			name = name[:-4]
		if '.' in name:
			parts = name.rsplit('.', 1)
			if parts[1].isdigit():
				name = parts[0]
		return name

	def _setMediaStatus(self, msg):
		"""Surface status on Media page (fallback to Busstatus)."""
		text = str(msg)[:200]
		try:
			if hasattr(self.ownerComp.par, 'Recstatus'):
				self.ownerComp.par.Recstatus.val = text[:120]
			elif hasattr(self.ownerComp.par, 'Busstatus'):
				self.ownerComp.par.Busstatus.val = text[:120]
		except Exception:
			pass
		try:
			print(f'[TDXLU Utility] {text}')
		except Exception:
			pass
		try:
			debug(f'TDXLU Utility: {text}')
		except Exception:
			pass

	MEDIA_DIRNAME = 'preview'

	def _mediaFolder(self):
		"""Absolute preview folder beside the .toe, created on demand.

		Deliberately NOT keyed to the project name: a name derived from
		project.name orphans its previews the moment the .toe is renamed.
		A project owns its folder, so a fixed child name is unambiguous.

		Absolute is for os-level work and for paths handed back to TDXLU,
		which resolves them out-of-process. Never store this in a parameter -
		use _mediaPath's relative form for that.
		"""
		folder = os.path.join(project.folder, self.MEDIA_DIRNAME)
		os.makedirs(folder, exist_ok=True)
		return folder.replace('\\', '/')

	def _mediaPath(self, filename):
		"""Return (relative, absolute) for a file in the preview folder.

		Relative is what goes into parameters and TOP.save() - TD resolves it
		against project.folder, so the project stays portable when moved.
		Absolute goes over the wire to TDXLU only.
		"""
		return (
			f'{self.MEDIA_DIRNAME}/{filename}',
			f'{self._mediaFolder()}/{filename}',
		)

	def SaveProject(self):
		"""Save the current .toe (Envoy / TDXLU remote)."""
		try:
			project.save()
			self._setMediaStatus('Project saved')
			return {'ok': True, 'name': project.name}
		except Exception as e:
			self._setMediaStatus(f'Save failed: {e}')
			return {'ok': False, 'error': str(e)}

	# --- Repoint Assets (delegates to ./TDXLURepoint) ----------------------
	# Same shape as Collect: the logic lives in the nested TDXLURepoint COMP
	# so it also works standalone. It re-roots relative refs that a change
	# of project folder broke - a .toe opened from Backup/ sits one level
	# deeper than the folder it was saved from, so 'assets/clip.mov' now
	# misses. Unlike Collect it copies nothing and saves nothing, so it
	# needs no chunking and has no status action to poll.

	def _repointer(self):
		return self.ownerComp.op('TDXLURepoint')

	def RepointAssets(self, dry_run=False, include=None):
		"""Re-root relative refs broken by a folder move (see TDXLURepoint)."""
		r = self._repointer()
		if r is None:
			return {'ok': False, 'error': 'TDXLURepoint missing'}
		return r.RepointAssets(dry_run=dry_run, include=include)

	# --- Project sidecar ({stem}.tdxlu.json) -------------------------------
	# The launcher's per-project metadata file, written beside the .toe:
	# tags, title, description, hero (launcher README -> Sidecar schema).
	# These verbs let the artist author it from inside TD - the Media page
	# fields and the bus sidecar_get / sidecar_set both land here. Writes
	# MERGE: only the keys handed in are touched, every other key (media_dir,
	# media[], anything future) passes through untouched, so TD-side edits
	# never clobber launcher-side ones. Plain last-write-wins beyond that -
	# the launcher re-reads with cache-busting, so no locking is needed.

	# Sidecar keys this COMP may write. Everything else is launcher (or
	# future) territory and survives a merge untouched.
	_SIDECAR_KEYS = ('title', 'description', 'tags', 'hero')

	def _sidecarPath(self):
		"""(path, exists) - EXACTLY the launcher's resolution (project_meta.rs).

		Candidates: full stem first, then the unversioned base when the stem
		ends in a numeric increment ('Show.7' -> 'Show'). The first candidate
		that exists on disk wins; with none on disk, the full stem names the
		file a write would create.
		"""
		stem = project.name
		if stem.lower().endswith('.toe'):
			stem = stem[:-4]
		stems = [stem]
		if '.' in stem:
			base, ver = stem.rsplit('.', 1)
			if ver.isdigit():
				stems.append(base)
		for s in stems:
			p = os.path.join(project.folder, f'{s}.tdxlu.json')
			if os.path.isfile(p):
				return p.replace('\\', '/'), True
		p = os.path.join(project.folder, f'{stems[0]}.tdxlu.json')
		return p.replace('\\', '/'), False

	def _readSidecar(self, path):
		"""Parsed sidecar dict, or {} when absent. Raises on unparseable."""
		if not os.path.isfile(path):
			return {}
		with open(path, 'r', encoding='utf-8') as f:
			data = json.load(f)
		if not isinstance(data, dict):
			raise ValueError('sidecar is not a JSON object')
		return data

	def _sidecarMerge(self, fields):
		"""Merge top-level keys into the sidecar and write it.

		A value of None removes its key. Like every write here this is a
		MERGE: keys this build does not know (the launcher's, a future
		version's) pass through untouched. An unparseable sidecar is refused
		rather than overwritten - it is user data.
		"""
		if not isinstance(fields, dict) or not fields:
			return {'ok': False, 'error': 'no fields to merge'}
		path, existed = self._sidecarPath()
		try:
			data = self._readSidecar(path)
		except Exception as e:
			return {'ok': False, 'error': f'{path}: {e} - not overwritten'}
		for key, val in fields.items():
			if val is None:
				data.pop(key, None)
			else:
				data[key] = val
		data.setdefault('version', 1)
		try:
			with open(path, 'w', encoding='utf-8') as f:
				json.dump(data, f, indent=2, ensure_ascii=False)
				f.write('\n')
		except Exception as e:
			return {'ok': False, 'error': f'{path}: {e}'}
		return {'ok': True, 'path': path, 'created': not existed}

	def SidecarGet(self):
		"""The project's sidecar metadata (bus sidecar_get / Media page load)."""
		path, exists = self._sidecarPath()
		try:
			data = self._readSidecar(path)
		except Exception as e:
			return {'ok': False, 'error': f'{path}: {e}', 'path': path}
		return {'ok': True, 'path': path, 'exists': exists, 'meta': data}

	def SidecarSet(self, fields):
		"""Merge fields into the sidecar and write it (bus sidecar_set).

		fields holds any of title / description / hero (string; empty or None
		removes the key) and tags (list of strings; empty list removes).
		Unknown keys in fields are refused rather than silently written -
		this COMP only owns the authoring fields.
		"""
		if not isinstance(fields, dict) or not fields:
			return {'ok': False, 'error': 'no fields to set'}
		unknown = [k for k in fields if k not in self._SIDECAR_KEYS]
		if unknown:
			return {'ok': False, 'error': f'not sidecar authoring keys: {unknown}'}
		path, existed = self._sidecarPath()
		try:
			data = self._readSidecar(path)
		except Exception as e:
			# An unparseable sidecar is user data - never overwrite it with a
			# merge that could not read what it is merging into.
			return {'ok': False, 'error': f'{path}: {e} - not overwritten'}
		for key, val in fields.items():
			if key == 'tags':
				tags = [str(t).strip() for t in (val or []) if str(t).strip()]
				if tags:
					data['tags'] = tags
				else:
					data.pop('tags', None)
			else:
				text = str(val).strip() if val is not None else ''
				if text:
					data[key] = text
				else:
					data.pop(key, None)
		data.setdefault('version', 1)
		try:
			with open(path, 'w', encoding='utf-8') as f:
				json.dump(data, f, indent=2, ensure_ascii=False)
				f.write('\n')
		except Exception as e:
			return {'ok': False, 'error': f'{path}: {e}'}
		return {
			'ok': True, 'path': path, 'created': not existed, 'meta': data,
		}

	def _setSidecarStatus(self, msg):
		try:
			if hasattr(self.ownerComp.par, 'Sidecarstatus'):
				self.ownerComp.par.Sidecarstatus.val = str(msg)[:120]
		except Exception:
			pass

	def _sidecarParFields(self):
		"""The four authoring fields as the Media-page pars hold them."""
		par = self.ownerComp.par

		def text(name):
			p = getattr(par, name, None)
			return str(p.eval()).strip() if p is not None else ''
		tags = [
			t for t in re.split(r'[,\s]+', text('Sidecartags')) if t
		]
		return {
			'title': text('Sidecartitle'),
			'description': text('Sidecardescription'),
			'tags': tags,
			'hero': text('Sidecarhero'),
		}

	def onParSidecarload(self):
		"""Pull the sidecar into the Media-page fields (explicit, never auto -
		a load must not stomp edits the user is mid-way through)."""
		res = self.SidecarGet()
		if not res.get('ok'):
			self._setSidecarStatus(f'Load failed: {res.get("error")}')
			return
		meta = res.get('meta') or {}
		par = self.ownerComp.par
		for name, key in (
			('Sidecartitle', 'title'),
			('Sidecardescription', 'description'),
			('Sidecarhero', 'hero'),
		):
			p = getattr(par, name, None)
			if p is not None:
				p.val = str(meta.get(key) or '')
		p = getattr(par, 'Sidecartags', None)
		if p is not None:
			p.val = ' '.join(meta.get('tags') or [])
		self._setSidecarStatus(
			f'Loaded {os.path.basename(res["path"])}'
			if res.get('exists') else 'No sidecar yet - fields cleared'
		)

	def onParSidecarsave(self):
		"""Write the Media-page fields to the sidecar. Empty fields clear
		their keys; everything this COMP does not author is preserved."""
		res = self.SidecarSet(self._sidecarParFields())
		if res.get('ok'):
			self._setSidecarStatus(
				('Created ' if res.get('created') else 'Saved ')
				+ os.path.basename(res['path'])
			)
		else:
			self._setSidecarStatus(f'Save failed: {res.get("error")}')

	def onParSidecarusepreview(self):
		res = self.SidecarHeroFromPreview()
		if res.get('ok'):
			hero = (res.get('meta') or {}).get('hero') or ''
			p = getattr(self.ownerComp.par, 'Sidecarhero', None)
			if p is not None:
				p.val = hero
			self._setSidecarStatus(f'Hero -> {hero}')
		else:
			self._setSidecarStatus(f'Hero failed: {res.get("error")}')

	def SidecarHeroFromPreview(self):
		"""Point the sidecar hero at preview/preview.png, capturing one if absent.

		The relative path is what goes in the sidecar (the launcher resolves
		it against the project folder), so the project stays portable.
		"""
		rel, abs_path = self._mediaPath('preview.png')
		if not os.path.isfile(abs_path):
			res = self.PulseIcon() or {}
			if not res.get('ok'):
				return res or {'ok': False, 'error': 'preview capture failed'}
			# TOP.save() lands across a real frame advance - a same-frame
			# re-stat would falsely miss the capture that just succeeded, so
			# trust PulseIcon's ok and write the known relative path.
		return self.SidecarSet({'hero': rel})

	def PerfStats(self):
		"""Live performance snapshot from perform_stats for the launcher's Current tab."""
		if not bool(self.ownerComp.par.Perfactive.eval()):
			return {'ok': False, 'error': 'Perf stats disabled (Perfactive off)'}
		perf = self.ownerComp.op('perform_stats')
		if perf is None:
			return {'ok': False, 'error': 'perform_stats CHOP missing'}

		def chan(name):
			# Output channel names differ from the enabling parameter names
			# (dropped_frames vs droppedframes); sampled on demand, so the
			# CHOP costs nothing between launcher polls.
			try:
				c = perf[name]
				return float(c.eval()) if c is not None else None
			except Exception:
				return None

		return {
			'ok': True,
			'fps': chan('fps'),
			'cook_ms': chan('msec'),
			# Drops since the previous frame - instantaneous, never cumulative.
			'dropped': chan('dropped_frames'),
			'gpu_mem_mb': chan('gpu_mem_used'),
			'gpu_mem_total_mb': chan('total_gpu_mem'),
			'cpu_mem_mb': chan('cpu_mem_used'),
			'cook_rate': chan('cookrate'),
		}

	# --- Window placement (launcher verbs `windows` / `window_set`) --------
	# Which display a window opens on is a PROJECT setting, not a launch
	# option: TouchDesigner has no command-line argument for window placement.
	# The only monitor-adjacent flags are GPU affinity (-gpuformonitor /
	# -gpubusid), and those bind the PROCESS to a card, not a window to a
	# screen - the wiki is explicit that you must still keep the windows on
	# that GPU's monitors yourself. So the launcher hands placement here, to
	# the one thing already inside the running session: this COMP reads and
	# writes the Window COMP parameters that actually decide it, and can
	# re-apply a layout saved in the project sidecar when the project loads.
	#
	# https://docs.derivative.ca/Window_COMP
	# https://docs.derivative.ca/Using_Multiple_Graphic_Cards

	# Protocol field -> (parameter, kind, legal menu names). Menu names are
	# carried so a bad value comes back as an error listing the choices,
	# rather than TD quietly keeping the old one.
	_WINDOW_FIELDS = {
		'display': ('display', 'int', None),
		'justify_to': (
			'justifyoffsetto', 'menu',
			('primarydisplay', 'specifydisplay', 'alldisplays'),
		),
		'justifyh': ('justifyh', 'menu', ('left', 'center', 'right', 'mouse')),
		'justifyv': ('justifyv', 'menu', ('top', 'center', 'bottom', 'mouse')),
		'offsetx': ('winoffsetx', 'float', None),
		'offsety': ('winoffsety', 'float', None),
		'size': ('size', 'menu', ('automatic', 'fill', 'custom', 'exclusive')),
		'winw': ('winw', 'int', None),
		'winh': ('winh', 'int', None),
		'single': ('single', 'menu', ('off', 'singledisplay', 'cursordisplay')),
		'borders': ('borders', 'bool', None),
		'alwaysontop': ('alwaysontop', 'bool', None),
	}

	# Frames to wait before applying a saved layout on load. TD opens the
	# project's own startup windows (Window Placement Dialog) during the first
	# frames; re-placing before that lands would simply be overwritten.
	WINDOW_LAYOUT_DELAY_FRAMES = 90

	def _windowComps(self):
		"""Window COMPs a user could place, project-wide, path-sorted.

		`/sys` and `/ui` hold TouchDesigner's own internal windows - moving
		those is not placement, it is breaking the editor - and this COMP's
		own subtree is skipped the way it is everywhere else here.
		"""
		try:
			# No depth cap, and NOT `depth=` -- findChildren's `depth` means
			# EXACTLY that level, so a bounded search silently misses windows
			# (including `/perform`, which sits at depth 1 while a tool's
			# popup window sits eight levels down).
			found = op('/').findChildren(type=windowCOMP)
		except Exception:
			return []
		mine = self._compPath(self.ownerComp) or ''
		keep = []
		for w in found:
			path = self._compPath(w) or ''
			if path.startswith('/sys') or path.startswith('/ui'):
				continue
			if mine and (path == mine or path.startswith(mine + '/')):
				continue
			keep.append(w)
		keep.sort(key=lambda c: self._compPath(c) or '')
		return keep

	def _windowPar(self, w, par_name):
		return getattr(w.par, par_name, None)

	def _windowPrimary(self, path):
		"""Whether this is a window a user would actually place.

		A real project has a handful: `/perform`, plus any Window COMP the
		user built (`/project1/bloom/window_ramp`). Everything else in a
		loaded palette is a component's own popup/dialog plumbing - one
		project here has THIRTY of them, from menus and file dialogs inside
		installed tools. They are still returned (hiding a window the user
		does want would be worse), just flagged, so the launcher can group
		them away and a layout save does not swallow them.

		Depth is the honest discriminator available: TD gives no flag for
		'this window belongs to a component's internals', and the palette
		comps here carry no External Tox or tag to key off. Project-level
		windows sit within three path segments; tool internals sit four to
		nine deep.
		"""
		return len([seg for seg in (path or '').split('/') if seg]) <= 3

	def _windowState(self, w):
		"""One Window COMP as the launcher sees it: placement + live geometry."""
		path = self._compPath(w)
		state = {'path': path, 'name': w.name, 'primary': self._windowPrimary(path)}
		for key, (par_name, kind, _menu) in self._WINDOW_FIELDS.items():
			par = self._windowPar(w, par_name)
			if par is None:
				continue
			try:
				val = par.eval()
			except Exception:
				continue
			if kind == 'menu':
				state[key] = str(par.val)
			elif kind == 'bool':
				state[key] = bool(val)
			elif kind == 'int':
				state[key] = int(val)
			else:
				state[key] = float(val)
			# A placement par driven by an expression cannot be written
			# without destroying it, so say so up front instead of failing
			# only when the launcher tries.
			try:
				if par.mode.name != 'CONSTANT':
					state.setdefault('locked', []).append(key)
			except Exception:
				pass
		try:
			winop = w.par.winop.eval()
			state['winop'] = self._compPath(winop) if winop is not None else None
		except Exception:
			state['winop'] = None
		try:
			state['open'] = bool(w.isOpen)
		except Exception:
			state['open'] = False
		if state['open']:
			# Live geometry, in TD's bottom-left-origin screen coordinates.
			for member in ('x', 'y', 'width', 'height', 'scalingMonitorIndex'):
				try:
					state[member] = int(getattr(w, member))
				except Exception:
					pass
		return state

	def GetWindows(self):
		"""Every placeable Window COMP with its current placement (verb `windows`).

		Also returns the saved sidecar layout, so the launcher can show what
		this project would restore on load next to what it is doing now.
		Every window is listed; `primary` flags the ones worth showing first.
		"""
		try:
			windows = [self._windowState(w) for w in self._windowComps()]
		except Exception as e:
			return {'ok': False, 'error': f'windows scan: {e}'}
		return {'ok': True, 'windows': windows, 'layout': self._sidecarWindowLayout()}

	def _coerceWindowField(self, key, value):
		"""(coerced, error) for one protocol field."""
		spec = self._WINDOW_FIELDS.get(key)
		if spec is None:
			return None, f'unknown window field {key!r}'
		_par_name, kind, menu = spec
		try:
			if kind == 'menu':
				name = str(value).strip().lower()
				if name not in menu:
					return None, f'{key}: expected one of {list(menu)}, got {value!r}'
				return name, None
			if kind == 'bool':
				return bool(value), None
			if kind == 'int':
				return int(value), None
			return float(value), None
		except Exception as e:
			return None, f'{key}: {e}'

	def SetWindow(self, path, fields=None, show=None):
		"""Place one Window COMP, and optionally open or close it (verb `window_set`).

		Only the fields handed in are touched. A parameter that is not in
		CONSTANT mode is refused rather than written - the same rule the
		Control page follows, so a write can never silently destroy an
		expression, bind or export. `show` True pulses Open as Separate
		Window, False pulses Close.
		"""
		target = (path or '').strip()
		if not target:
			return {'ok': False, 'error': 'window_set requires path'}
		w = op(target)
		if w is None:
			return {'ok': False, 'error': f'{target}: no such operator'}
		if w.type != 'window' or not w.isCOMP:
			return {'ok': False, 'error': f'{target}: not a Window COMP'}
		if w not in self._windowComps():
			return {'ok': False, 'error': f'{target}: not a placeable window'}

		fields = fields if isinstance(fields, dict) else {}
		applied, errors = {}, []
		for key, value in fields.items():
			coerced, err = self._coerceWindowField(key, value)
			if err:
				errors.append(err)
				continue
			par_name = self._WINDOW_FIELDS[key][0]
			par = self._windowPar(w, par_name)
			if par is None:
				errors.append(f'{key}: no {par_name} parameter on {target}')
				continue
			if par.readOnly:
				errors.append(f'{key}: parameter is read-only')
				continue
			try:
				if par.mode.name != 'CONSTANT':
					errors.append(f'{key}: parameter is in {par.mode.name} mode -- write refused')
					continue
				par.val = coerced
				applied[key] = coerced
			except Exception as e:
				errors.append(f'{key}: {e}')

		opened = None
		if show is not None:
			try:
				if show:
					w.par.winopen.pulse()
					opened = True
				else:
					w.par.winclose.pulse()
					opened = False
			except Exception as e:
				errors.append(f'open: {e}')

		result = {
			'ok': not errors,
			'path': self._compPath(w),
			'applied': applied,
			'window': self._windowState(w),
		}
		if opened is not None:
			result['opened'] = opened
		if errors:
			result['error'] = '; '.join(errors)
			result['errors'] = errors
		return result

	def ApplyWindowLayout(self, items=None):
		"""Apply a saved layout (verb `window_apply`, and the on-load restore).

		`items` defaults to the sidecar's. Each item is a `window_set` payload
		with a `path`. Windows named in the layout that no longer exist are
		reported, not raised - a layout outlives the project it was saved from.
		Only `open: true` acts; a closed-at-save window is left as it is.
		"""
		if items is None:
			items = (self._sidecarWindowLayout() or {}).get('items') or []
		if not isinstance(items, list):
			return {'ok': False, 'error': 'window layout items must be a list'}
		results, missing = [], []
		for item in items:
			if not isinstance(item, dict):
				continue
			path = str(item.get('path') or '').strip()
			if not path:
				continue
			if op(path) is None:
				missing.append(path)
				continue
			fields = {
				k: v for k, v in item.items()
				if k in self._WINDOW_FIELDS
			}
			# `open: true` opens the window; `open: false` means "was closed
			# when saved", NOT "close it now". Restoring a layout must not
			# slam shut a window someone deliberately opened during startup -
			# closing stays an explicit `window_set` call.
			show = True if item.get('open') else None
			results.append(self.SetWindow(path, fields, show=show))
		ok = all(r.get('ok') for r in results) and not missing
		out = {'ok': ok, 'applied': len(results), 'results': results}
		if missing:
			out['missing'] = missing
			out['error'] = f'not in this project: {", ".join(missing)}'
		return out

	def SaveWindowLayout(self, paths=None, apply_on_load=True, include_all=False):
		"""Capture current placement into the sidecar (verb `window_save`).

		Primary windows only by default (see `_windowPrimary`) - a blanket
		capture would write every popup window inside every installed palette
		tool into the project's sidecar. `paths` captures exactly those
		windows; `include_all` captures every placeable one. Writes merge into
		the sidecar the way the authoring fields do, so no other key moves.
		"""
		wanted = None
		if isinstance(paths, list) and paths:
			wanted = {str(p).strip() for p in paths if str(p).strip()}
		items = []
		for w in self._windowComps():
			path = self._compPath(w)
			if wanted is not None:
				if path not in wanted:
					continue
			elif not include_all and not self._windowPrimary(path):
				continue
			state = self._windowState(w)
			item = {'path': path, 'open': bool(state.get('open'))}
			# Only real placement fields land in the sidecar - `primary` is a
			# UI hint and live geometry is a readout, neither is settable.
			for key in self._WINDOW_FIELDS:
				if key in state:
					item[key] = state[key]
			items.append(item)
		if not items:
			return {'ok': False, 'error': 'no placeable Window COMPs to save'}
		layout = {'apply_on_load': bool(apply_on_load), 'items': items}
		res = self._sidecarMerge({'windows': layout})
		if not res.get('ok'):
			return res
		return {**res, 'layout': layout, 'saved': len(items)}

	def ClearWindowLayout(self):
		"""Drop the sidecar's window layout (verb `window_clear`)."""
		return self._sidecarMerge({'windows': None})

	def _sidecarWindowLayout(self):
		"""The sidecar's `windows` block, normalized, or None.

		Accepts the full form (`{"apply_on_load": bool, "items": [...]}`) and
		the bare-list shorthand (`[...]`, which means apply).
		"""
		path, exists = self._sidecarPath()
		if not exists:
			return None
		try:
			data = self._readSidecar(path)
		except Exception:
			return None
		block = data.get('windows')
		if isinstance(block, list):
			block = {'apply_on_load': True, 'items': block}
		if not isinstance(block, dict):
			return None
		items = block.get('items')
		return {
			'apply_on_load': bool(block.get('apply_on_load', True)),
			'items': items if isinstance(items, list) else [],
		}

	def _applyWindowLayoutOnLoad(self):
		"""Restore the sidecar layout after load, when it asks to be restored.

		Idempotent and quiet: no sidecar, no block, or apply_on_load false all
		mean do nothing. Extensions reinitialize more than once (see the TDN
		notes in the project rules), so this must be safe to run again.
		"""
		layout = self._sidecarWindowLayout()
		if not layout or not layout.get('apply_on_load') or not layout.get('items'):
			return
		try:
			res = self.ApplyWindowLayout(layout['items'])
		except Exception as e:
			debug(f'TDXLU window layout: {e}')
			return
		if not res.get('ok'):
			debug(f'TDXLU window layout: {res.get("error")}')

	# --- Palette tabs (delegates to ./TDXLUPalette) ---------------------
	# The launcher's Palette + Patreon tabs inside TD's Palette Browser. The
	# nested COMP owns the injection; THIS COMP owns the Palettetabs setting
	# (the child binds up) and relays the page URL the launcher hands over.

	def _paletteTabs(self):
		return self.ownerComp.op('TDXLUPalette')

	def PaletteSetUrl(self, url):
		"""Point the Palette Browser's web tabs at the launcher page (bus: palette_url)."""
		p = self._paletteTabs()
		if p is None:
			return {'ok': False, 'error': 'TDXLUPalette missing'}
		return p.SetUrl(url)

	def PaletteStatus(self):
		"""Install state of the Palette Browser tabs (bus: palette_status)."""
		p = self._paletteTabs()
		if p is None:
			return {'ok': False, 'error': 'TDXLUPalette missing'}
		return p.PaletteStatus()

	def onParPaletteinstall(self):
		p = self._paletteTabs()
		if p is not None:
			p.Install()

	def onParPaletteuninstall(self):
		p = self._paletteTabs()
		if p is not None:
			p.Uninstall()

	def onParPalettereload(self):
		p = self._paletteTabs()
		if p is not None:
			p.Reload()

	def onParPaletteopen(self):
		p = self._paletteTabs()
		if p is not None:
			p.OpenPaletteBrowser()

	def Selection(self):
		"""What the Network Editor has selected (bus: selection): the current
		editor first, then any other -- `comps` are the selected COMPs (what
		"expose" / "pin" act on), `ops` every selected operator, `owner` the
		network they sit in."""
		for pane in self._networkEditorPanes():
			try:
				owner = pane.owner
				sel = list(owner.selectedChildren)
			except Exception:
				continue
			if sel:
				return {
					'ok': True,
					'owner': owner.path,
					'ops': [o.path for o in sel],
					'comps': [o.path for o in sel if o.isCOMP],
				}
		return {'ok': True, 'owner': None, 'ops': [], 'comps': []}

	def ToolboxSaveSelected(self, dest_dir, name=None):
		"""Save the Network Editor's selected COMP as a .tox into dest_dir
		(bus: toolbox_save_selected) - the inverse of load_tox: the launcher
		then pins the file to its Toolbox. The current Network Editor wins;
		with several COMPs selected the first one is saved and `selected`
		reports the count."""
		dest_dir = str(dest_dir or '').strip()
		if not dest_dir:
			return {'ok': False, 'error': 'no destination folder'}
		comp, count = None, 0
		for pane in self._networkEditorPanes():
			try:
				sel = [o for o in pane.owner.selectedChildren if o.isCOMP]
			except Exception:
				continue
			if sel:
				comp, count = sel[0], len(sel)
				break
		if comp is None:
			return {'ok': False, 'error': 'Select a COMP in a Network Editor first'}
		util = self.ownerComp.path
		if comp.path == util or comp.path.startswith(util + '/'):
			return {'ok': False, 'error': 'That is the Launcher Utility itself - pin something else'}
		label = str(name or '').strip() or comp.name
		safe = ''.join(c if (c.isalnum() or c in ' _-') else '_' for c in label).strip() or comp.name
		try:
			os.makedirs(dest_dir, exist_ok=True)
			path = os.path.join(dest_dir, safe + '.tox')
			n = 2
			while os.path.exists(path):
				path = os.path.join(dest_dir, f'{safe}_{n}.tox')
				n += 1
			comp.save(path)
		except Exception as e:
			return {'ok': False, 'error': f'save failed: {e}'}
		self._setMediaStatus(f'Pinned {comp.path} -> {os.path.basename(path)}')
		return {
			'ok': True,
			'path': path.replace('\\', '/'),
			'name': label,
			'comp': comp.path,
			'selected': count,
		}

	def _toxQuiet(self):
		q = op('/sys/quiet')
		if q is None:
			raise ValueError('/sys/quiet missing - cannot stage tox load')
		return q

	def _compPath(self, comp):
		"""Normalize COMP path; treat root identity / empty path as '/'."""
		if comp is None:
			return None
		try:
			if comp is root:
				return '/'
		except Exception:
			pass
		try:
			p = comp.path
			return '/' if (not p or p == '/') else p
		except Exception:
			return '?'

	def _isRootComp(self, comp):
		if comp is None:
			return False
		try:
			return comp is root or self._compPath(comp) == '/'
		except Exception:
			return False

	def _dumpPanes(self):
		"""Snapshot all panes for load_tox debugging."""
		rows = []
		cur_name = None
		try:
			cur = ui.panes.current
			cur_name = getattr(cur, 'name', None) if cur is not None else None
		except Exception:
			cur = None
		try:
			for i, p in enumerate(ui.panes):
				try:
					owner = p.owner
					rows.append({
						'index': i,
						'name': getattr(p, 'name', None),
						'type': str(getattr(p, 'type', None)),
						'owner': self._compPath(owner),
						'owner_is_root': self._isRootComp(owner),
						'is_current': p is cur or getattr(p, 'name', None) == cur_name,
						'is_networkeditor': getattr(p, 'type', None) == PaneType.NETWORKEDITOR,
					})
				except Exception as e:
					rows.append({'index': i, 'error': str(e)})
		except Exception as e:
			rows.append({'error': f'panes iterate: {e}'})
		return rows

	def GetPanes(self):
		"""Open panes and what each one is showing (TDXLU window labelling).

		A torn-off pane gets its own OS window, and Windows titles that window
		with the pane NAME -- 'pane2', 'copy_of_pane4_0' -- which says nothing
		about its content. The launcher matches those titles against the names
		here so it can label the window by owner and pane type instead.

		Closed panes are skipped: `ui.panes` keeps a stale entry after
		`Pane.close()`, and a dead name must not shadow a live window.
		"""
		panes = []
		try:
			for p in ui.panes:
				try:
					if not p.open:
						continue
					owner = p.owner
					panes.append({
						'name': p.name,
						'id': p.id,
						'type': str(p.type).replace('PaneType.', ''),
						'owner': self._compPath(owner),
						'owner_name': owner.name if owner is not None else None,
					})
				except Exception:
					continue
		except Exception as e:
			return {'ok': False, 'error': f'panes iterate: {e}'}
		return {'ok': True, 'panes': panes}

	def _networkEditorPanes(self):
		"""Yield Network Editor panes - current first when it qualifies."""
		try:
			cur = ui.panes.current
			if cur is not None and cur.type == PaneType.NETWORKEDITOR:
				yield cur
			for p in ui.panes:
				try:
					if p is cur:
						continue
					if p.type == PaneType.NETWORKEDITOR:
						yield p
				except Exception:
					continue
		except Exception:
			return

	def _isUsableToxParent(self, comp):
		"""Reject /sys* and this Utility network as load destinations. Root `/` is allowed."""
		if comp is None:
			return False
		try:
			if not comp.isCOMP:
				return False
		except Exception:
			return False
		path = self._compPath(comp)
		if path == '/sys' or (path and path.startswith('/sys/')):
			return False
		util = self.ownerComp.path
		if path == util or (path and path.startswith(util + '/')):
			return False
		return True

	def _rootHasGlobalShortcut(self):
		try:
			return bool((root.par.opshortcut.eval() or '').strip())
		except Exception:
			return False

	def _toxLoadParent(self, parent_path=None):
		"""Destination COMP: explicit -> Network Editor owner (incl. `/`) -> / if opshortcut -> quiet."""
		if parent_path:
			p = op(parent_path)
			if p is None:
				raise ValueError(f'parent not found: {parent_path}')
			return p, f'explicit:{parent_path}'

		cur = None
		try:
			cur = ui.panes.current
		except Exception:
			cur = None

		owners = []  # (owner, is_current)
		seen = set()
		for pane in self._networkEditorPanes():
			try:
				owner = pane.owner
			except Exception:
				continue
			if not self._isUsableToxParent(owner):
				continue
			key = self._compPath(owner)
			if key in seen:
				continue
			seen.add(key)
			is_current = cur is not None and pane is cur
			owners.append((owner, is_current))

		if owners:
			# Prefer `/` whenever any Network Editor is on root (not buried in /project1).
			for owner, _ in owners:
				if self._isRootComp(owner):
					return owner, 'networkeditor:/'
			for owner, is_current in owners:
				if is_current:
					return owner, f'networkeditor:current:{self._compPath(owner)}'
			owners.sort(
				key=lambda t: (
					self._compPath(t[0]).count('/'),
					len(self._compPath(t[0])),
				)
			)
			owner = owners[0][0]
			return owner, f'networkeditor:{self._compPath(owner)}'

		if self._rootHasGlobalShortcut() and self._isUsableToxParent(root):
			return root, 'root:opshortcut'
		return self._toxQuiet(), 'quiet:fallback'

	def _uniqueChildName(self, parent, base):
		name = base
		n = 1
		while parent.op(name) is not None:
			name = f'{base}{n}'
			n += 1
		return name

	def _loadToxDirect(self, load_from, parent_comp):
		"""loadTox straight into parent - no /sys/quiet hop (avoids copy mis-parenting)."""
		comp = parent_comp.loadTox(load_from)
		if comp is None:
			raise RuntimeError(f'loadTox returned None: {load_from}')
		return comp

	def _looksLikePalettePackage(self, wrapper, require_packaging=False):
		"""Factory/user palette .tox: wrapper contains a same-named COMP (the real asset).

		require_packaging=True (file-drop path): also demand icon/info/help siblings so
		intentional Foo/Foo nesting is left alone.
		"""
		if wrapper is None:
			return False
		try:
			inner = wrapper.op(wrapper.name)
		except Exception:
			inner = None
		if inner is None or not getattr(inner, 'isCOMP', False):
			return False
		if not require_packaging:
			return True
		for n in ('icon', 'info', 'help', 'About'):
			try:
				if wrapper.op(n) is not None:
					return True
			except Exception:
				pass
		return False

	def _paletteDropUnwrapEnabled(self):
		try:
			if hasattr(self.ownerComp.par, 'Unwrappalettetox'):
				return bool(int(self.ownerComp.par.Unwrappalettetox.eval()))
		except Exception:
			pass
		return True

	def _ensureBusConnectedPar(self):
		"""Launcher page: read-only Connected lamp, driven by the hello result.

		Busstatus is a sentence you have to read; this is the same fact at a
		glance. Created here rather than only in the .tox so an older Utility
		gains it on load.
		"""
		try:
			if hasattr(self.ownerComp.par, 'Busconnected'):
				return
			page = None
			for p in self.ownerComp.customPages:
				if p.name == 'Launcher':
					page = p
					break
			if page is None:
				page = self.ownerComp.appendCustomPage('Launcher')
			par = page.appendToggle('Busconnected', label='Connected')[0]
			par.default = 0
			par.val = 0
			par.readOnly = True
			try:
				par.help = (
				'Read-only. On while the last hello reached TDXLU, so the launcher '
				'can see this session. Off means the bus is down - TDXLU not '
				'running, a Host/TDXLU Port mismatch, or the send failed. Status '
				'below carries the detail.'
				)
			except Exception:
				pass
			# Sit directly above Status: the lamp answers, the string explains.
			try:
				status = getattr(self.ownerComp.par, 'Busstatus', None)
				if status is not None:
					par.order = status.order - 0.5
			except Exception:
				pass
		except Exception as e:
			debug(f'TDXLUUtility: ensure Busconnected: {e}')

	def _ensurePaletteDropPar(self):
		"""Palette toggle: unwrap palette-package .tox after network file drops."""
		try:
			if hasattr(self.ownerComp.par, 'Unwrappalettetox'):
				return
			page = None
			for p in self.ownerComp.customPages:
				if p.name == 'Palette':
					page = p
					break
			if page is None:
				page = self.ownerComp.appendCustomPage('Palette')
			par = page.appendToggle('Unwrappalettetox', label='Unwrap Palette Tox Drops')
			par.val = 1
			par.default = 1
			try:
				par.help = (
					'After a .tox file drop into a network, promote the inner same-named '
					'COMP when the drop looks like a palette package (icon/info). '
					'Does not change Palette Browser drag behavior.'
				)
			except Exception:
				pass
		except Exception as e:
			debug(f'TDXLUUtility: ensure Unwrappalettetox: {e}')

	def _ensureDragDropSubscribe(self):
		"""Register with /sys/dragDropExt for post-builtin .tox file drops."""
		try:
			dde = op('/sys/dragDropExt')
			if dde is None:
				return False
			ok = dde.ext.DragDrop.Subscribe(self.ownerComp, ['tox'])
			debug(
				f'TDXLUUtility: dragDropExt tox subscribe '
				f'({"new" if ok else "updated"})'
			)
			return True
		except Exception as e:
			debug(f'TDXLUUtility: dragDropExt subscribe failed: {e}')
			return False

	def _isProtectedDropOp(self, comp):
		"""Never unwrap drops that landed inside Utility / Embody / sys."""
		if comp is None:
			return True
		try:
			path = comp.path or ''
		except Exception:
			return True
		try:
			up = self.ownerComp.path
			if path == up or path.startswith(up + '/'):
				return True
		except Exception:
			pass
		for root in ('/sys', '/local', '/ui'):
			if path == root or path.startswith(root + '/'):
				return True
		try:
			embody = getattr(op, 'Embody', None)
			if embody is not None:
				ep = embody.path
				if path == ep or path.startswith(ep + '/'):
					return True
		except Exception:
			pass
		return False

	def OnDropReceivedTox(self, dropDict, newOp):
		"""dragDropExt callback: TD already loadTox'd; optionally unwrap palette shell.

		Promoted on the Utility COMP. Returns None so we never replace the drop result.
		"""
		if not self._paletteDropUnwrapEnabled():
			return None
		if getattr(self, '_load_tox_inflight', False):
			return None
		if newOp is None:
			return None
		try:
			op_id = int(newOp.id)
			op_path = newOp.path
		except Exception:
			return None
		if op_id in self._unwrap_drop_ids:
			return None
		# Settle one frame so TD finishes drop placement, then unwrap.
		run(
			lambda p=op_path, i=op_id: self._unwrapDroppedTox(p, i),
			delayFrames=1,
		)
		return None

	def _unwrapDroppedTox(self, op_path, op_id):
		if not self._paletteDropUnwrapEnabled():
			return
		if getattr(self, '_load_tox_inflight', False):
			return
		try:
			wrapper = op(op_path)
		except Exception:
			wrapper = None
		if wrapper is None:
			return
		try:
			if not wrapper.valid:
				return
		except Exception:
			pass
		if self._isProtectedDropOp(wrapper):
			return
		# Drop path requires packaging siblings - LoadTox path is more lenient.
		if not self._looksLikePalettePackage(wrapper, require_packaging=True):
			return
		self._unwrap_drop_ids.add(op_id)
		try:
			promoted, unwrapped = self._unwrapPalettePackage(wrapper)
		except Exception as e:
			debug(f'TDXLUUtility: drop unwrap failed: {e}')
			return
		if not unwrapped or promoted is None:
			return
		try:
			self._setMediaStatus(f'Unwrapped palette drop -> {promoted.path}')
		except Exception:
			pass
		try:
			self._selectAndFocusOp(promoted)
		except Exception:
			pass
		# Bound the debounce set
		if len(self._unwrap_drop_ids) > 64:
			self._unwrap_drop_ids = set(list(self._unwrap_drop_ids)[-32:])

	def _unwrapPalettePackage(self, wrapper):
		"""Promote palette inner COMP (same name) into the parent network; drop wrapper.

		Palette .tox files are usually: Wrapper/Wrapper + icon + info. Drag-drop from
		the Palette Browser unpacks; raw loadTox / file-drop leaves the wrapper. We unwrap.
		Returns (comp, unwrapped:bool).
		"""
		if wrapper is None or not self._looksLikePalettePackage(wrapper):
			return wrapper, False
		try:
			inner = wrapper.op(wrapper.name)
		except Exception:
			inner = None
		if inner is None or not inner.isCOMP:
			return wrapper, False
		parent = None
		try:
			parent = wrapper.parent()
		except Exception:
			parent = None
		if parent is None:
			return wrapper, False

		# Preserve tile placement of the package
		try:
			wx, wy = wrapper.nodeX, wrapper.nodeY
		except Exception:
			wx, wy = 0, 0

		# Name collision: wrapper currently owns `name` in parent
		want_name = wrapper.name
		try:
			promoted = parent.copy(inner)
		except Exception as e:
			debug(f'TDXLUUtility: palette unwrap copy failed: {e}')
			return wrapper, False
		if promoted is None:
			return wrapper, False

		try:
			wrapper.destroy()
		except Exception as e:
			debug(f'TDXLUUtility: palette unwrap destroy wrapper: {e}')

		# After wrapper is gone, rename promoted to the package name if free
		try:
			if parent.op(want_name) is None and promoted.name != want_name:
				promoted.name = want_name
			elif promoted.name != want_name and parent.op(want_name) is promoted:
				pass
			elif promoted.name != want_name:
				# keep unique name from copy()
				pass
		except Exception:
			pass

		try:
			promoted.nodeX = wx
			promoted.nodeY = wy
		except Exception:
			pass
		return promoted, True

	def _reparentIfNeeded(self, comp, parent_comp):
		"""If loadTox landed under the wrong parent, copy into the intended one."""
		if comp is None or parent_comp is None:
			return comp, False
		try:
			actual = comp.parent()
		except Exception:
			actual = None
		if actual is parent_comp or self._compPath(actual) == self._compPath(parent_comp):
			return comp, False
		fixed = parent_comp.copy(comp)
		try:
			comp.destroy()
		except Exception:
			pass
		return (fixed if fixed is not None else comp), True

	def _focusNetworkPaneOn(self, comp):
		"""Point a Network Editor pane at comp - prefer current, else any NETWORKEDITOR."""
		if comp is None:
			return False
		for pane in self._networkEditorPanes():
			try:
				pane.owner = comp
				return True
			except Exception:
				continue
		return False

	def _selectAndFocusOp(self, comp):
		"""Make comp current/selected and home a Network Editor on it."""
		if comp is None:
			return False
		parent = None
		try:
			parent = comp.parent()
		except Exception:
			parent = None

		pane = None
		for candidate in self._networkEditorPanes():
			try:
				# Browse the parent network so the new tile is visible
				candidate.owner = parent if parent is not None else comp
				pane = candidate
				break
			except Exception:
				continue
		if pane is None:
			return False

		# Clear prior selection in this network, then select the new op
		try:
			if parent is not None:
				for child in list(parent.selectedChildren):
					try:
						child.selected = False
					except Exception:
						pass
		except Exception:
			pass
		try:
			comp.selected = True
			comp.current = True
		except Exception:
			pass

		try:
			pane.homeSelected(zoom=True)
		except Exception:
			try:
				pane.home(zoom=True, op=comp)
			except Exception:
				try:
					pane.home(op=comp)
				except Exception:
					pass
		return True

	def LoadTox(
		self,
		tox_path,
		persist=False,
		parent=None,
		externaltox=False,
		toxfile_module=None,
	):
		"""Load a .tox into the live network (optional copy under project/tox/).

		Default destination: Network Editor pane owner (including `/`), else `/` if
		it has a Global OP Shortcut, else `/sys/quiet`. Loads **directly** into the
		parent (no quiet stage). When the destination is `/`, a Network Editor is
		moved to `/`. Result always includes a `debug` pane dump.

		toxfile_module: if set (e.g. tdptdpbrowser.Browser), after load bind
		External Tox to expression mod.<module>.ToxFile (TDP Place style).
		"""
		diag = {'panes': self._dumpPanes()}
		self._load_tox_inflight = True
		try:
			try:
				cur = ui.panes.current
				diag['current_pane'] = {
					'name': getattr(cur, 'name', None) if cur else None,
					'type': str(getattr(cur, 'type', None)) if cur else None,
					'owner': self._compPath(cur.owner) if cur else None,
				}
			except Exception as e:
				diag['current_pane_error'] = str(e)

			src = os.path.abspath(str(tox_path or '').strip())
			if not src or not os.path.isfile(src):
				raise ValueError(f'tox not found: {tox_path}')
			if not src.lower().endswith('.tox'):
				raise ValueError('path must be a .tox file')

			load_from = src
			persisted_to = None
			if persist:
				dest_dir = os.path.join(project.folder, 'tox')
				os.makedirs(dest_dir, exist_ok=True)
				persisted_to = os.path.join(dest_dir, os.path.basename(src))
				if os.path.normcase(os.path.abspath(src)) != os.path.normcase(
					os.path.abspath(persisted_to)
				):
					import shutil

					shutil.copy2(src, persisted_to)
				load_from = persisted_to

			parent_comp, resolved_from = self._toxLoadParent(parent)
			diag['resolved_parent'] = self._compPath(parent_comp)
			diag['resolved_from'] = resolved_from
			diag['parent_is_root'] = self._isRootComp(parent_comp)
			diag['parent_id'] = id(parent_comp)
			diag['root_id'] = id(root)

			stem = os.path.splitext(os.path.basename(load_from))[0]
			safe = ''.join(c if c.isalnum() or c == '_' else '_' for c in stem)
			if not safe or safe[0].isdigit():
				safe = f'tox_{safe}' if safe else 'loaded_tox'

			reparented = False
			unwrapped = False
			toxfile_bound = False
			mod_hint = (str(toxfile_module).strip() if toxfile_module else '') or None
			if mod_hint and not self._safeToxfileModule(mod_hint):
				raise ValueError(f'invalid toxfile_module: {mod_hint}')

			if externaltox and not mod_hint:
				name = self._uniqueChildName(parent_comp, safe)
				comp = parent_comp.create(baseCOMP, name)
				comp.par.externaltox = load_from
				# Palette packages: pull same-named inner COMP (Sub-Component to Load)
				try:
					if hasattr(comp.par, 'subcompname'):
						comp.par.subcompname = safe
				except Exception:
					pass
				if hasattr(comp.par, 'reinitnet'):
					comp.par.reinitnet.pulse()
			else:
				comp = self._loadToxDirect(load_from, parent_comp)
				comp, reparented = self._reparentIfNeeded(comp, parent_comp)
				comp, unwrapped = self._unwrapPalettePackage(comp)

			if comp is not None and mod_hint:
				toxfile_bound = self._bindToxfileModule(comp, mod_hint)
				diag['toxfile_module'] = mod_hint
				diag['toxfile_bound'] = toxfile_bound

			loaded_path = comp.path if comp is not None else parent_comp.path
			try:
				diag['actual_parent'] = self._compPath(comp.parent()) if comp else None
			except Exception as e:
				diag['actual_parent_error'] = str(e)
			diag['reparented'] = reparented
			diag['palette_unwrapped'] = unwrapped
			diag['loaded_path'] = loaded_path

			try:
				line = json.dumps({'load_tox': diag}, default=str)
				print(f'[TDXLU load_tox] {line}')
				debug(line)
			except Exception:
				pass

			pane_focused = False
			if comp is not None:
				pane_focused = self._selectAndFocusOp(comp)
			elif self._isRootComp(parent_comp):
				pane_focused = self._focusNetworkPaneOn(root)

			self._setMediaStatus(
				f'Loaded -> {self._compPath(parent_comp)} [{resolved_from}] got {loaded_path}'
			)
			out = {
				'ok': True,
				'tox_path': load_from,
				'loaded_path': loaded_path,
				'parent': self._compPath(parent_comp),
				'resolved_from': resolved_from,
				'externaltox': bool(externaltox),
				'via': 'direct',
				'pane_focused': pane_focused,
				'selected': pane_focused,
				'reparented': reparented,
				'palette_unwrapped': unwrapped,
				'toxfile_module': mod_hint,
				'toxfile_bound': toxfile_bound,
				'debug': diag,
			}
			if persisted_to:
				out['persisted_to'] = persisted_to
			return out
		except Exception as e:
			self._setMediaStatus(f'Load tox failed: {e}')
			return {'ok': False, 'error': str(e), 'debug': diag}
		finally:
			self._load_tox_inflight = False

	def UpdateUtility(self, tox_path):
		"""Repoint this COMP's External .tox at a newer file and reload in place.

		Launcher-driven update recipe: Reload Custom Parameters is forced OFF
		first so values the user already set on this COMP survive the reload;
		then externaltox is repointed and Enable External .tox is pulsed. The
		pulse is deferred half a second so the TCP reply gets out before this
		network (including the bus DATs and this extension) reinitializes.

		Save Backup of External is forced ON because this repoint can convert an
		embedded COMP into an external one bound to a machine-local palette
		path. Without the backup, that .toe would load an empty COMP anywhere
		the palette copy is missing -- another machine, a render node, or after
		the folder is cleared.
		"""
		src = os.path.abspath(str(tox_path or '').strip())
		if not src or not os.path.isfile(src):
			return {'ok': False, 'error': f'tox not found: {tox_path}'}
		if not src.lower().endswith('.tox'):
			return {'ok': False, 'error': 'path must be a .tox file'}
		comp = self.ownerComp
		try:
			if hasattr(comp.par, 'reloadcustom'):
				comp.par.reloadcustom = 0  # never clobber user parameter choices
			comp.par.externaltox = src.replace('\\', '/')
			if hasattr(comp.par, 'enableexternaltox'):
				comp.par.enableexternaltox = 1
			if hasattr(comp.par, 'savebackup'):
				comp.par.savebackup = 1  # keep the .toe loadable without the palette copy
		except Exception as e:
			return {'ok': False, 'error': f'set externaltox failed: {e}'}

		comp_path = comp.path

		def _reload():
			c = op(comp_path)
			if c is None:
				return
			try:
				if hasattr(c.par, 'enableexternaltoxpulse'):
					c.par.enableexternaltoxpulse.pulse()
				elif hasattr(c.par, 'reinitnet'):
					c.par.reinitnet.pulse()
			except Exception as e:
				debug(f'TDXLUUtility: update reload failed: {e}')

		run(_reload, delayFrames=30)
		self._setMediaStatus(f'Utility updating from {src}')
		return {
			'ok': True,
			'scheduled': True,
			'tox_path': src,
			'from_version': self.UTILITY_VERSION,
		}

	def _safeToxfileModule(self, name):
		"""Allow only dotted Python module paths (no path separators / spaces)."""
		if not name or len(name) > 200:
			return False
		parts = name.split('.')
		if not parts:
			return False
		for p in parts:
			if not p or not p.isidentifier():
				return False
		return True

	def _bindToxfileModule(self, comp, module_name):
		"""Bind External Tox to mod.<module>.ToxFile (TDP Place convention)."""
		if comp is None or not module_name:
			return False
		expr = f'mod.{module_name}.ToxFile'
		try:
			comp.par.externaltox.expr = expr
		except Exception as e:
			debug(f'TDXLUUtility: externaltox expr failed: {e}')
			return False
		try:
			if hasattr(comp.par, 'enableexternaltox'):
				comp.par.enableexternaltox = 1
		except Exception:
			pass
		try:
			if hasattr(comp.par, 'enableexternaltoxpulse'):
				comp.par.enableexternaltoxpulse.pulse()
			elif hasattr(comp.par, 'reinitnet'):
				comp.par.reinitnet.pulse()
		except Exception:
			pass
		return True

	# --- FunctionStore tools (FNS) bridge --------------------------------
	# The launcher stocks the FNS palette store (artifacts + manifest +
	# selection.json) and drives the toolkit's own installer through these
	# verbs. Design record: docs/fns-integration.md (launcher repo) and
	# ConfiguratorDistribution.md (toolkit repo).

	def _fnsRoot(self):
		"""The project's FNS toolkit container, if any: a depth-1 COMP
		carrying the installer or updater (name-independent — TD numbers a
		second drop, and dev projects use their own root name)."""
		for c in root.children:
			if c.family != 'COMP':
				continue
			try:
				if c.op('FNS_Installer') is not None or c.op('FNS_Updater') is not None:
					return c
			except Exception:
				continue
		return None

	def FnsInstall(self, selection_path, bootstrap_path=None, parent=None):
		"""Hand a selection.json to the project's FNS_Installer.

		No toolkit root yet -> load the one-drop bootstrap tox first (its
		container IS the install target). The Install pulse is deferred so
		freshly loaded extensions get their init frames and the TCP reply
		escapes before any heavy cooking; Manifestfile stays blank so the
		installer resolves the palette store's manifest, beside which the
		launcher has already placed the artifacts. Returns immediately with
		`started`; poll `fns_status` for the outcome.
		"""
		sel = os.path.abspath(str(selection_path or '').strip())
		if not sel or not os.path.isfile(sel):
			raise ValueError(f'selection not found: {selection_path}')
		fns_root = self._fnsRoot()
		bootstrapped = False
		if fns_root is None:
			boot = os.path.abspath(str(bootstrap_path or '').strip())
			if not boot or not os.path.isfile(boot):
				raise ValueError(
					'no FNS toolkit in this project and no bootstrap tox given'
				)
			res = self.LoadTox(boot, persist=False, parent=parent)
			if not res.get('ok'):
				return res
			fns_root = op(res.get('loaded_path') or '')
			if fns_root is None:
				return {'ok': False, 'error': 'bootstrap loaded but not found'}
			bootstrapped = True
		installer = fns_root.op('FNS_Installer')
		if installer is None:
			return {
				'ok': False,
				'error': f'no FNS_Installer inside {fns_root.path} '
				'(dev toolkit roots are not install targets)',
			}
		sel_slash = sel.replace('\\', '/')
		installer.par.Selectionfile = sel_slash
		if hasattr(installer.par, 'Manifestfile'):
			installer.par.Manifestfile = ''
		# A fresh bootstrap needs real frames before its extension answers.
		delay = 90 if bootstrapped else 5
		run(
			f'op({installer.path!r}) and '
			f'op({installer.path!r}).par.Install.pulse()',
			delayFrames=delay,
		)
		return {
			'ok': True,
			'started': True,
			'root': fns_root.path,
			'installer': installer.path,
			'bootstrapped': bootstrapped,
			'selection': sel_slash,
			'pulse_in_frames': delay,
		}

	def FnsStatus(self):
		"""What of the FNS toolkit lives in this project right now.

		Packages report the live `Pkgversion` parameter — the toolkit's own
		update identity — so the launcher can diff against the manifest.
		"""
		fns_root = self._fnsRoot()
		out = {
			'ok': True,
			'present': fns_root is not None,
			'root': fns_root.path if fns_root is not None else None,
			'packages': [],
			'installer': None,
			'installer_status': None,
			'config_registry': getattr(op, 'FNS_CONFIGREGISTRY', None) is not None,
		}
		if fns_root is None:
			return out
		pkgs = []
		for c in fns_root.children:
			if c.family != 'COMP':
				continue
			pv = getattr(c.par, 'Pkgversion', None)
			if pv is None:
				continue
			try:
				pkgs.append({'name': c.name, 'version': str(pv.eval() or '')})
			except Exception:
				pkgs.append({'name': c.name, 'version': ''})
		out['packages'] = sorted(pkgs, key=lambda p: p['name'].lower())
		installer = fns_root.op('FNS_Installer')
		if installer is not None:
			out['installer'] = installer.path
			st = getattr(installer.par, 'Status', None)
			if st is not None:
				try:
					out['installer_status'] = str(st.eval())
				except Exception:
					pass
		return out

	def FnsSettingsUrl(self, ensure=True):
		"""URL of the FNS settings server, started if needed (bus: fns_settings_url).

		The launcher renders the /api/state surface natively and posts
		/api/set, so this only needs the server up -- never a browser. Since
		FNS_Console took over the settings UI, that server is the console's
		(first free port of its UI_PORTS, idle-stopped; every proxied request
		re-arms its idle timer) and serves the same /api/state + /api/set.
		Toolkits that predate the console still answer through the
		ConfigRegistry's own settings server below.
		"""
		console = getattr(op, 'FNS_CONSOLE', None)
		if console is not None and console.valid:
			try:
				ext = console.ext.ConsoleRegistryExt
				api = ext._registryApi()
			except Exception as e:
				return {'ok': False, 'error': f'ConsoleRegistryExt unavailable: {e}'}
			try:
				url = api.Url()
				if url:
					api._touchServer()
					return {'ok': True, 'url': url, 'via': 'console'}
				if not ensure:
					return {'ok': False, 'error': 'settings server not running'}
				ws = api._ensureServer()
				if ws is None:
					return {'ok': False, 'error': 'FNS_Console ships no console page'}
				port = api._freeUiPort()
				if port is None:
					return {'ok': False, 'error': 'no free console port'}
				ws.par.port = port
				ws.par.active = True
				api._touchServer()
				return {'ok': True, 'url': f'http://127.0.0.1:{int(port)}/', 'via': 'console'}
			except Exception as e:
				return {'ok': False, 'error': f'console settings server: {e}'}
		reg = getattr(op, 'FNS_CONFIGREGISTRY', None)
		if reg is None or not reg.valid:
			return {
				'ok': False,
				'error': 'FNS_Console / FNS_ConfigRegistry not found — is the toolkit installed?',
			}
		try:
			ext = reg.ext.ConfigRegistryExt
		except Exception as e:
			return {'ok': False, 'error': f'ConfigRegistryExt unavailable: {e}'}
		try:
			api = ext._registryApi()
		except Exception:
			api = ext
		if not hasattr(api, '_ensureSettingsServer'):
			return {
				'ok': False,
				'error': 'this ConfigRegistry predates the settings server',
			}
		try:
			ws = api._ensureSettingsServer()
			if ws is None:
				return {'ok': False, 'error': 'ConfigRegistry ships no settings page'}
			if not ws.par.active.eval():
				if not ensure:
					return {'ok': False, 'error': 'settings server not running'}
				port = api._freeUiPort()
				if port is None:
					return {'ok': False, 'error': 'no free settings port (9871-9880)'}
				ws.par.port = port
				ws.par.active = True
			api._touchSettingsServer()
			return {
				'ok': True,
				'url': f'http://127.0.0.1:{int(ws.par.port.eval())}/',
			}
		except Exception as e:
			return {'ok': False, 'error': f'settings server: {e}'}

	# --- FNS_CommandRegistry (tool-announced quick-launch commands) --------
	# Tools call RegisterCommands/UnregisterCommands through op.TDXLU at
	# runtime; the launcher consumes ListCommands/RunCommand over the bus
	# (fns_commands / fns_run_command). Full contract:
	# docs/fns-command-registry.md. Every path is guarded - a missing or
	# still-initializing registry answers with ok:False, never a raise.

	def _commandRegistry(self):
		"""The registry to talk to: the promoted global instance
		(op.FNS_COMMANDREGISTRY, family shape - survives utility updates
		in /sys) first, else the shipped child (which forwards to the
		global anyway once one exists), else None on an older tox."""
		reg = getattr(op, 'FNS_COMMANDREGISTRY', None)
		if reg is not None and reg.valid:
			return reg
		return self.ownerComp.op('FNS_CommandRegistry')

	def _announceChildCapabilities(self):
		"""Make sure every capability tool in this project has announced.

		Deliberately LOCATION-INDEPENDENT. These tools (Collect, Media,
		FNS_Remote) started as children of this COMP and are becoming FNS
		packages that live elsewhere, so naming paths here would rot. The
		registry's own rescan already finds every `fnscommands`-tagged COMP
		anywhere in the project AND forces its extension to initialize -
		which is the actual problem being solved: TD initializes child
		extensions lazily, so a tool nobody touched never runs its own
		init-time registration.

		This COMP always initializes (it runs the bus), so it is the right
		place to kick that off once, deferred until the registry has
		promoted. Idempotent; never raises.
		"""
		try:
			reg = self._commandRegistry()
			if reg is not None and hasattr(reg, 'RescanTools'):
				reg.RescanTools()
		except Exception as e:
			debug(f'TDXLU: capability rescan failed: {e}')
		# Belt and braces for a tool that is present but not yet TAGGED
		# (a fresh build before its first save): touch the ext directly so
		# it registers and tags itself. Silently skipped when absent -
		# these are exactly the COMPs that move out to packages.
		# Nothing is listed here any more: every capability tool now ships
		# as its own FNS package and is found by the tag rescan above,
		# wherever it was installed. The loop stays as the hook for a
		# future companion-resident tool that is present but not yet
		# tagged.
		for name, ext_name in ():
			try:
				comp = self.ownerComp.op(name)
				if comp is None:
					continue
				ext = getattr(comp.ext, ext_name, None)
				# Two hook names in the wild: the TDXLU children use
				# _registerLauncherCommands, FNS_Remote (FNS-family) uses
				# _announce. Accept either.
				for hook in ('_registerLauncherCommands', '_announce'):
					fn = getattr(ext, hook, None)
					if callable(fn):
						fn()
						break
			except Exception as e:
				debug(f'TDXLU: {name} capability announce failed: {e}')

	def RegisterCommands(self, owner, commands):
		"""Tool-facing: replace OWNER's quick-launch command set.

		Tools must call in guarded - the companion is never guaranteed:
			tdxlu = getattr(op, 'TDXLU', None)
			if tdxlu is not None and hasattr(tdxlu, 'RegisterCommands'):
				tdxlu.RegisterCommands(me.parent(), [...])
		"""
		try:
			reg = self._commandRegistry()
			if reg is None:
				return {'ok': False, 'error': 'FNS_CommandRegistry missing (older utility?)'}
			return reg.Register(owner, commands)
		except Exception as e:
			return {'ok': False, 'error': str(e)}

	def UnregisterCommands(self, owner):
		"""Tool-facing: drop OWNER's quick-launch commands (guarded)."""
		try:
			reg = self._commandRegistry()
			if reg is None:
				return {'ok': True, 'removed': False}
			return reg.Unregister(owner)
		except Exception as e:
			return {'ok': False, 'error': str(e)}

	def ListCommands(self):
		"""All registered commands, wire-ready, plus the change revision."""
		try:
			reg = self._commandRegistry()
			if reg is None:
				return {'ok': True, 'rev': 0, 'commands': []}
			return {'ok': True, 'rev': reg.Rev(), 'commands': reg.Commands()}
		except Exception as e:
			return {'ok': False, 'error': str(e)}

	def RunCommand(self, key, args=None, kwargs=None):
		"""Execute one registered command by its listed key."""
		try:
			reg = self._commandRegistry()
			if reg is None:
				return {'ok': False, 'error': 'FNS_CommandRegistry missing (older utility?)'}
			return reg.Run(key, args=args, kwargs=kwargs)
		except Exception as e:
			return {'ok': False, 'error': str(e)}

	def _findTdPyEnvManagerTox(self):
		"""Locate the factory (or user) palette's tdPyEnvManager.tox.

		Asks TouchDesigner where its palette lives (`app.paletteFolder`, then
		`app.samplesFolder`) before guessing from `app.binFolder`. The guess
		only matches the Windows install layout (bin/ beside Samples/): inside
		a macOS .app bundle the palette sits elsewhere, so on a Mac the tox was
		never found. Returns the path, or None; `self._tdPyEnvToxSearched`
		keeps the folders tried so the caller can say where it looked.
		"""
		from pathlib import Path

		names = ('tdPyEnvManager.tox', 'TDPyEnvManager.tox')
		candidates = []
		# 1. Where TD says its palette is (App class: paletteFolder is the
		#    installation folder containing palette files, on every platform).
		for attr, rels in (
			('paletteFolder', ('Tools', '')),
			('samplesFolder', ('Palette/Tools', 'Palette')),
			('installFolder', ('Samples/Palette/Tools', 'Samples/Palette')),
		):
			try:
				base = str(getattr(app, attr, '') or '')
				if base:
					for rel in rels:
						candidates.append(Path(base) / rel if rel else Path(base))
			except Exception:
				pass
		# 2. The old Windows-layout guess, kept as a last resort.
		try:
			bin_folder = Path(str(app.binFolder))
			for base in (bin_folder.parent, bin_folder.parent.parent):
				for rel in (
					'Samples/Palette/Tools',
					'Samples/Palette',
					'Palette/Tools',
					'Palette',
				):
					candidates.append(base / rel)
		except Exception:
			pass
		try:
			if hasattr(app, 'userPaletteFolder') and app.userPaletteFolder:
				candidates.append(Path(str(app.userPaletteFolder)))
		except Exception:
			pass
		try:
			docs = Path(os.path.expanduser('~')) / 'Documents' / 'Derivative' / 'Palette'
			candidates.append(docs)
		except Exception:
			pass

		seen = set()
		searched = []
		self._tdPyEnvToxSearched = searched
		for folder in candidates:
			try:
				folder = folder.resolve()
			except Exception:
				continue
			key = str(folder).lower()
			if key in seen or not folder.is_dir():
				continue
			seen.add(key)
			searched.append(folder.as_posix())
			for name in names:
				p = folder / name
				if p.is_file():
					return str(p)
			# Shallow walk for Tools subfolder variants
			try:
				for child in folder.iterdir():
					if child.is_dir():
						for name in names:
							p = child / name
							if p.is_file():
								return str(p)
			except Exception:
				pass
		return None

	def EnsureTdPyEnvManager(self):
		"""Drop palette tdPyEnvManager at project root `/` if missing.

		Only a child of `/` counts as present - leftovers under `/project1` are ignored.
		"""
		try:
			existing = root.op('tdPyEnvManager') or root.op('TDPyEnvManager')
			if existing is not None:
				pane_focused = self._selectAndFocusOp(existing)
				self._setMediaStatus(f'TDPyEnvManager already at {existing.path}')
				return {
					'ok': True,
					'already': True,
					'path': existing.path,
					'parent': '/',
					'pane_focused': pane_focused,
					'selected': pane_focused,
				}
			tox = self._findTdPyEnvManagerTox()
			if not tox:
				searched = getattr(self, '_tdPyEnvToxSearched', None) or []
				raise ValueError(
					'tdPyEnvManager.tox not found (TouchDesigner %s) - looked in: %s'
					% (app.build, ', '.join(searched[:4]) or 'no palette folder')
				)
			# Env manager is project-scoped - load straight onto `/` (no quiet stage).
			parent_comp = root
			comp = parent_comp.loadTox(tox)
			comp, _unwrapped = self._unwrapPalettePackage(comp)
			path = self._compPath(comp) if comp is not None else '/'
			pane_focused = self._selectAndFocusOp(comp) if comp is not None else self._focusNetworkPaneOn(root)
			self._setMediaStatus(f'Dropped TDPyEnvManager -> {path}')
			return {
				'ok': True,
				'already': False,
				'path': path,
				'tox_path': tox,
				'parent': '/',
				'pane_focused': pane_focused,
				'selected': pane_focused,
				'palette_unwrapped': _unwrapped,
			}
		except Exception as e:
			self._setMediaStatus(f'Ensure TDPyEnvManager failed: {e}')
			return {'ok': False, 'error': str(e)}

	def EnsurePythonEnv(self):
		"""One click: a project-local Python env, built by TD's own TDPyEnvManager.

		Drops the palette manager at `/` if it is missing (EnsureTdPyEnvManager),
		then -- unless the env already exists -- switches the manager Active and
		pulses its Create vEnv. That is exactly what clicking those two in TD
		does, so the env is created on TD's ThreadManager (TD never freezes) and
		Derivative's disclaimer still asks first: switching Active on shows it,
		it is their consent step, and it is never bypassed here.

		Answers at once with `creating: True`. The disclaimer is modal and would
		hold this bus reply until someone answers it, so activation runs a few
		frames later; the launcher then watches the project folder for the env.
		"""
		dropped = self.EnsureTdPyEnvManager() or {}
		if not dropped.get('ok'):
			return dropped
		m = root.op('tdPyEnvManager') or root.op('TDPyEnvManager')
		if m is None:
			return {'ok': False, 'error': 'TDPyEnvManager is missing right after the drop'}
		env_dir = self._pyEnvDir(m)
		if env_dir and self._pyEnvPython(env_dir):
			self._setMediaStatus(f'Python env ready: {env_dir}')
			return {**dropped, 'env_ready': True, 'creating': False, 'env_path': env_dir}
		try:
			mode = str(m.par.Mode.eval())
		except Exception:
			mode = ''
		if mode and mode != 'Python vEnv':
			return {
				**dropped,
				'ok': False,
				'error': f'TDPyEnvManager is set to {mode} - create that env on it in TD, '
				'or switch its Mode to Python vEnv',
			}
		path = m.path
		run(lambda p=path: self._activatePyEnvManager(p), delayFrames=2)
		self._setMediaStatus('Setting up the Python env...')
		return {**dropped, 'creating': True, 'env_path': env_dir}

	def PythonEnvStatus(self):
		"""Where the project's TDPyEnvManager stands -- what the launcher polls
		after EnsurePythonEnv. The manager's Status text is the outcome
		("Creating Python vEnv...", "Environment linked and ready.", "Error
		creating Python vEnv."); `Helper.Ready` is not a usable signal (it reads
		False on a linked, ready env). An env folder on disk is not proof
		either: a failed create can leave one behind, pip missing."""
		m = root.op('tdPyEnvManager') or root.op('TDPyEnvManager')
		if m is None:
			return {'ok': True, 'manager': None, 'state': 'no_manager'}
		try:
			status = str(m.par.Status.eval())
		except Exception:
			status = ''
		low = status.lower()
		if 'error' in low:
			state = 'error'
		elif 'creating' in low:
			state = 'creating'
		elif 'ready' in low:
			state = 'ready'
		else:
			state = 'idle'
		env_dir = self._pyEnvDir(m)
		try:
			active = bool(m.par.Active.eval())
		except Exception:
			active = False
		return {
			'ok': True,
			'manager': m.path,
			'active': active,
			'status': status,
			'state': state,
			'env_path': env_dir,
			'python': self._pyEnvPython(env_dir) if env_dir else None,
		}

	def _pyEnvDir(self, m):
		"""The env folder the manager will create: Installpath (relative to the
		project folder) joined with Environmentname -- `.` + `.venv` by default."""
		try:
			base = str(m.par.Installpath.eval() or '.')
			name = str(m.par.Environmentname.eval() or '.venv')
			if not os.path.isabs(base):
				base = os.path.join(str(project.folder), base)
			return os.path.normpath(os.path.join(base, name)).replace(os.sep, '/')
		except Exception:
			return None

	def _pyEnvPython(self, env_dir):
		"""The env's interpreter if it exists (Windows Scripts/, macOS bin/)."""
		for rel in ('Scripts/python.exe', 'bin/python3', 'bin/python'):
			p = os.path.join(env_dir, rel)
			if os.path.isfile(p):
				return p
		return None

	def _activatePyEnvManager(self, path):
		"""Step 2: switch the manager Active -- Derivative's disclaimer asks here
		(modal; frames stand still until it is answered) -- then press Create."""
		m = op(path)
		if m is None:
			return
		try:
			if not m.par.Active.eval():
				m.par.Active = True
		except Exception as e:
			self._setMediaStatus(f'Could not activate TDPyEnvManager: {e}')
			return
		# The manager re-initializes after activation; give it a moment.
		run(lambda p=path: self._pressCreateVenv(p, 5), delayFrames=15)

	def _pressCreateVenv(self, path, tries):
		"""Step 3: pulse Create vEnv once the manager is Active and listening.
		Re-pulses only while nothing has started (a second pulse mid-create
		would queue a second environment build)."""
		m = op(path)
		if m is None:
			return
		try:
			if not m.par.Active.eval():
				self._setMediaStatus('Python env not created - the TDPyEnvManager disclaimer was declined')
				return
			env_dir = self._pyEnvDir(m)
			status = str(m.par.Status.eval())
			# "Creating Python vEnv..." is the manager's in-progress status. NOT
			# a bare "creat": the idle one reads "... create vEnv to continue."
			started = 'creating' in status.lower() or (env_dir and os.path.isdir(env_dir))
			if started:
				self._setMediaStatus(f'TDPyEnvManager: {status}')
				return
			m.par.Createvenv.pulse()
		except Exception as e:
			self._setMediaStatus(f'Could not start the Python env: {e}')
			return
		if tries > 1:
			run(lambda p=path, t=tries - 1: self._pressCreateVenv(p, t), delayFrames=20)

	def PulseIcon(self):
		"""Capture a fresh still beside the .toe for TDXLU thumbnails."""
		try:
			path = self.SaveIcon(is_temp=False)
			# Also drop a media-folder still for the gallery hero scan
			preview_rel, preview = self._mediaPath('preview.png')
			self.icon_source.save(
				preview_rel,
				quality=0.5,
				metadata=[
					('source', 'TDXLUUtility'),
					('project_name', project.name),
				],
			)
			self._setMediaStatus('Icon + preview.png updated')
			return {'ok': True, 'icon': path, 'preview': preview}
		except Exception as e:
			self._setMediaStatus(f'Pulse failed: {e}')
			return {'ok': False, 'error': str(e)}

	def _configurePreviewRecorder(self, mfo):
		"""Force browser-playable H.264 in an mp4 container (WebView can't play Hap/ProRes)."""
		try:
			mfo.par.resolutionw = 640
			mfo.par.resolutionh = 360
		except Exception:
			pass
		try:
			if hasattr(mfo.par, 'type'):
				mfo.par.type = 'movie'
		except Exception:
			pass
		# TD menuNames: automatic/mov/mp4/mkv/webm and rle/mjpa/mpeg4/h264/...
		try:
			mfo.par.moviecontainer = 'mp4'
		except Exception:
			pass
		try:
			mfo.par.videocodec = 'h264'
		except Exception:
			pass
		try:
			if hasattr(mfo.par, 'moviequality'):
				mfo.par.moviequality = 0.7
		except Exception:
			pass

	def _previewRecorder(self):
		"""Return the network-owned moviefileout_preview (never create at runtime)."""
		mfo = self.ownerComp.op('moviefileout_preview')
		if mfo is None:
			raise ValueError(
				'moviefileout_preview missing - add a Movie File Out TOP named '
				'moviefileout_preview inside Utility, wired from null_icon'
			)
		src = self.icon_source
		if src is not None and not mfo.inputs:
			try:
				mfo.inputConnectors[0].connect(src)
			except Exception as e:
				raise ValueError(f'moviefileout_preview not wired to null_icon: {e}') from e
		self._configurePreviewRecorder(mfo)
		return mfo

	def RecordPreview(self, seconds=None):
		"""Record a short preview clip into preview/preview.mp4."""
		try:
			if seconds is None:
				if hasattr(self.ownerComp.par, 'Recseconds'):
					seconds = float(self.ownerComp.par.Recseconds.eval())
				elif hasattr(self.ownerComp.par, 'Recduration'):
					seconds = float(self.ownerComp.par.Recduration.eval())
				else:
					seconds = 3.0
			seconds = max(0.5, min(float(seconds), 30.0))
			if self.icon_source is None:
				raise ValueError('null_icon missing - cannot capture preview')
			mfo = self._previewRecorder()
			still_rel, still = self._mediaPath('preview.png')
			clip_rel, clip = self._mediaPath('preview.mp4')
			self.icon_source.save(
				still_rel,
				quality=0.5,
				metadata=[
					('source', 'TDXLUUtility'),
					('project_name', project.name),
				],
			)
			# Relative so the path is not baked into the .toe / .tdn
			mfo.par.file = clip_rel
			# Start recording
			if hasattr(mfo.par, 'record'):
				mfo.par.record = 1
			elif hasattr(mfo.par, 'Record'):
				mfo.par.Record = 1
			else:
				raise ValueError('moviefileout_preview has no record parameter')
			rate = float(project.cookRate) if project.cookRate else 60.0
			frames = max(1, int(seconds * rate))

			def _stop():
				try:
					if hasattr(mfo.par, 'record'):
						mfo.par.record = 0
					elif hasattr(mfo.par, 'Record'):
						mfo.par.Record = 0
					self._setMediaStatus(f'Recorded preview.mp4 ({seconds:g}s)')
				except Exception as e:
					self._setMediaStatus(f'Record stop: {e}')

			run(_stop, delayFrames=frames)
			self._setMediaStatus(f'Recording {seconds:g}s...')
			return {'ok': True, 'file': clip, 'still': still, 'seconds': seconds, 'frames': frames}
		except Exception as e:
			self._setMediaStatus(f'Record failed: {e}')
			return {'ok': False, 'error': str(e)}

	def onParRecpulse(self):
		self.PulseIcon()

	def onParRecrecord(self):
		self.RecordPreview()

