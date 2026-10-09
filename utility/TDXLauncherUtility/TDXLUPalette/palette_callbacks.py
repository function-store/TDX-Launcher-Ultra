# FNS_PaletteRegistry callbacks for the launcher's tabs (TDXLU / Patreon).
# onPaletteTab fires on every tab change in TD's Palette Browser; the
# extension routes the shared web panel and keeps its browser alive only
# while one of the launcher's tabs is showing.

def onPaletteTab(canonical, previous):
	ext = parent().ext.TDXLUPaletteExt if parent().extensionsReady else None
	if ext is not None:
		ext.OnPaletteTab(canonical, previous)
	return
