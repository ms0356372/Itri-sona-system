import {useCallback,useEffect,useId,useRef,useState} from 'react';
import {requireSupabase} from '../../lib/supabase';
import {formatError} from '../../lib/errors';
import type {RoomState} from '../../types';
import {createRefreshCoalescer,type RefreshCoalescer} from '../sync/refresh';
import {getSessionRoomCount,listRooms} from './service';
import {getRoomCount,isRoomEnabled,isRoomStatus,isValidRoomCount,normalizeRoomId} from './status';

type Snapshot={sessionId:string|null;roomCount:number;rooms:RoomState[];loading:boolean;error:string};
type RoomStates={rooms:RoomState[];loading:boolean;error:string;roomCount?:number;refresh:()=>Promise<void>;acceptRoom:(room:RoomState)=>void};
type RoomPayload={eventType?:string;new?:Record<string,unknown>;old?:Record<string,unknown>};
type Patch={room:RoomState;revision:number};
const readError='無法確認診間狀態，請檢查網路後重試。';
const syncError='診間狀態同步中斷，請重新連線後重試。';
const sameRoom=(left:RoomState,right:RoomState)=>left.sessionId===right.sessionId&&left.roomId===right.roomId&&left.status===right.status&&left.updatedAt===right.updatedAt;
const sameRooms=(left:RoomState[],right:RoomState[])=>left.length===right.length&&left.every((room,index)=>sameRoom(room,right[index]));
const timestamp=(room:RoomState)=>room.updatedAt===null?Number.NEGATIVE_INFINITY:Date.parse(room.updatedAt);

