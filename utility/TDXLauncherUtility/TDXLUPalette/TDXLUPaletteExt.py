"""
TDXLU Palette tabs - the launcher's TDXLU and Patreon tabs inside
TouchDesigner's Palette Browser, as contributions to FNS_PaletteRegistry.

The registry (shipped dormant in the companion, promoted to /sys) owns the
dialog: the folder-tab strip, a Select COMP mirror per contributed panel,
slot sizing, show/hide. This COMP owns exactly what the launcher needs:

  web              a native container whose background is a Web Render TOP
                   showing the page the launcher serves on loopback, with
                   mouse/keyboard forwarding. One browser process serves
                   BOTH tabs: the registry's onPaletteTab callback routes
                   the page (window.__tdxluRoute) and keeps the browser
                   active only while one of the launcher's tabs shows.
  FNS_PaletteRegistry
                   the stamped host. Its Registration pars publish the
                   'tdxlu' tab (Comp '..', Tab Panel 'web') and its Tab
                   sequence adds 'patreon' - one panel under two names, a
                   block with no Source of its own reusing the primary
                   panel. Nothing is registered from code here.
  palette_callbacks
                   onPaletteTab(canonical, previous) -> OnPaletteTab here.

The page URL arrives over the companion bus ('palette_url'); it is stored
on this COMP so an extension reinit re-applies it. Without a launcher the
panel shows a hint and spawns no browser process.

Nested under TDXLauncherUtility the Active toggle binds UP to the
companion's Palettetabs parameter (parent = edit master); the Url / Status
readouts bind DOWN. Standalone, pre_release.py bakes the bind to a constant.
"""


