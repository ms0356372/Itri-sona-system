type StructuredError={message?:unknown;details?:unknown;hint?:unknown;code?:unknown};

const usefulText=(value:unknown)=>typeof value==='string'&&value.trim()?value:undefined;

export function formatError(error:unknown):string{
  if(error instanceof Error&&error.message)return error.message;
  if(error&&typeof error==='object'){
    const structured=error as StructuredError;
    const detail=usefulText(structured.message)??usefulText(structured.details)??usefulText(structured.hint);
    if(detail)return detail;
    try{const serialized=JSON.stringify(error);if(serialized&&serialized!=='{}')return serialized;}catch{/* Fall through to a stable message for circular values. */}
  }
  return usefulText(error)??'未知錯誤';
}

const additionalErrorMessages:Record<string,string>={
  invalid_examination:'追加檢查項目不正確，請重新選擇。',
  additional_examination_already_waiting:'此受檢者已有一筆追加檢查正在等候。',
  examination_in_progress:'此受檢者目前正在檢查中。',
  not_checked_in:'此受檢者尚未完成報到。',
  invalid_state:'目前受檢者狀態無法追加檢查，請重新整理後再試。',
  not_authorized:'目前帳號沒有執行此操作的權限。',
};

export function formatAdditionalExaminationError(error:unknown):string{
  const detail=formatError(error);
  const known=Object.entries(additionalErrorMessages).find(([key])=>detail.includes(key));
  return known?.[1]??`追加檢查失敗：${detail}`;
}
