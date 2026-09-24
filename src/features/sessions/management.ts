import {requireSupabase} from '../../lib/supabase';

/** Cloud operations are transactional RPCs. Local state must only be cleared after these resolve. */
export async function clearSessionSchedule(sessionId:string){
  const{error}=await requireSupabase().rpc('clear_session_schedule',{p_session_id:sessionId});
  if(error)throw error;
}

export async function deleteSession(sessionId:string){
  const{error}=await requireSupabase().rpc('delete_health_session',{p_session_id:sessionId});
  if(error)throw error;
}
