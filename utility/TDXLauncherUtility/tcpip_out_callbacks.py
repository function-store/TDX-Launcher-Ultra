# me - this DAT
# dat - the TCP/IP DAT
#
# Do NOT write Busstatus here. Client reconnect flaps (onConnect/onClose)
# made the status flip connected/disconnected every hello. Ext owns Busstatus.

def onConnect(dat, peer):
	return

def onReceive(dat, rowIndex, message, bytes, peer):
	return

def onClose(dat, peer):
	return
