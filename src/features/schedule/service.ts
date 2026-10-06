import {requireSupabase} from '../../lib/supabase'; import type {ImportResult,Participant} from '../../types'; import type {ScheduleRow} from './excel';
import type {PreparedPerson} from '../roster/types';
import {groupForSlot} from './rules';
import {formatError} from '../../lib/errors';
type ParticipantRow={id:string;session_id:string;sequence_no:number;employee_no:string;full_name:string;gender:string;schedule_slot:string;group_code:Participant['groupCode'];planned_items:string[];checkin_no:string|null;status:Participant['status'];checked_in_at:string|null;called_at:string|null;note:string;updated_at:string};
export const mapParticipant=(r:ParticipantRow):Participant=>({id:r.id,sessionId:r.session_id,sequence:r.sequence_no,employeeNo:r.employee_no,name:r.full_name,gender:r.gender,slot:r.schedule_slot,groupCode:r.group_code,plannedItems:r.planned_items,checkinNo:r.checkin_no,status:r.status,checkedInAt:r.checked_in_at,calledAt:r.called_at,note:r.note,updatedAt:r.updated_at});
export async function listParticipants(sessionId:string){const{data,error}=await requireSupabase().from('participants').select('*').eq('session_id',sessionId).order('sequence_no');if(error)throw error;return(data as ParticipantRow[]).map(mapParticipant);}
export async function findParticipant(sessionId:string,employeeNo:string){const{data,error}=await requireSupabase().from('participants').select('*').eq('session_id',sessionId).eq('employee_no',employeeNo).maybeSingle();if(error)throw error;return data?mapParticipant(data as ParticipantRow):null;}
export async function importSchedule(sessionId:string,rows:ScheduleRow[]):Promise<ImportResult>{const existing=await listParticipants(sessionId);const keys=new Set(existing.map(p=>p.employeeNo));const unique:ScheduleRow[]=[];const batch=new Set<string>();for(const row of rows){if(keys.has(row.employeeNo)||batch.has(row.employeeNo))continue;batch.add(row.employeeNo);unique.push(row);}if(unique.length){const payload=unique.map(r=>({session_id:sessionId,sequence_no:r.sequence,employee_no:r.employeeNo,full_name:r.name,gender:r.gender,schedule_slot:r.slot,group_code:r.groupCode,planned_items:r.items}));const{error}=await requireSupabase().from('participants').insert(payload);if(error)throw error;}return{inserted:unique.length,skipped:rows.length-unique.length};}

/** Uploads only operational fields. The local national ID is deliberately absent. */
export function preparedCloudRow(sessionId:string,row:PreparedPerson,index:number){
  const groupCode=groupForSlot(row.slot);
  if(!groupCode)throw new Error('排程時段無法對應 A～G 組別，請重新選擇時段。');
  const payload={session_id:sessionId,sequence_no:row.sequence||index+1,employee_no:row.employeeNo,full_name:row.name,gender:row.gender,schedule_slot:row.slot,group_code:groupCode,planned_items:[row.item],note:row.extension?`院內分機：${row.extension}`:''};
  // An allowlist also protects against accidentally copying the scanned ID into
  // a free-text field. Reject rather than silently alter an operational identity.
  const textValues=Object.values(payload).flatMap(value=>typeof value==='string'?[value]:Array.isArray(value)?value:[]);
  if(textValues.some(value=>/[A-Z](?:[1289]\d{8}|[A-D]\d{8})/i.test(value.normalize('NFKC').replace(/[\s-]/g,'')))){
    throw new Error('身分證僅保留本機；上傳欄位不可包含完整身分證，請確認姓名、工號、項目與分機。');
  }
  return payload;
}

export function assertPreparedParticipantIdentity(participant:Participant,sessionId:string,row:PreparedPerson):Participant{
  if(participant.sessionId!==sessionId||participant.employeeNo!==row.employeeNo||participant.name.trim()!==row.name.trim()||(participant.gender.trim()&&participant.gender.trim()!==row.gender.trim())){
    throw new Error('此工號已存在於雲端今日排程，但人員資料不同，請至名單管理確認。');
  }
  return participant;
}

/** Insert only this participant. Existing identity, schedule and workflow stay intact. */
export async function upsertPreparedParticipant(sessionId:string,row:PreparedPerson):Promise<Participant>{
  const payload=preparedCloudRow(sessionId,row,0);
  try{
    const existing=await findParticipant(sessionId,row.employeeNo);
    if(existing)return assertPreparedParticipantIdentity(existing,sessionId,row);
    const{data,error}=await requireSupabase().from('participants').insert(payload).select('*').single();
    if(error){
      if(error.code==='23505'){
        const raced=await findParticipant(sessionId,row.employeeNo);
        if(raced)return assertPreparedParticipantIdentity(raced,sessionId,row);
        throw new Error('雲端工號衝突後仍無法取得受檢者，請確認連線與權限後重試。');
      }
      throw error;
    }
    if(!data)throw new Error('雲端未回傳受檢者資料，請確認連線後重試。');
    return assertPreparedParticipantIdentity(mapParticipant(data as ParticipantRow),sessionId,row);
  }catch(error){
    const detail=formatError(error).normalize('NFKC').replace(/[A-Z][\s-]*(?:[1289](?:[\s-]*\d){8}|[A-D](?:[\s-]*\d){8})/gi,'[身分證已隱藏]');
    throw new Error(`受檢者雲端同步失敗：${detail}`);
  }
}
export async function uploadPreparedSchedule(sessionId:string,rows:PreparedPerson[]):Promise<ImportResult>{
  const existing=await listParticipants(sessionId);const existingEmployees=new Set(existing.map(person=>person.employeeNo));const seen=new Set<string>();const unique=rows.filter(row=>{if(existingEmployees.has(row.employeeNo)||seen.has(row.employeeNo))return false;seen.add(row.employeeNo);return true;});
  const payload=unique.map((row,index)=>preparedCloudRow(sessionId,row,index));
  if(payload.length){const{error}=await requireSupabase().from('participants').insert(payload);if(error)throw error;}
  return{inserted:payload.length,skipped:rows.length-payload.length};
}
