# Keeps the Web Render TOP off while nobody can see it.
#
# The rule is TDXLUPaletteExt.PaletteVisible (`ui.showPaletteBrowser`); TD
# fires no callback when the Palette Browser opens or closes, so it is
# sampled every VISIBILITY_POLL_FRAMES frames -- worst case a quarter of a
# second of browser nobody is looking at.
#
# The same trade /webBrowser makes for its own Active parameter: a whole
# browser process is worth a few microseconds of polling to avoid.


def onFrameStart(frame):
	ext = parent.TDXLUPalette.ext.TDXLUPaletteExt
	if frame % ext.VISIBILITY_POLL_FRAMES == 0:
		ext.OnVisibilityTick()
	return


def onFrameEnd(frame):
	return


def onPlayStateChange(state):
	return


def onDeviceChange():
	return


def onProjectPreSave():
	return


def onProjectPostSave():
	return


def onStart():
	return


def onCreate():
	return


def onExit():
	return
