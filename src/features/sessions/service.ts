import {requireSupabase} from '../../lib/supabase';
import type {Session} from '../../types';

type SessionRow={id:string;session_date:string;company_name:string;status:'active'|'closing'|'closed'};
const mapSession=(row:SessionRow):Session=>({id:row.id,sessionDate:row.session_date,companyName:row.company_name,status:row.status});

export async function listSessions(){
  const {data,error}=await requireSupabase().from('health_sessions').select('id,session_date,company_name,status').neq('status','closed').order('session_date',{ascending:false}).order('created_at',{ascending:false});
  if(error)throw error;
  return (data as SessionRow[]).map(mapSession);
}

export async function createSession(companyName:string,sessionDate:string,userId:string){
  const {data,error}=await requireSupabase().from('health_sessions').insert({company_name:companyName.trim(),session_date:sessionDate,created_by:userId}).select('id,session_date,company_name,status').single();
  if(error?.code==='23505')throw new Error('同一公司與日期的場次已存在，請從既有場次選擇。');
  if(error)throw error;
  return mapSession(data as SessionRow);
}