export function useRoomStates(sessionId:string|null|undefined,roomCount?:number|null):RoomStates{
  const id=sessionId??null;
  const suppliedCount=getRoomCount(roomCount);
  const channelId=useId();
  const activeSession=useRef(id);
  const countSession=useRef(id);
  const count=useRef(suppliedCount);
  const input=useRef({id,roomCount});
  const previousInput=useRef({id,roomCount});
  input.current={id,roomCount};
  activeSession.current=id;
  if(countSession.current!==id){countSession.current=id;count.current=suppliedCount;}
  const request=useRef(0);
  const countRevision=useRef(0);
  const patchRevision=useRef(0);
  const patches=useRef(new Map<string,Patch>());
  const hydrated=useRef(false);
  const mounted=useRef(false);
  const syncUnavailable=useRef(false);
  const controller=useRef<{sessionId:string|null;coalescer:RefreshCoalescer}|null>(null);
  const[snapshot,setSnapshot]=useState<Snapshot>({sessionId:id,roomCount:suppliedCount,rooms:[],loading:Boolean(id),error:''});
  const latest=useRef(snapshot);

  const commit=useCallback((next:Snapshot)=>{
    const previous=latest.current;
    if(previous.sessionId===next.sessionId&&previous.roomCount===next.roomCount&&previous.loading===next.loading&&previous.error===next.error&&sameRooms(previous.rooms,next.rooms))return;
    latest.current=next;
    setSnapshot(next);
  },[]);

  const load=useCallback(async():Promise<void>=>{
    if(!mounted.current||activeSession.current!==id)return;
    const generation=++request.current;
    if(!id){commit({sessionId:null,roomCount:count.current,rooms:[],loading:false,error:''});return;}
    const before=latest.current;
    const startedPatches=patchRevision.current;
    const startedCount=countRevision.current;
    commit({sessionId:id,roomCount:count.current,rooms:before.sessionId===id?before.rooms.filter(room=>isRoomEnabled(room.roomId,count.current)):[],loading:true,error:syncUnavailable.current?syncError:''});
    try{
      // Count reads remain mandatory for recovery: suspended tablets can miss a
      // count decrease. A newer count event must not be overwritten by this read.
      const requestedCount=await getSessionRoomCount(id);
      if(!mounted.current||activeSession.current!==id||generation!==request.current)return;
      if(startedCount===countRevision.current)count.current=requestedCount;
      const rooms=await listRooms(id,count.current);
      if(!mounted.current||activeSession.current!==id||generation!==request.current)return;
      if(syncUnavailable.current)throw new Error('room_sync_disconnected');
      const currentCount=count.current;
      const merged=new Map(rooms.filter(room=>isRoomEnabled(room.roomId,currentCount)).map(room=>[room.roomId,room]));
      // Keep action/Realtime changes received during the read without discarding
      // the other rooms fetched by it. A later refresh still trusts cloud data.
      for(const{room,revision}of patches.current.values()){
        if(revision<=startedPatches||!isRoomEnabled(room.roomId,currentCount))continue;
        const stored=merged.get(room.roomId);
        if(!stored||!Number.isFinite(timestamp(stored))||timestamp(room)>=timestamp(stored))merged.set(room.roomId,room);
      }
      hydrated.current=true;
      commit({sessionId:id,roomCount:currentCount,rooms:[...merged.values()],loading:false,error:''});
    }catch(error){
      const detail=formatError(error);
      const message=detail==='此帳號沒有執行此功能的權限。'?detail:syncUnavailable.current?syncError:readError;
      if(mounted.current&&activeSession.current===id&&generation===request.current)commit({sessionId:id,roomCount:count.current,rooms:[],loading:false,error:message});
      throw error;
    }
  },[id,commit]);

  const refresh=useCallback(():Promise<void>=>{
    // An action finishing in an old workspace cannot invalidate the new scope.
    if(!mounted.current||activeSession.current!==id||controller.current?.sessionId!==id)return Promise.resolve();
    return controller.current.coalescer.refresh(true);
  },[id]);

  const acceptRoom=useCallback((value:RoomState):void=>{
    if(!mounted.current||activeSession.current!==id||value.sessionId!==id||!isRoomStatus(value.status)||!isRoomEnabled(value.roomId,count.current))return;
    const room={...value,roomId:normalizeRoomId(value.roomId)};
    const previous=latest.current;
    const rooms=previous.sessionId===id?previous.rooms:[];
    const stored=rooms.find(candidate=>candidate.roomId===room.roomId);
    if(stored&&(sameRoom(stored,room)||timestamp(room)<timestamp(stored)))return;
    patches.current.set(room.roomId,{room,revision:++patchRevision.current});
    commit({sessionId:id,roomCount:count.current,rooms:stored?rooms.map(candidate=>candidate.roomId===room.roomId?room:candidate):[...rooms,room],loading:!hydrated.current&&previous.loading,error:syncUnavailable.current?syncError:previous.sessionId===id?previous.error:''});
  },[id,commit]);

  useEffect(()=>{
    mounted.current=true;
    syncUnavailable.current=false;
    request.current++;
    hydrated.current=false;
    patchRevision.current=0;patches.current.clear();countRevision.current=0;
    previousInput.current={id,roomCount:input.current.roomCount};
    // Create on effect setup so React StrictMode's setup/cleanup/setup cycle
    // never reuses a disposed controller.
    const coalescer=createRefreshCoalescer(load);
    controller.current={sessionId:id,coalescer};
    let active=true;
    const invalidateRequest=()=>{request.current++;};
    const reload=(invalidate=false)=>{if(active)void coalescer.schedule(invalidate).catch(()=>{});};
    const unavailable=(message:string)=>{
      if(!active)return;
      syncUnavailable.current=true;invalidateRequest();
      commit({sessionId:id,roomCount:count.current,rooms:[],loading:false,error:message});
    };
    void coalescer.refresh().catch(()=>{});
    if(!id)return()=>{active=false;mounted.current=false;invalidateRequest();coalescer.dispose();};
    let unsubscribe=()=>{};
    try{
      const client=requireSupabase();
      const channel=client.channel(`room-states:${id}:${channelId}`)
        .on('postgres_changes',{event:'*',schema:'public',table:'health_sessions',filter:`id=eq.${id}`},payload=>{
          if(!active)return;
          const next=payload.new as Record<string,unknown>|undefined;
          if(payload.eventType==='DELETE'){
            const old=payload.old as Record<string,unknown>|undefined;
            if(old?.id===id)unavailable(readError);
            else if(old?.id===undefined)reload(true);
            return;
          }
          if(next?.id!==undefined&&next.id!==id)return;
          if(!next||!('room_count'in next)){reload(true);return;}
          const nextCount=next.room_count;
          if(nextCount!==null&&!isValidRoomCount(nextCount)){unavailable(readError);return;}
          const enabledCount=getRoomCount(nextCount as number|null);
          if(enabledCount===count.current)return;
          count.current=enabledCount;countRevision.current++;
          const previous=latest.current;
          commit({...previous,roomCount:enabledCount,rooms:previous.rooms.filter(room=>isRoomEnabled(room.roomId,enabledCount))});
          reload(true);
        })
        .on('postgres_changes',{event:'*',schema:'public',table:'rooms',filter:`session_id=eq.${id}`},(payload:RoomPayload)=>{
          if(!active)return;
          const row=payload?.eventType==='DELETE'?payload.old:payload?.new;
          if(row?.session_id!==undefined&&row.session_id!==id)return;
          if(payload?.eventType==='DELETE'){reload(true);return;}
          if(!row||row.session_id!==id||typeof row.room_id!=='string'||!isRoomStatus(row.status)||typeof row.updated_at!=='string'||!Number.isFinite(Date.parse(row.updated_at))){reload(true);return;}
          if(!isRoomEnabled(row.room_id,count.current))return;
          // The row is authoritative even for a heartbeat: it can repair a
          // missed status event. acceptRoom makes an unchanged local row a no-op.
          const recover=Boolean(latest.current.error)&&!syncUnavailable.current;
          acceptRoom({sessionId:id,roomId:row.room_id,status:row.status,updatedAt:row.updated_at});
          // A healthy channel can recover a failed REST snapshot. The single
          // row alone must not clear its error or establish the other rooms.
          if(recover)reload(true);
        })
        .subscribe(status=>{
          if(!active)return;
          if(status==='SUBSCRIBED'){
            const recovering=syncUnavailable.current;
            syncUnavailable.current=false;reload(recovering);
          }
          else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'||status==='CLOSED')unavailable(syncError);
        });
      unsubscribe=()=>{void client.removeChannel(channel);};
    }catch{unavailable(syncError);}
    const onFocus=()=>reload(syncUnavailable.current);
    const onVisibility=()=>{if(document.visibilityState==='visible')reload(syncUnavailable.current);};
    const onOffline=()=>unavailable(syncError);
    window.addEventListener('focus',onFocus);
    window.addEventListener('online',onFocus);
    window.addEventListener('offline',onOffline);
    document.addEventListener('visibilitychange',onVisibility);
    return()=>{
      active=false;mounted.current=false;invalidateRequest();coalescer.dispose();
      unsubscribe();
      window.removeEventListener('focus',onFocus);
      window.removeEventListener('online',onFocus);
      window.removeEventListener('offline',onOffline);
      document.removeEventListener('visibilitychange',onVisibility);
    };
  },[id,channelId,load,acceptRoom,commit]);

  useEffect(()=>{
    const changed=previousInput.current.id===id&&previousInput.current.roomCount!==roomCount;
    previousInput.current={id,roomCount};
    if(!changed||!id||count.current===suppliedCount||controller.current?.sessionId!==id)return;
    count.current=suppliedCount;countRevision.current++;
    const previous=latest.current;
    commit({...previous,roomCount:suppliedCount,rooms:previous.rooms.filter(room=>isRoomEnabled(room.roomId,suppliedCount))});
    void controller.current.coalescer.schedule().catch(()=>{});
  },[id,roomCount,suppliedCount,commit]);

  const current=snapshot.sessionId===id?snapshot:{sessionId:id,roomCount:count.current,rooms:[],loading:Boolean(id),error:''};
  return{rooms:current.rooms.filter(room=>isRoomEnabled(room.roomId,count.current)),roomCount:count.current,loading:current.loading,error:current.error,refresh,acceptRoom};
}
