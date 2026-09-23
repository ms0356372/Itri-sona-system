import {requireSupabase} from '../../lib/supabase'; import {db} from '../history/db';
export async function acknowledgeLocalClear(sessionId:string,deviceId:string){await db.transaction('rw',db.history,db.drafts,async()=>{await db.history.clear();await db.drafts.clear()});const {error}=await requireSupabase().rpc('acknowledge_device_clear',{p_session_id:sessionId,p_device_id:deviceId});if(error)throw error;}
export async function closeSession(sessionId:string){const {data,error}=await requireSupabase().rpc('close_health_session',{p_session_id:sessionId});if(error)throw error;return data;}
