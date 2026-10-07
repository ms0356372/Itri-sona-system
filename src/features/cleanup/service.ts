import {requireSupabase} from '../../lib/supabase';
import {canUsePage,getStaffPermissions} from '../auth/permissions';
import {db} from '../history/db';
// Closing a daily session must never erase the tablet's multi-year medical history.
export async function acknowledgeLocalClear(sessionId:string,deviceId:string){
  const client=requireSupabase();
  // Check the current server-verified identity before any local destructive action.
  const {data,error:authError}=await client.auth.getUser();
  if(authError)throw authError;
  if(!data.user)throw new Error('not_authorized');
  const permissions=await getStaffPermissions(data.user.id);
  if(!canUsePage(permissions,'registration'))throw new Error('permission_denied');
  await db.drafts.clear();
  // A device may acknowledge clearance only after its local drafts were cleared successfully.
  const {error}=await client.rpc('acknowledge_device_clear',{p_session_id:sessionId,p_device_id:deviceId});
  if(error)throw error;
}
export async function closeSession(sessionId:string){const {data,error}=await requireSupabase().rpc('close_health_session',{p_session_id:sessionId});if(error)throw error;return data;}
