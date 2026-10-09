# Embody pre_release hook for STANDALONE exports of TDXLUPalette
# (Releaseall / ExportPortableTox run it on the staged copy; when the whole
# utility is exported, the utility's own pre_release sanitizes this COMP
# instead -- Embody ignores nested hooks).
#
# Three jobs: drop volatile readouts, bake the up-bind to a constant, and
# ship the web panel and the nested registry host inert.

# Active binds UP to the companion (op('..')) when nested -- parent is the
# edit master. Shipped standalone that bind dangles in whatever COMP the
# user drops this into, so it has to become a local constant.
UP_BOUND = ('Active',)
# Machine-local readouts: the URL names this dev box's launcher port and the
# status line describes a session that no longer exists.
VOLATILE = ('Url', 'Status')
# The handed-over page URL carries the launcher's bearer token -- never ship.
STORE_KEYS = ('TDXLU_palette_url',)
# The registry sizes the web panel to the tab slot with expressions on the
# promoted global; a release ships the plain fixed size it was built with.
WEB_SIZE = {'w': 314, 'h': 1024}


def _sanitize(comp):
	if comp is None:
		return
	for name in VOLATILE:
		p = getattr(comp.par, name, None)
		if p is not None and p.mode == ParMode.CONSTANT:
			p.val = ''
	for name in UP_BOUND:
		p = getattr(comp.par, name, None)
		if p is None:
			continue
		# Order matters: on the staged copy the bind master is ALREADY
		# dangling, so assigning .val first would push through the broken
		# bind and raise -- detach via mode, then set the DEFAULT.
		try:
			p.mode = ParMode.CONSTANT
			p.val = p.default
			p.bindExpr = ''
		except Exception:
			pass
	for key in STORE_KEYS:
		try:
			comp.unstore(key)
		except Exception:
			pass
	# The web panel must never ship pointing at a page, with a browser
	# process armed, or sized by a registry that may not exist.
	web = comp.op('web')
	if web is not None:
		for axis, size in WEB_SIZE.items():
			p = getattr(web.par, axis)
			try:
				p.expr = None
				p.mode = ParMode.CONSTANT
				p.val = size
			except Exception:
				pass
		wr = web.op('webrender1')
		if wr is not None:
			try:
				wr.par.active.expr = None
				wr.par.active.mode = ParMode.CONSTANT
				wr.par.active = False
				wr.par.url = ''
			except Exception:
				pass
	# The stamped registry host keeps its configuration (it IS the
	# contribution) but no runtime state: registrations live on the /sys
	# global and are re-made on init.
	host = comp.op('FNS_PaletteRegistry')
	if host is not None:
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


_sanitize(parent())
