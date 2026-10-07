import {useCallback,useEffect,useId,useRef,useState} from 'react';
import {requireSupabase} from '../../lib/supabase';
import type {RoomState} from '../../types';
import {listRooms} from './service';
import {isRoomStatus} from './status';

type Snapshot={sessionId:string|null;rooms:RoomState[];loading:boolean;error:string};
const readError='無法確認診間狀態，請檢查網路後重試。';
const syncError='診間狀態同步中斷，請重新連線後重試。';

export function useRoomStates(sessionId:string|null|undefined){
  const id=sessionId??null;
  const channelId=useId();
  const activeSession=useRef(id);
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
    setSnapshot(previous=>({sessionId:id,rooms:previous.sessionId===id?previous.rooms:[],loading:true,error:syncUnavailable.current?syncError:''}));
    try{
      const rooms=await listRooms(id);
      if(syncUnavailable.current&&activeSession.current===id)throw new Error('room_sync_disconnected');
      if(mounted.current&&activeSession.current===id&&generation===request.current)setSnapshot({sessionId:id,rooms,loading:false,error:''});
    }catch(error){
      if(mounted.current&&activeSession.current===id&&generation===request.current)setSnapshot({sessionId:id,rooms:[],loading:false,error:syncUnavailable.current?syncError:readError});
      throw error;
    }
  },[id]);

  const acceptRoom=useCallback((room:RoomState):void=>{
    if(!mounted.current||activeSession.current!==id||room.sessionId!==id||!isRoomStatus(room.status))return;
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
  },[id,channelId,refresh]);

  const current=snapshot.sessionId===id?snapshot:{sessionId:id,rooms:[],loading:Boolean(id),error:''};
  return{rooms:current.rooms,loading:current.loading,error:current.error,refresh,acceptRoom};
}
