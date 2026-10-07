type StructuredError={message?:unknown;details?:unknown;hint?:unknown;code?:unknown};
import {MAX_ROOM_COUNT,MIN_ROOM_COUNT,normalizeRoomId} from '../features/room/config';

const usefulText=(value:unknown)=>typeof value==='string'&&value.trim()?value:undefined;

function rawError(error:unknown):string{
  if(error instanceof Error&&error.message)return error.message;
  if(error&&typeof error==='object'){
    const structured=error as StructuredError;
    const detail=usefulText(structured.message)??usefulText(structured.details)??usefulText(structured.hint);
    if(detail)return detail;
    try{const serialized=JSON.stringify(error);if(serialized&&serialized!=='{}')return serialized;}catch{/* Fall through to a stable message for circular values. */}
  }
  return usefulText(error)??'未知錯誤';
}

const permissionMessage='此帳號沒有執行此功能的權限。';
function isPermissionError(error:unknown):boolean{
  const code=error&&typeof error==='object'?(error as StructuredError).code:undefined;
  return code==='42501'||/permission[_ ]denied|not_authorized/i.test(rawError(error));
}

export function formatError(error:unknown):string{
  return isPermissionError(error)?permissionMessage:rawError(error);
}

export function formatPermissionError(error:unknown):string{
  return formatError(error);
}

export function friendlyError(error:unknown):string{
  const message=formatError(error);
  if(message.includes('room_claim_lost'))return '本機已失去此診間的使用權，請重新選擇診間。';
  if(message.includes('room_claimed'))return '此診間目前正在其他設備使用中。';
  if(message.includes('heartbeat_failed'))return '診間連線暫時異常，系統將自動重試。';
  if(/\binvalid_room\b/.test(message))return '此場次沒有這個診間。';
  if(/room_count|session_read_only|room_not_enabled/.test(message))return formatRoomCountError(error);
  if(/invalid login credentials/i.test(message))return 'Email 或密碼不正確。';
  if(/email not confirmed/i.test(message))return '此帳號尚未完成 Email 驗證。';
  if(/failed to fetch|network/i.test(message))return '無法連線至雲端，請檢查網路後重試。';
  return message||'操作失敗，請稍後再試。';
}

const additionalErrorMessages:Record<string,string>={
  invalid_examination:'追加檢查項目不正確，請重新選擇。',
  additional_examination_already_waiting:'此受檢者已有一筆追加檢查正在等候。',
  examination_in_progress:'此受檢者目前正在檢查中。',
  not_checked_in:'此受檢者尚未完成報到。',
  invalid_state:'目前受檢者狀態無法追加檢查，請重新整理後再試。',
};

export function formatAdditionalExaminationError(error:unknown):string{
  const detail=formatError(error);
  const known=Object.entries(additionalErrorMessages).find(([key])=>detail.includes(key));
  return known?.[1]??`追加檢查失敗：${detail}`;
}

export function formatRoomCountError(error:unknown):string{
  const detail=formatError(error);
  const blocked=detail.match(/room_count_(in_progress|away|unfinished|claimed):\s*([^\n]+)/);
  if(blocked){
    const room=normalizeRoomId(blocked[2]).replace(' ','');
    const reason=blocked[1]==='in_progress'?'目前檢查中':blocked[1]==='away'?'目前暫時離開':blocked[1]==='claimed'?'目前仍由設備使用中':'有尚未完成的受檢者資料';
    return`無法減少診間數量：${room}${reason}。`;
  }
  if(detail.includes('invalid_room_count'))return`超音波診間數量必須為 ${MIN_ROOM_COUNT}～${MAX_ROOM_COUNT} 間的整數。`;
  if(detail.includes('session_read_only'))return'歷史場次為唯讀，無法修改超音波診間數量。';
  if(detail.includes('invalid_session'))return'找不到此場次，請重新整理後再試。';
  return detail;
}
