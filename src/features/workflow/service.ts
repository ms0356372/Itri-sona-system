import {requireSupabase} from '../../lib/supabase';

export async function getStandardWaitingQueue(sessionId:string):Promise<ReadonlyMap<string,number>>{
  const {data,error}=await requireSupabase().rpc('get_standard_waiting_queue',{p_session_id:sessionId});
  if(error)throw error;
  if(!Array.isArray(data))throw new Error('invalid_standard_waiting_queue');
  const queue=new Map<string,number>();
  const positions=new Set<number>();
  for(const row of data as unknown[]){
    if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('invalid_standard_waiting_queue');
    const {participant_id:id,queue_position:position}=row as Record<string,unknown>;
    if(typeof id!=='string'||!id||id.trim()!==id||typeof position!=='number'||!Number.isSafeInteger(position)||position<1||position>data.length||queue.has(id)||positions.has(position))throw new Error('invalid_standard_waiting_queue');
    queue.set(id,position);
    positions.add(position);
  }
  return queue;
}
