export const TAIWAN_ZONE='Asia/Taipei';
const taiwanMinuteFormatter=new Intl.DateTimeFormat('en-GB',{timeZone:TAIWAN_ZONE,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
/** Read the Taiwan clock from a supplied server timestamp, never the device clock. */
export function taiwanMinutesAt(iso:string|null|undefined):number|null{
  if(!iso||!/(?:Z|[+-]\d{2}:\d{2})$/i.test(iso))return null;
  const timestamp=Date.parse(iso);
  if(!Number.isFinite(timestamp))return null;
  const parts=taiwanMinuteFormatter.formatToParts(new Date(timestamp));
  return Number(parts.find(part=>part.type==='hour')?.value)*60+Number(parts.find(part=>part.type==='minute')?.value);
}
export const taiwanToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:TAIWAN_ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export const formatTaiwan=(iso?:string|null)=>iso?new Intl.DateTimeFormat('zh-TW',{timeZone:TAIWAN_ZONE,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(iso)):'—';
export const formatTaiwanClock=(iso?:string|null)=>iso?new Intl.DateTimeFormat('zh-TW',{timeZone:TAIWAN_ZONE,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(iso)):'—';
export const elapsedSeconds=(start:string,end:string)=>Math.max(0,Math.floor((Date.parse(end)-Date.parse(start))/1000));
