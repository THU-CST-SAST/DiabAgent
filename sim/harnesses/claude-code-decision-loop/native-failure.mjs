/** Only terminal CLI errors are classified; assistant text is not transport evidence. */
export function nativeTerminalFailure(events) {
  const result=events.findLast(event=>event.type==='result');
  if(!result?.is_error)return null;
  const message=result.errors?.join('; ')||result.result||'Native Code terminal API error';
  const text=String(message),typed=result.api_error_status;
  let status=Number.isInteger(typed)&&typed>=400&&typed<=599?typed:null;
  let classification=status===null?null:'typed_native_api_status';
  if(status===null){
    const http=text.match(/^API Error:\s*(\d{3})\b/);
    if(http&&+http[1]>=400&&+http[1]<=599){status=+http[1];classification='native_terminal_status_message';}
    else if(/^(?:API Error:\s*)?Request timed out\.?$/.test(text)){status=504;classification='native_terminal_timeout';}
    else if(/^API Error:\s*Connection dropped \(ECONNRESET\)\.?$/.test(text)){status=503;classification='native_terminal_connection_reset';}
  }
  if(status===null)return null;
  return Object.assign(new Error(text),{status,native_terminal_error:true,
    native_error_classification:classification,native_reported_status:Number.isInteger(typed)?typed:null});
}
