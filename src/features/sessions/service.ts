import {requireSupabase} from '../../lib/supabase';
import type {Session} from '../../types';
import {DEFAULT_ROOM_COUNT,getRoomCount,isValidRoomCount,MAX_ROOM_COUNT,MIN_ROOM_COUNT} from '../room/status';
import {formatRoomCountError} from '../../lib/errors';

type SessionRow={id:string;session_date:string;company_name:string;status:'active'|'closing'|'closed';room_count?:number|null};
const sessionColumns='id,session_date,company_name,status,room_count';
const mapSession=(row:SessionRow):Session=>({id:row.id,sessionDate:row.session_date,companyName:row.company_name,status:row.status,roomCount:getRoomCount(row.room_count)});

function validateRoomCount(roomCount:number):void{
  if(!isValidRoomCount(roomCount))throw new Error(`超音波診間數量必須為 ${MIN_ROOM_COUNT}～${MAX_ROOM_COUNT} 間的整數。`);
}

export async function listSessions(){
  const {data,error}=await requireSupabase().from('health_sessions').select(sessionColumns).neq('status','closed').order('session_date',{ascending:false}).order('created_at',{ascending:false});
  if(error)throw error;
  return (data as SessionRow[]).map(mapSession);
}

export async function createSession(companyName:string,sessionDate:string,userId:string,roomCount=DEFAULT_ROOM_COUNT){
  validateRoomCount(roomCount);
  const {data,error}=await requireSupabase().from('health_sessions').insert({company_name:companyName.trim(),session_date:sessionDate,created_by:userId,room_count:roomCount}).select(sessionColumns).single();
  if(error?.code==='23505')throw new Error('同一公司與日期的場次已存在，請從既有場次選擇。');
  if(error)throw error;
  return mapSession(data as SessionRow);
}

/** The RPC locks the session and validates every removed room before changing its count. */
export async function updateSessionRoomCount(sessionId:string,roomCount:number):Promise<Session>{
  validateRoomCount(roomCount);
  const{data,error}=await requireSupabase().rpc('update_session_room_count',{p_session_id:sessionId,p_room_count:roomCount});
  if(error)throw new Error(formatRoomCountError(error));
  return mapSession(data as SessionRow);
}