class TDXLUPaletteExt:
	"""The launcher's contributions to the Palette Browser tab strip."""

	HOST_NAME = 'FNS_PaletteRegistry'
	CALLBACKS_NAME = 'palette_callbacks'
	WEB_NAME = 'web'
	# canonical -> (label, order, page route)
	TABS = {
		'tdxlu': ('TDXLU', 50, 'toolbox'),
		'patreon': ('Patreon', 60, 'patreon'),
	}
	HOST_TAB = 'tdxlu'           # published by the stamped host's Registration page
	URL_KEY = 'TDXLU_palette_url'
	INIT_DELAY_FRAMES = 60
	DIALOG_PATH = '/ui/dialogs/palette'

	# TD's palette tree is built from this file-backed Text DAT; reloading
	# it is how a .tox added behind TD's back becomes visible.
	PALETTE_DATA_PATH = '/ui/dialogs/palette/palette/cusPalette'
	# Frames between visibility polls. TD fires no event when a pane is added
	# to or removed from the layout, so the docked half has to be sampled;
	# four times a second is imperceptible next to a browser process.
	VISIBILITY_POLL_FRAMES = 15

	def __init__(self, ownerComp):
		self.ownerComp = ownerComp
		self._current_tab = ''
		run(lambda: self._postInit(), delayFrames=self.INIT_DELAY_FRAMES)

	def _postInit(self):
		"""Deferred + idempotent: re-applies the URL and the registrations
		after any reinit (the registry may still be promoting)."""
		try:
			# _current_tab is runtime state and a reinit clears it, which
			# would leave the browser off until the user changed tabs. The
			# registry knows which tab is showing -- ask it.
			reg = self._registry()
			if reg is not None:
				try:
					self._current_tab = str(reg.CurrentTab() or '')
				except Exception:
					pass
			self._applyUrl()
			self._syncRegistration()
			self.ApplyActive()
		except Exception as e:
			debug(f'TDXLUPalette: postInit: {e}')

	# --- parameters / readouts --------------------------------------------

	def _par(self, name):
		return getattr(self.ownerComp.par, name, None)

	def _active(self):
		p = self._par('Active')
		if p is None:
			return True
		try:
			return bool(p.eval())
		except Exception:
			return True

	def _setStatus(self, msg):
		p = self._par('Status')
		if p is None:
			return
		try:
			p.val = str(msg)[:160]
		except Exception:
			pass

	def Url(self):
		"""Page URL the launcher handed over (empty until it does)."""
		try:
			return str(self.ownerComp.fetch(self.URL_KEY, '', search=False) or '')
		except Exception:
			return ''

	@staticmethod
	def _publicUrl(url):
		# The bearer token rides in the URL fragment; readouts never show it.
		return str(url or '').split('#', 1)[0]

	# --- pieces -----------------------------------------------------------

	def _host(self):
		return self.ownerComp.op(self.HOST_NAME)

	def _web(self):
		return self.ownerComp.op(self.WEB_NAME)

	def _webrender(self):
		web = self._web()
		return web.op('webrender1') if web is not None else None

	def _callbacks(self):
		return self.ownerComp.op(self.CALLBACKS_NAME)

	def _registry(self):
		"""The promoted FNS_PaletteRegistry, or None -- never guaranteed."""
		reg = getattr(op, 'FNS_PALETTEREGISTRY', None)
		if reg is not None and reg.valid and hasattr(reg, 'RegisterTab'):
			return reg
		return None

	# --- registration -------------------------------------------------------

	def _syncRegistration(self):
		"""Publish (or withdraw) the tabs according to Active.

		Both tabs are the HOST's -- 'tdxlu' from its Registration pars,
		'patreon' from its Tab sequence -- so all this does is flip the
		host's Autoregister and let its own callback apply it.
		"""
		active = self._active()
		host = self._host()
		if host is not None:
			p = getattr(host.par, 'Autoregister', None)
			if p is not None:
				try:
					if bool(p.eval()) != active:
						p.val = active            # the host's par callback (re)applies
				except Exception as e:
					debug(f'TDXLUPalette: host Autoregister: {e}')
		if self._registry() is None:
			self._setStatus('Waiting for FNS_PaletteRegistry' if active else 'Off')
			return False
		self._refreshStatus()
		return True

	def IsInstalled(self):
		reg = self._registry()
		if reg is None:
			return False
		try:
			names = {t['name'] for t in reg.Tabs(include_hidden=True)}
		except Exception:
			return False
		return self.HOST_TAB in names

	def _refreshStatus(self):
		if not self._active():
			self._setStatus('Off')
			return
		url = self.Url()
		if self.IsInstalled():
			self._setStatus('Tabs published - ' + (self._publicUrl(url) if url else 'waiting for TDXLU'))
		else:
			self._setStatus('Registering...')

	def Install(self):
		"""Publish the tabs (turns the feature on if it was off)."""
		p = self._par('Active')
		if p is not None and not self._active():
			try:
				p.val = 1                 # bound up: lands on the companion's Palettetabs
			except Exception:
				pass
		ok = self._syncRegistration()
		reg = self._registry()
		if reg is not None:
			try:
				reg.Resync()
			except Exception:
				pass
		return ok

	def Uninstall(self, quiet=False):
		"""Withdraw the tabs (turns the feature off).

		Autoregister off is enough: the host clears every canonical it
		published, the sequence block included.
		"""
		p = self._par('Active')
		if p is not None and self._active():
			try:
				p.val = 0
			except Exception:
				pass
		host = self._host()
		if host is not None:
			try:
				host.par.Autoregister = False
			except Exception:
				pass
		wr = self._webrender()
		if wr is not None:
			wr.par.active = False
		if not quiet:
			self._setStatus('Off')
		return True

	# --- tab changes (from the registry via palette_callbacks) -------------

	def RefreshPaletteBrowser(self):
		"""Re-read paletteData.json so a newly added .tox shows up now.

		TD's Palette Browser builds its tree from `cusPalette`, a Text DAT
		backed by <user palette>/paletteData.json. The launcher rewrites that
		file whenever it copies a .tox in, but nothing tells the DAT - TD only
		re-reads it on start, or from the tree's own right-click Refresh
		(a macro that needs the right-clicked folder's id, so it is not
		callable from here). Pulsing the DAT's Load File is the whole job.

		Stock TD ops, so this stays a pulse: no parameter is left changed, no
		expression touched.
		"""
		dat = op(self.PALETTE_DATA_PATH)
		if dat is None:
			return {'ok': False, 'error': 'palette browser not open yet'}
		try:
			dat.par.loadonstartpulse.pulse()
		except Exception as exc:
			return {'ok': False, 'error': str(exc)}
		# Size, not rows: it is one row of JSON, so only the length moves.
		return {'ok': True, 'chars': len(dat.text or '')}

	def PaletteVisible(self):
		"""Is TD's Palette Browser on screen at all?

		A Web Render TOP cooks a whole browser process whether or not anyone
		can see its page -- the rule /webBrowser follows for its own Active.
		Two signals together, because neither covers both ways it opens:

		  `ui.showPaletteBrowser` ("get or set display of the palette
		    browser") -- False closed, True while the palette shows in the main
		    window, and it STAYS True if that showing palette is then floated.
		  the dialog's `winopen` -- 1 while the palette has its own floating
		    window. Opened straight to a float from a CLOSED palette (alt+L,
		    the Dialogs menu), `showPaletteBrowser` stays False and this is the
		    only signal there is. Measured, not assumed.

		Neither ever reads true while the palette is closed, so OR is safe.

		Everything more obvious is a dead end here, all measured:
		  `COMP.visibleLevel` reads 0 on this panel, on the registry's Select
		    COMP mirrors and on the palette panel itself -- even with the
		    dialog open and tabs being clicked. It does not describe panels
		    drawn by TD's own editor UI.
		  cook counters never move: no panel op in the dialog cooked once in
		    512 frames, open or closed. Only the Web Render TOP cooks.
		  `par.display` on the dialog stays True either way, and the pane
		    sitting in `ui.panes` under it is a network editor someone parked
		    there, not the dialog's host.
		"""
		try:
			if ui.showPaletteBrowser:
				return True
		except Exception:
			# Unknown rather than hidden: never silently kill a live page.
			return True
		dlg = op(self.DIALOG_PATH)
		return bool(dlg and dlg.panel.winopen)

	def _wantActive(self):
		"""The browser runs only while the Palette Browser is on screen, one
		of our tabs is the current one, and a page is set."""
		return bool(self._current_tab in self.TABS and self.Url() and self.PaletteVisible())

	# Consecutive "not visible" polls before the browser is switched off.
	# Waking is instant; sleeping waits, because a one-frame dip (a tab
	# switch, a pane resize) would otherwise cost a browser restart.
	HIDE_TICKS = 2

	def ApplyActive(self):
		"""Bring the Web Render TOP in line with the rule. Compare before
		set: re-applying must not restart the browser (this is polled)."""
		wr = self._webrender()
		if wr is None:
			return False
		want = self._wantActive()
		try:
			is_on = bool(wr.par.active.eval())
			if want:
				self._hide_ticks = 0
			elif is_on:
				self._hide_ticks = getattr(self, '_hide_ticks', 0) + 1
				if self._hide_ticks < self.HIDE_TICKS:
					return is_on
			if is_on != want:
				wr.par.active = want
				if want and self._current_tab in self.TABS:
					# Coming back from hidden: a restarted browser starts at
					# the URL, so put it back on the tab's route.
					self._route(self.TABS[self._current_tab][2])
		except Exception as e:
			debug(f'TDXLUPalette: browser active: {e}')
		return want

	def OnVisibilityTick(self):
		"""Called from visibility_watch every VISIBILITY_POLL_FRAMES."""
		self.ApplyActive()
		self._flushPendingRoute()

	def OnPaletteTab(self, canonical, previous):
		"""Route the shared page and keep the browser alive only while one
		of the launcher's tabs shows -- and only while the Palette Browser
		is on screen (see ApplyActive). One call per change, so switching
		between the two launcher tabs never restarts the browser."""
		self._current_tab = str(canonical or '')
		if self.ApplyActive():
			self._route(self.TABS[self._current_tab][2])

	# Visibility ticks a route is re-sent for once the page reports loaded.
	# A browser that was just switched on has no page yet, so a route sent
	# in that frame is dropped and the page boots on its default (TDXLU) --
	# the "first click on Patreon opens TDXLU" bug. `loaded` can still read
	# the previous page's state in the switch-on frame, so a few idempotent
	# re-sends after it reads True, rather than trusting the first one.
	ROUTE_RESENDS = 3

	def _flushPendingRoute(self):
		route = getattr(self, '_pending_route', None)
		if not route:
			return
		wr = self._webrender()
		if wr is None or not bool(wr.par.active.eval()):
			return
		try:
			loaded = bool(wr.loaded)
		except Exception:
			loaded = True
		if not loaded:
			return
		self._sendRoute(route)
		self._route_resends = getattr(self, '_route_resends', 0) - 1
		if self._route_resends <= 0:
			self._pending_route = None

	def _route(self, route):
		self._pending_route = route
		self._route_resends = self.ROUTE_RESENDS
		self._sendRoute(route)

	def _sendRoute(self, route):
		wr = self._webrender()
		if wr is None or not self.Url():
			return
		# The page exposes window.__tdxluRoute so switching never touches
		# location.hash - that is where the launcher's bearer token rides.
		try:
			wr.executeJavaScript(
				"(window.__tdxluRoute || function(r){ location.hash = '#/' + r; })(%r)"
				% str(route)
			)
		except Exception as e:
			debug(f'TDXLUPalette: route {route}: {e}')

	# --- URL from the launcher -------------------------------------------

	def SetUrl(self, url):
		"""Point the web panel at the launcher's palette page (bus: palette_url)."""
		url = str(url or '').strip()
		self.ownerComp.store(self.URL_KEY, url)
		p = self._par('Url')
		if p is not None:
			try:
				p.val = self._publicUrl(url)
			except Exception:
				pass
		self._applyUrl()
		if self._active() and not self.IsInstalled():
			self._syncRegistration()
		self._refreshStatus()
		return {'ok': True, 'installed': self.IsInstalled(), 'url_set': bool(url)}

	def _applyUrl(self):
		url = self.Url()
		web = self._web()
		wr = self._webrender()
		if web is None or wr is None:
			return
		hint = web.op('text_hint')
		try:
			if wr.par.url.eval() != url:
				wr.par.url = url
		except Exception:
			pass
		if hint is not None:
			hint.par.display = not bool(url)
		self.ApplyActive()

	def Reload(self):
		"""Reload the page (e.g. after the launcher restarted)."""
		wr = self._webrender()
		if wr is None:
			return False
		try:
			wr.par.reload.pulse()
			return True
		except Exception:
			return False

	def PaletteStatus(self):
		"""Bus-facing state (palette_status)."""
		reg = self._registry()
		return {
			'ok': True,
			'active': self._active(),
			'installed': self.IsInstalled(),
			'registry': reg.path if reg is not None else None,
			'current_tab': self._current_tab,
			'url': self._publicUrl(self.Url()),
			'status': str(self._par('Status').eval()) if self._par('Status') else '',
		}

	def ShowTab(self, canonical):
		reg = self._registry()
		return reg.ShowTab(canonical) if reg is not None else False

	def OpenPaletteBrowser(self):
		try:
			ui.openPaletteBrowser()
			return True
		except Exception as e:
			debug(f'TDXLUPalette: openPaletteBrowser: {e}')
			return False
