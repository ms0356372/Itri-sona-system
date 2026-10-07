import {requireSupabase} from '../../lib/supabase';
import type {RoomState} from '../../types';
import {getRoomCount,getRoomIds,isRoomEnabled,isRoomStatus,normalizeRoomId} from './status';
import {getDeviceIdentity} from './device';

type RoomRow={session_id:string;room_id:string;status:unknown;updated_at:string};

function mapRoom(row:RoomRow,sessionId:string):RoomState{
  if(!row||row.session_id!==sessionId||typeof row.room_id!=='string'||!isRoomStatus(row.status))throw new Error('invalid_room_state');
  return{sessionId:row.session_id,roomId:normalizeRoomId(row.room_id),status:row.status,updatedAt:row.updated_at};
}

export async function getSessionRoomCount(sessionId:string):Promise<number>{
  const{data,error}=await requireSupabase().from('health_sessions').select('room_count').eq('id',sessionId).single();
  if(error)throw error;
  if(!data)throw new Error('invalid_session');
  return getRoomCount(data.room_count);
}

export async function listRooms(sessionId:string,roomCount?:number|null):Promise<RoomState[]>{
  const client=requireSupabase();
  const count=roomCount===undefined?await getSessionRoomCount(sessionId):getRoomCount(roomCount);
  const{data,error}=await client.from('rooms').select('session_id,room_id,status,updated_at').eq('session_id',sessionId).order('room_id');
  if(error)throw error;
  if(!Array.isArray(data))throw new Error('invalid_room_state');
  const stored=(data as RoomRow[]).map(row=>mapRoom(row,sessionId)).filter(room=>isRoomEnabled(room.roomId,count));
  // Only a successful cloud read can establish an absent legacy room's initial idle status.
  // Initialization and count changes are database transactions, never a frontend status reset.
  const byId=new Map<string,RoomState>();
  const priority={idle:0,in_progress:1,away:2};
  for(const room of stored){
    const previous=byId.get(room.roomId);
    // Legacy aliases must never make an occupied or away room appear available.
    if(!previous||priority[room.status]>priority[previous.status])byId.set(room.roomId,room);
  }
  return getRoomIds(count).map(roomId=>byId.get(roomId)??{sessionId,roomId,status:'idle' as const,updatedAt:null});
}

export async function setRoomAway(sessionId:string,roomId:string,away:boolean):Promise<RoomState>{
  const{deviceId,claimSecret}=getDeviceIdentity();
  const{data,error}=await requireSupabase().rpc('set_room_away',{p_session_id:sessionId,p_room_id:normalizeRoomId(roomId),p_away:away,p_device_id:deviceId,p_device_secret:claimSecret});
  if(error)throw error;
  return mapRoom(data as RoomRow,sessionId);
}
