export const TAIWAN_ZONE='Asia/Taipei';
export const formatTaiwan=(iso?:string|null)=>iso?new Intl.DateTimeFormat('zh-TW',{timeZone:TAIWAN_ZONE,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(iso)):'—';
export const elapsedSeconds=(start:string,end:string)=>Math.max(0,Math.floor((Date.parse(end)-Date.parse(start))/1000));
