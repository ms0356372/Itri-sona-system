import {requireSupabase} from '../../lib/supabase';
import type {RoomState} from '../../types';
import {isRoomStatus,roomIds} from './status';

type RoomRow={session_id:string;room_id:string;status:unknown;updated_at:string};

function mapRoom(row:RoomRow,sessionId:string):RoomState{
  if(!row||row.session_id!==sessionId||typeof row.room_id!=='string'||!isRoomStatus(row.status))throw new Error('invalid_room_state');
  return{sessionId:row.session_id,roomId:row.room_id,status:row.status,updatedAt:row.updated_at};
}

export async function listRooms(sessionId:string):Promise<RoomState[]>{
  const{data,error}=await requireSupabase().from('rooms').select('session_id,room_id,status,updated_at').eq('session_id',sessionId).order('room_id');
  if(error)throw error;
  if(!Array.isArray(data))throw new Error('invalid_room_state');
  const stored=(data as RoomRow[]).map(row=>mapRoom(row,sessionId));
  // A room is created on its first operation; only a successful cloud read can establish its initial idle status.
  const byId=new Map(stored.map(room=>[room.roomId,room]));
  return[...roomIds.map(roomId=>byId.get(roomId)??{sessionId,roomId,status:'idle' as const,updatedAt:null}),...stored.filter(room=>!roomIds.some(roomId=>roomId===room.roomId))];
}

export async function setRoomAway(sessionId:string,roomId:string,away:boolean):Promise<RoomState>{
  const{data,error}=await requireSupabase().rpc('set_room_away',{p_session_id:sessionId,p_room_id:roomId,p_away:away});
  if(error)throw error;
  return mapRoom(data as RoomRow,sessionId);
}
