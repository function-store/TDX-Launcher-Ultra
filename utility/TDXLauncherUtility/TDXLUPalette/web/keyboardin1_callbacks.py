# Keyboard In DAT callbacks - forwards keystrokes to the Web Render TOP while
# this panel has focus (the DAT's Panels parameter points at the container),
# so the page's search field is typeable inside the Palette Browser. Same
# mapping as TD's stock webBrowser component.


def onKey(dat, keyInfo):
	if not keyInfo.state:
		return
	wr = op('webrender1')
	if wr is None:
		return
	key = keyInfo.key
	if key.isdigit():
		key = ord(key)
	wr.sendKey(
		key,
		char=keyInfo.character,
		alt=keyInfo.alt,
		ctrl=keyInfo.ctrl,
		shift=keyInfo.shift,
		cmd=keyInfo.cmd,
	)
	return


def onShortcut(dat, shortcutName, time):
	return
