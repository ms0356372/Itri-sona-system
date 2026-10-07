import {RoomStatusBadge} from './RoomStatusBadge';
import {roomIds} from './status';
import {useRoomStates} from './useRoomStates';

export function RoomStatusOverview({sessionId}:{sessionId:string}){
  const{rooms,loading,error,refresh}=useRoomStates(sessionId);
  return <div className="mb-4 rounded-xl border border-slate-200 bg-white px-4 py-3"><div className="flex flex-wrap items-center gap-x-5 gap-y-2"><b className="text-sm text-slate-700">超音波診間狀態</b><div role="group" aria-label="超音波診間狀態" className="flex flex-wrap gap-x-4 gap-y-2">{roomIds.map(roomId=><span key={roomId} className="inline-flex items-center gap-2 text-sm font-bold"><span>{roomId}</span><RoomStatusBadge status={error?null:rooms.find(room=>room.roomId===roomId)?.status} loading={loading}/></span>)}</div></div>{error&&<p role="alert" className="mt-2 text-sm text-red-700">{error}<button type="button" disabled={loading} className="ml-2 font-bold underline" onClick={()=>void refresh().catch(()=>{})}>重試</button></p>}</div>;
}
