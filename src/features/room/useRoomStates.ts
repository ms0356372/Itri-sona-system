import {useCallback,useEffect,useId,useRef,useState} from 'react';
import {requireSupabase} from '../../lib/supabase';
import {formatError} from '../../lib/errors';
import type {RoomState} from '../../types';
import {getSessionRoomCount,listRooms} from './service';
import {getRoomCount,isRoomEnabled,isRoomStatus,isValidRoomCount,normalizeRoomId} from './status';

type Snapshot={sessionId:string|null;rooms:RoomState[];loading:boolean;error:string};
type RoomStates={rooms:RoomState[];loading:boolean;error:string;roomCount?:number;refresh:()=>Promise<void>;acceptRoom:(room:RoomState)=>void};
const readError='無法確認診間狀態，請檢查網路後重試。';
const syncError='診間狀態同步中斷，請重新連線後重試。';

export function useRoomStates(sessionId:string|null|undefined,roomCount?:number|null):RoomStates{
  const id=sessionId??null;
  const suppliedCount=getRoomCount(roomCount);
  const channelId=useId();
  const activeSession=useRef(id);
  const count=useRef(suppliedCount);
  const previousInput=useRef({id,roomCount});
  if(previousInput.current.id!==id||previousInput.current.roomCount!==roomCount){
    count.current=suppliedCount;
    previousInput.current={id,roomCount};
  }
  const request=useRef(0);
  const mounted=useRef(false);
  const syncUnavailable=useRef(false);
  const[snapshot,setSnapshot]=useState<Snapshot>({sessionId:id,rooms:[],loading:Boolean(id),error:''});
  activeSession.current=id;

  const refresh=useCallback(async():Promise<void>=>{
    // An action finishing after a room/session switch must not invalidate the new session's request.
    if(!mounted.current||activeSession.current!==id)return;
    const generation=++request.current;
    if(!id){if(mounted.current)setSnapshot({sessionId:null,rooms:[],loading:false,error:''});return;}
    setSnapshot(previous=>({sessionId:id,rooms:previous.sessionId===id?previous.rooms.filter(room=>isRoomEnabled(room.roomId,count.current)):[],loading:true,error:syncUnavailable.current?syncError:''}));
    try{
      // Re-read the persisted count on every refresh, including focus and reconnect.
      // A tablet can miss a session event while suspended or disconnected.
      const requestedCount=await getSessionRoomCount(id);
      if(!mounted.current||activeSession.current!==id||generation!==request.current)return;
      count.current=requestedCount;
      const rooms=(await listRooms(id,requestedCount)).filter(room=>isRoomEnabled(room.roomId,requestedCount));
      if(syncUnavailable.current&&activeSession.current===id)throw new Error('room_sync_disconnected');
      if(mounted.current&&activeSession.current===id&&generation===request.current)setSnapshot({sessionId:id,rooms,loading:false,error:''});
    }catch(error){
      const detail=formatError(error);
      const message=detail==='此帳號沒有執行此功能的權限。'?detail:syncUnavailable.current?syncError:readError;
      if(mounted.current&&activeSession.current===id&&generation===request.current)setSnapshot({sessionId:id,rooms:[],loading:false,error:message});
      throw error;
    }
  },[id]);

  const acceptRoom=useCallback((room:RoomState):void=>{
    if(!mounted.current||activeSession.current!==id||room.sessionId!==id||!isRoomStatus(room.status)||!isRoomEnabled(room.roomId,count.current))return;
    room={...room,roomId:normalizeRoomId(room.roomId)};
    request.current++;
    setSnapshot(previous=>{
      const rooms=previous.sessionId===id?previous.rooms:[];
      return{sessionId:id,rooms:rooms.some(value=>value.roomId===room.roomId)?rooms.map(value=>value.roomId===room.roomId?room:value):[...rooms,room],loading:false,error:syncUnavailable.current?syncError:previous.sessionId===id?previous.error:''};
    });
  },[id]);

  useEffect(()=>{
    mounted.current=true;
    syncUnavailable.current=false;
    let active=true;
    const invalidateRequest=()=>{request.current++;};
    const reload=()=>{if(active)void refresh().catch(()=>{});};
    const unavailable=(message:string)=>{
      if(!active)return;
      syncUnavailable.current=true;
      invalidateRequest();
      setSnapshot({sessionId:id,rooms:[],loading:false,error:message});
    };
    reload();
    if(!id)return()=>{active=false;mounted.current=false;invalidateRequest();};
    let unsubscribe=()=>{};
    try{
      const client=requireSupabase();
      const channel=client.channel(`room-states:${id}:${channelId}`)
        .on('postgres_changes',{event:'*',schema:'public',table:'health_sessions',filter:`id=eq.${id}`},payload=>{
          if(!active)return;
          if(payload.eventType==='DELETE'){unavailable(readError);return;}
          const next=payload.new as {room_count?:number|null};
          if(next.room_count!==undefined){
            if(next.room_count!==null&&!isValidRoomCount(next.room_count)){unavailable(readError);return;}
            count.current=getRoomCount(next.room_count);
          }
          reload();
        })
        .on('postgres_changes',{event:'*',schema:'public',table:'rooms',filter:`session_id=eq.${id}`},reload)
        .subscribe(status=>{
          if(!active)return;
          if(status==='SUBSCRIBED'){syncUnavailable.current=false;reload();}
          else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'||status==='CLOSED')unavailable(syncError);
        });
      unsubscribe=()=>{void client.removeChannel(channel);};
    }catch{unavailable(syncError);}
    const onVisibility=()=>{if(document.visibilityState==='visible')reload();};
    const onOffline=()=>unavailable(syncError);
    window.addEventListener('focus',reload);
    window.addEventListener('online',reload);
    window.addEventListener('offline',onOffline);
    document.addEventListener('visibilitychange',onVisibility);
    return()=>{
      active=false;mounted.current=false;invalidateRequest();
      unsubscribe();
      window.removeEventListener('focus',reload);
      window.removeEventListener('online',reload);
      window.removeEventListener('offline',onOffline);
      document.removeEventListener('visibilitychange',onVisibility);
    };
  },[id,suppliedCount,channelId,refresh]);

  const current=snapshot.sessionId===id?snapshot:{sessionId:id,rooms:[],loading:Boolean(id),error:''};
  return{rooms:current.rooms.filter(room=>isRoomEnabled(room.roomId,count.current)),roomCount:count.current,loading:current.loading,error:current.error,refresh,acceptRoom};
}
