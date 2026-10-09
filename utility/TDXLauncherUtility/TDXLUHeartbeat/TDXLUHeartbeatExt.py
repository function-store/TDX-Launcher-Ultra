"""
TDXLU Heartbeat companion - pulses to the tray watcher via Utility tcpip_out.

See PROTOCOL.md. Keep Port in sync with TDXLU Settings -> Heartbeat.
"""

import os
import time


class TDXLUHeartbeatExt:
	"""Send project-tagged heartbeats so TDXLU can watch this .toe session."""

	def __init__(self, ownerComp):
		self.ownerComp = ownerComp
		self._last_ok = None
		self._last_error = None
		run(lambda: self._syncTimerFromPars(), endFrame=True)

	def ProjectWatchId(self):
		"""Normalized absolute .toe path - must match TDXLU Heartbeat panel id."""
		override = ''
		try:
			override = (self.ownerComp.par.Watchid.eval() or '').strip()
		except Exception:
			pass
		if override:
			return self._normalizeId(override)
		try:
			folder = project.folder
			name = project.name
		except Exception:
			return None
		if not folder or not name:
			return None
		toe = name if str(name).lower().endswith('.toe') else f'{name}.toe'
		return self._normalizeId(os.path.join(folder, toe))

	def _normalizeId(self, path):
		p = os.path.normpath(os.path.abspath(path))
		if p.startswith('\\\\?\\'):
			p = p[4:]
		p = p.replace('\\', '/')
		if os.name == 'nt':
			p = p.lower()
		return p

	def _busExt(self):
		"""Parent Utility extension (owns tcpip_out)."""
		try:
			return self.ownerComp.parent().ext.TDXLUUtilityExt
		except Exception:
			return None

	def SendHeartbeat(self, fps=None):
		"""Fire one heartbeat. Silent no-op if Active is off or watcher is down."""
		try:
			if not self.ownerComp.par.Active.eval():
				return False
		except Exception:
			return False

		wid = self.ProjectWatchId()
		if not wid:
			self._setStatus('No project id')
			return False

		if fps is None:
			try:
				import absTime  # type: ignore
				fps = float(absTime.frameRate)
			except Exception:
				fps = None

		payload = {'type': 'heartbeat', 'v': 1, 'id': wid, 'path': wid}
		if fps is not None:
			payload['fps'] = float(fps)

		ext = self._busExt()
		if ext is None:
			self._setStatus('Missing Utility Ext')
			return False
		try:
			ok = ext._sendBusLine(payload)
			if not ok:
				self._setStatus('tcpip_out send failed')
				return False
			self._last_ok = time.time()
			self._last_error = None
			fps_s = f' fps={fps:.1f}' if fps is not None else ''
			self._setStatus(f'OK {time.strftime("%H:%M:%S")}{fps_s}')
			return True
		except Exception as e:
			self._last_error = str(e)
			self._setStatus(f'Waiting ({e})')
			return False

	def _setStatus(self, msg):
		try:
			self.ownerComp.par.Status.val = str(msg)[:120]
		except Exception:
			pass

	def _syncTimerFromPars(self):
		"""Keep timer length = Interval seconds; Active drives cooking."""
		timer = self.ownerComp.op('timer_heartbeat')
		if not timer:
			return
		try:
			interval = float(self.ownerComp.par.Interval.eval())
		except Exception:
			interval = 1.0
		interval = max(0.25, interval)
		timer.par.length = interval
		timer.par.lengthunits = 'seconds'
		timer.par.cycle = True
		if hasattr(timer.par, 'cyclelimit'):
			timer.par.cyclelimit = False
		try:
			active = bool(self.ownerComp.par.Active.eval())
		except Exception:
			active = False
		timer.par.play = active
		timer.bypass = not active
		if active:
			try:
				timer.par.initialize.pulse()
				timer.par.start.pulse()
			except Exception:
				pass

	def _syncTimer(self):
		"""Refresh timer from Active / Interval pars."""
		self._syncTimerFromPars()

	def CopyWatchId(self):
		wid = self.ProjectWatchId()
		if not wid:
			self._setStatus('No project id')
			return
		try:
			ui.clipboard = wid  # type: ignore[name-defined]
			self._setStatus(f'Copied id ({len(wid)} chars)')
		except Exception as e:
			debug(f'TDXLUHeartbeat: clipboard failed: {e}')
			self._setStatus(str(wid)[:80])
