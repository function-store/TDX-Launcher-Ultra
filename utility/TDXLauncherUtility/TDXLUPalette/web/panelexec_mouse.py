# Panel Execute DAT - forwards this panel's mouse to the Web Render TOP so
# the launcher's page is clickable inside the Palette Browser. Watches the
# parent container (see the panels parameter) on lselect / mselect /
# rselect / wheel / insideu / insidev.
#
# The button flags ride on every call: the first True starts a virtual
# mouse-down at (u, v), later calls drag, and False releases -- which is
# what makes a click land.
#
# Wheel: the container's Mouse Wheel toggle (par mousewheel) must be ON or
# TD never produces the 'wheel' panel value at all. Its value is read as a
# delta against the previous value, so it works whether TD reports the
# wheel cumulatively or as a one-frame pulse (a pulse returning to 0 is
# skipped, not mirrored). CEF wants pixel deltas, ~120 per notch; the stock
# webBrowser forwards the raw notch and scrolls a pixel at a time.

WHEEL_PIXELS = 120


# Only Value Change is enabled on the DAT. The other triggers are defined as
# no-ops so that switching one on can never raise "Cannot find function".
def onOffToOn(panelValue):
	return


def onOnToOff(panelValue):
	return


def whileOn(panelValue):
	return


def whileOff(panelValue):
	return


def onValueChange(panelValue, prev):
	wr = op('webrender1')
	if wr is None:
		return
	pv = panelValue.owner.panel
	u = pv.insideu
	v = pv.insidev
	if panelValue.name == 'wheel':
		value = float(panelValue)
		if value == 0:
			return
		try:
			delta = value - float(prev)
		except Exception:
			delta = value
		if delta:
			wr.interactMouse(u, v, wheel=delta * WHEEL_PIXELS)
		return
	wr.interactMouse(
		u, v,
		left=bool(pv.lselect),
		middle=bool(pv.mselect),
		right=bool(pv.rselect),
	)
	return
