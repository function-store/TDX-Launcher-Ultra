# me - this DAT
# dat - the TCP/IP DAT that received data
# peer - Peer for this connection

import json

def onConnect(dat, peer):
	return

def onReceive(dat, rowIndex, message, bytes, peer):
	u = dat.parent()
	ext = u.ext.TDXLUUtilityExt
	try:
		u.store('_bus_cmd_hit', str(message)[:240], search=False)
	except Exception:
		pass
	try:
		result = ext._handleCmdLine(message)
	except Exception as e:
		result = {'type': 'result', 'v': 1, 'ok': False, 'error': str(e)}
		try:
			debug(f'tcpip_cmd HandleCmdLine: {e}')
		except Exception:
			pass
	line = json.dumps(result) + '\n'
	sent = -1
	try:
		sent = peer.sendBytes(line.encode('utf-8'))
	except Exception as e:
		try:
			sent = peer.send(json.dumps(result), terminator='\n')
		except Exception as e2:
			try:
				debug(f'tcpip_cmd reply failed: {e} / {e2}')
			except Exception:
				pass
	try:
		u.store('_bus_cmd_sent', sent, search=False)
		u.store('_bus_cmd_result', json.dumps(result)[:240], search=False)
	except Exception:
		pass
	return

def onClose(dat, peer):
	return
