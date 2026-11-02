// This only permits the existing outer retry. It never increases a deadline or starts a request.
export function emptyTerminalDeadline(cause,session){
  return cause?.code==='CODE_NATIVE_DEADLINE'&&!cause.complete_native_reply
    &&session?.closed===true&&session.exit!=null
    &&Array.isArray(session.receipts)&&session.receipts.length===0
    &&Array.isArray(session.frames)&&session.frames.every(e=>e.type==='ping')
    &&Array.isArray(session.events)&&!session.events.some(e=>['assistant','result','tool_progress'].includes(e.type));
}
