# Embody pre_release hook -- runs on the STAGED COPY during Releaseall /
# ExportPortableTox (me = this DAT, parent() = the copy), so the live
# network is never touched. Keep released toxes free of volatile state:
# status readouts and collect-run summaries carry machine-local paths.
# Nested hooks are ignored by Embody, so this hook must also sanitize
# nested COMPs (TDXLUCollect keeps its own hook only for standalone
# exports of that COMP).

# (Historical: Status/Boundport were TDXLUSensors readouts - a port bound on this dev box and
# a status line naming it are meaningless in a user's project. The parent's own
# Snsstatus/Snsboundport mirrors bind DOWN, so the CONSTANT check skips them.
# Mediastatus is the TDXLUMedia readout: it names a file and an operator from
# whatever project the export ran in.
# Envoystatus reports this dev box's Embody state ("Embody Envoyport=9879").
# Embody is optional and most users never install it, so shipping that line
# tells them a third-party package is wired up when nothing is.
# Sidecar* fields hold THIS project's launcher metadata (title, tags, hero
# path) plus the last load/save readout - authored data of whatever project
# the export ran in, meaningless anywhere else.
# Lastsave is the TDXLUAutosave readout: a clock time and a .toe name from
# the dev project.
VOLATILE_PARS = (
	'Collectstatus', 'Status', 'Boundport', 'Mediastatus', 'Envoystatus',
	'Sidecartitle', 'Sidecardescription', 'Sidecartags', 'Sidecarhero',
	'Sidecarstatus', 'Lastsave', 'Url',
)
# Real settings (not readouts) whose dev-box value is wrong for a user, so they
# are reset rather than blanked. Envoyport tracks whatever Embody this project
# happened to run against; a release should carry the authored default.
# Autosave is armed per project, never per tox: a release that ships with
# As* carrying this dev box's settings would start saving someone else's
# project on our schedule the moment they drop the tox in.
DEFAULT_PARS = (
	'Envoyport', 'Asactive', 'Asinterval', 'Asmode', 'Asonlymodified',
	'Asskipperform',
)
# _bus_cmd_*: tcpip_cmd debug breadcrumbs — they carry machine-local project
# paths and must never ship in a released tox.
STORE_KEYS = ('TDXLUCollectLast', '_bus_cmd_hit', '_bus_cmd_sent', '_bus_cmd_result')
# Custom-par styles that hold operator references. A released tox must not
# point at dev-project operators (e.g. Iconsource -> noise1 or an
# op('/perform') expression): the target doesn't exist in a user's project,
# so every such ref ships as a parameter warning.
OP_REF_STYLES = (
	'OP', 'COMP', 'PanelCOMP', 'Object', 'TOP', 'CHOP', 'SOP', 'DAT',
	'MAT', 'POP',
)


def _clearPhoneClients(comp):
	"""Drop the connected-phone table -- it holds LAN addresses and user agents."""
	if comp is None:
		return
	t = comp.op('table_clients')
	if t is not None:
		try:
			t.clear()
		except Exception:
			pass


def _resetToggles(comp, names):
	"""Return authored toggles to their defaults.

	A filter left on in the dev project is UI state, not a shipped setting:
	a user dropping the tox in should see the same panel the author designed,
	not whatever the last session was looking at.
	"""
	if comp is None:
		return
	for name in names:
		p = getattr(comp.par, name, None)
		if p is not None and p.mode == ParMode.CONSTANT:
			p.val = 1 if p.default else 0


def _sanitize(comp):
	if comp is None:
		return
	for name in VOLATILE_PARS:
		p = getattr(comp.par, name, None)
		if p is not None and p.mode == ParMode.CONSTANT:
			p.val = ''
	for name in DEFAULT_PARS:
		p = getattr(comp.par, name, None)
		if p is not None and p.mode == ParMode.CONSTANT:
			p.val = p.default
	for key in STORE_KEYS:
		try:
			comp.unstore(key)
		except Exception:
			pass


# TCP/IP DATs persist their runtime message FIFO in the saved table - the
# received/sent rows carry machine-local project paths. Operator-generated
# DATs refuse .clear() ("not editable"); their Clear pulse does the job.
WIPE_DATS = ('tcpip_cmd', 'tcpip_out')


def _wipeDats(root):
	for name in WIPE_DATS:
		d = root.op(name)
		if d is not None:
			try:
				d.par.clear.pulse()
			except Exception:
				pass


def _isAbsolutePath(raw):
	return raw.startswith('/') or raw.startswith('\\\\') or (
		len(raw) > 1 and raw[1] == ':'
	)


def _clearAbsoluteFileRefs(root):
	"""Blank DAT file-sync params holding machine-absolute paths.

	The DAT text is embedded in the tox; an absolute sync path can never
	resolve on another machine and only ships as a 'File not found for sync'
	warning (Embody flags these as 'Absolute path won't be portable' at
	export). Relative paths are left to Embody's own portable-export logic.
	"""
	for d in root.findChildren(type=DAT):
		fp = getattr(d.par, 'file', None)
		if fp is None or fp.mode != ParMode.CONSTANT:
			continue
		raw = str(fp.val or '').strip()
		if not raw or not _isAbsolutePath(raw):
			continue
		fp.val = ''
		sf = getattr(d.par, 'syncfile', None)
		if sf is not None and sf.mode == ParMode.CONSTANT:
			sf.val = False


