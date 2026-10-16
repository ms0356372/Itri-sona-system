import {requireSupabase} from '../../lib/supabase'; import type {WorkStatus} from '../../types';
export async function updateWaitingStatus(id:string,status:Extract<WorkStatus,'等候中'|'上廁所'|'心電圖'|'先做其他'>){const{error}=await requireSupabase().rpc('set_waiting_status',{p_participant_id:id,p_status:status});if(error)throw error;}
export async function callParticipant(id:string){const{error}=await requireSupabase().rpc('call_participant',{p_participant_id:id});if(error)throw error;}

export async function promoteWaitingParticipant(id:string){
  const {error}=await requireSupabase().rpc('promote_waiting_participant',{p_participant_id:id});
  if(error)throw error;
}

export async function cancelPromotedParticipant(id:string){
  const {error}=await requireSupabase().rpc('cancel_promoted_participant',{p_participant_id:id});
  if(error)throw error;
}
