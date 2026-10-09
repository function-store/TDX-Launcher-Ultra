# Timer CHOP callbacks â€” signatures match TD 2025 timerCHOP template

def onInitialize(timerOp, callCount):
	return 0

def onReady(timerOp):
	return

def onStart(timerOp):
	return

def onTimerPulse(timerOp, segment):
	return

def whileTimerActive(timerOp, segment, cycle, fraction):
	return

def onSegmentEnter(timerOp, segment, interrupt):
	return

def onSegmentExit(timerOp, segment, interrupt):
	return

def onCycleStart(timerOp, segment, cycle):
	try:
		timerOp.parent().ext.TDXLUUtilityExt._sendBusHello()
	except Exception as e:
		debug(f'timer_hello: {e}')
	return

def onCycleEndAlert(timerOp, segment, cycle, alertSegment, alertDone, interrupt):
	return

def onCycle(timerOp, segment, cycle):
	return

def onDone(timerOp, segment, interrupt):
	try:
		timerOp.parent().ext.TDXLUUtilityExt._sendBusHello()
	except Exception as e:
		debug(f'timer_hello done: {e}')
	return

def onSubrangeStart(timerOp):
	return