def _insideRoot(target, root):
	return target is not None and (
		target is root or target.path.startswith(root.path + '/')
	)


def _clearExternalOpRefs(root):
	"""Reset OP-reference custom pars that do not resolve inside the export.

	Runs on the staged copy, where absolute / dev-relative references still
	resolve to the LIVE dev project - so anything whose target is missing or
	sits outside the staged root would ship dangling. Reset those to an empty
	constant; references within the shipped COMP are kept as-is.
	"""
	for comp in [root] + root.findChildren(type=COMP):
		for p in comp.customPars:
			if p.style not in OP_REF_STYLES:
				continue
			if p.mode == ParMode.CONSTANT and not str(p.val or '').strip():
				continue
			try:
				target = p.eval()
			except Exception:
				target = None
			if not _insideRoot(target, root):
				# Clear the stored expression too - it is inert in constant
				# mode but still ships, and points at dev-project ops.
				try:
					p.expr = ''
				except Exception:
					pass
				p.mode = ParMode.CONSTANT
				p.val = ''


_sanitize(parent())
# Collect, Media and the phone-touch receiver LEFT the companion (D7,
# 2026-08-31): they ship as the FNS_Collect / FNS_Media / FNS_Remote
# packages and sanitize themselves on their own exports. Nothing to do
# here for them any more.
# TDXLUAutosave: readouts only, for the same reason as TDXLUSensors - its
# settings bind UP to this COMP, which ships in a whole-utility export, so
# those binds resolve. Detaching them is the STANDALONE case, handled by that
# COMP's own hook. The Active toggle it follows is reset above via
# DEFAULT_PARS, so a released tox never lands already armed.
_sanitize(parent().op('TDXLUAutosave'))
# TDXLUPalette: Url/Status are readouts (cleared via VOLATILE_PARS); the
# handed-over page URL in storage carries the launcher's bearer token, the
# web panel must never ship pointing at a page, with a browser process
# armed, or sized by the registry's slot expressions, and the stamped
# FNS_PaletteRegistry host inside keeps its configuration but no runtime
# state. Palettetabs itself is a real setting and ships as authored.
_palette = parent().op('TDXLUPalette')
if _palette is not None:
	_sanitize(_palette)
	try:
		_palette.unstore('TDXLU_palette_url')
	except Exception:
		pass
	_web = _palette.op('web')
	if _web is not None:
		for _axis, _size in (('w', 314), ('h', 1024)):
			_p = getattr(_web.par, _axis)
			try:
				_p.expr = None
				_p.mode = ParMode.CONSTANT
				_p.val = _size
			except Exception:
				pass
		_wr = _web.op('webrender1')
		if _wr is not None:
			try:
				_wr.par.active.expr = None
				_wr.par.active.mode = ParMode.CONSTANT
				_wr.par.active = False
				_wr.par.url = ''
			except Exception:
				pass


def _scrubRegistryHost(host, keep_config):
	"""FNS_PaletteRegistry copies ship inert: no /sys state, no shortcut, no
	clone, no foreign tox binding, no surface ops. A HOST keeps its
	Registration pars AND its Tab sequence (they ARE the contribution); the
	MASTER ships with both at defaults.

	This mirrors the registry's own pre_release for the master case -- Embody
	runs only the ROOT COMP's hook, so a nested master would otherwise ship
	carrying this dev project's configuration.
	"""
	if host is None:
		return
	for key in ('PaletteRegistryExtStored', 'PaneRegistry', 'HostCanonical'):
		if key in host.storage:
			host.unstore(key)
	try:
		host.par.Regstatus.val = ''
		host.par.opshortcut = ''
		host.par.clone = ''
		host.par.enableexternaltox = False
		host.par.externaltox = ''
	except Exception:
		pass
	# Surface ops are runtime state on the /sys global; a copy taken from one
	# would carry them into the tox.
	for _o in list(host.ops('fnspal_*')):
		try:
			_o.destroy()
		except Exception:
			pass
	if keep_config:
		return
	# pi_suspect marks the dev project's authored copy, never a shipped one.
	if 'pi_suspect' in host.tags:
		host.tags.remove('pi_suspect')
	for _page in host.customPages:
		if _page.name == 'Registration':
			for _p in _page.pars:
				try:
					_p.mode = ParMode.CONSTANT
					if _p.style != 'Pulse':
						_p.val = _p.default
				except Exception:
					pass
	# Extra tabs are this project's configuration. TD keeps a minimum of one
	# sequence block, so reset to a single empty one (empty Name = no tab).
	try:
		_seq = host.seq.Tab
		_seq.numBlocks = 1
		_b = _seq[0]
		_b.par.Name = ''
		_b.par.Source = ''
		_b.par.Label = ''
		_b.par.Order = 50
		_b.par.Shown = True
	except Exception:
		pass
	# Autoregister DEFAULTS to on (that is what a stamped host wants), but a
	# master with no canonical name would only boot into 'Error: empty
	# canonical name' -- the shipper stays dormant until it is stamped.
	try:
		host.par.Autoregister = False
	except Exception:
		pass


_scrubRegistryHost(parent().op('FNS_PaletteRegistry'), keep_config=False)
if _palette is not None:
	_scrubRegistryHost(_palette.op('FNS_PaletteRegistry'), keep_config=True)
_clearExternalOpRefs(parent())
_wipeDats(parent())
_clearAbsoluteFileRefs(parent())
parent().par.Iconsource = '/perform'
