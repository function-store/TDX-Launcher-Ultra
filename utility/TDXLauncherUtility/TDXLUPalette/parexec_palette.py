# Parameter Execute DAT - routes this COMP's own custom parameters to the
# extension. Watches the parent COMP (see the op parameter).
#
# Active binds UP to the companion's Palettetabs toggle when nested, so a
# change on either side lands here and (un)publishes the tabs.


def onValueChange(par, prev):
	ext = parent.TDXLUPalette
	if par.name == 'Active':
		ext.ext.TDXLUPaletteExt._syncRegistration()
	return


def onPulse(par):
	ext = parent.TDXLUPalette
	if par.name == 'Install':
		ext.Install()
	elif par.name == 'Uninstall':
		ext.Uninstall()
	elif par.name == 'Openpalette':
		ext.OpenPaletteBrowser()
	elif par.name == 'Reload':
		ext.Reload()
	return


def onExpressionChange(par, val, prev):
	return


def onExportChange(par, val, prev):
	return


def onEnableChange(par, val, prev):
	return


def onModeChange(par, val, prev):
	return
