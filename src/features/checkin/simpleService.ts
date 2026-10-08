import {friendlyError} from '../../lib/errors';
import {requireSupabase} from '../../lib/supabase';
import type {Participant,Session} from '../../types';
import type {MasterPerson} from '../roster/types';
import {mapParticipant} from '../schedule/service';
import {isSimpleSession} from '../workflow/mode';

export type SimplePerson=Pick<MasterPerson,'employeeNo'|'name'|'gender'|'item'|'extension'>;

/** Operational fields are allowlisted; a local national ID is never copied to cloud arguments. */
export function simpleCloudArguments(session:Session,source:SimplePerson){
  if(!isSimpleSession(session)||session.status!=='active')throw new Error('請先選擇可報到的簡易模式場次。');
  const person={employeeNo:source.employeeNo.trim(),name:source.name.trim(),gender:source.gender.trim(),item:source.item.trim(),extension:source.extension.trim()};
  if(!person.name)throw new Error('請輸入姓名。');
  if(!person.employeeNo)throw new Error('請輸入工號。');
  if(!person.item)throw new Error('受檢者項目不可空白，請確認人員資料。');
  if(Object.values(person).some(value=>/[A-Z](?:[1289]\d{8}|[A-D]\d{8})/i.test(value.normalize('NFKC').replace(/[\s-]/g,'')))){
    throw new Error('身分證僅保留本機；上傳欄位不可包含完整身分證，請確認姓名、工號、項目與分機。');
  }
  return{p_session_id:session.id,p_employee_no:person.employeeNo,p_full_name:person.name,p_gender:person.gender,p_item:person.item,p_extension:person.extension};
}

export function simpleError(error:unknown):string{
  const detail=friendlyError(error);
  const messages:Record<string,string>={
    simple_identity_conflict:'此工號已有報到紀錄，但人員資料不同，請工作人員確認。',
    invalid_simple_participant:'受檢者資料不完整，請確認姓名、工號與項目。',
    invalid_workflow_mode:'場次模式不符，請重新選擇簡易模式場次。',
    session_not_active:'此場次目前無法報到，請重新選擇有效場次。',
    session_not_found:'找不到此場次，請重新整理後再試。',
  };
  const known=Object.entries(messages).find(([code])=>detail.includes(code));
  return (known?.[1]??detail).normalize('NFKC').replace(/[A-Z][\s-]*(?:[1289](?:[\s-]*\d){8}|[A-D](?:[\s-]*\d){8})/gi,'[身分證已隱藏]');
}

/** The database owns both the counter and repeat-check-in identity; never derive a number locally. */
export async function simpleCheckIn(session:Session,source:SimplePerson):Promise<Participant>{
  const arguments_=simpleCloudArguments(session,source);
  try{
    const{data,error}=await requireSupabase().rpc('simple_check_in_participant',arguments_);
    if(error)throw error;
    if(!data||Array.isArray(data))throw new Error('無法確認報到結果，請重新查詢後重試。');
    const participant=mapParticipant(data as Parameters<typeof mapParticipant>[0]);
    if(participant.sessionId!==session.id||participant.employeeNo!==arguments_.p_employee_no
      ||participant.name.trim()!==arguments_.p_full_name||participant.gender.trim()!==arguments_.p_gender
      ||!Number.isInteger(participant.queueNumber)||Number(participant.queueNumber)<1
      ||participant.checkinNo!==String(participant.queueNumber)||!participant.checkedInAt
      ||participant.groupCode!==null||participant.slot!==null){
      throw new Error('無法確認報到結果，請重新查詢後重試。');
    }
    return participant;
  }catch(error){throw new Error(simpleError(error));}
}
