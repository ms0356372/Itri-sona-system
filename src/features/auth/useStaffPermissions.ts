import {useCallback,useEffect,useId,useRef,useState} from 'react';
import {requireSupabase} from '../../lib/supabase';
import type {StaffPermissions} from '../../types';
import {getAllowedPages,getStaffPermissions} from './permissions';

type Snapshot={userId:string|null;permissions:StaffPermissions|null;loading:boolean;error:string};
export type StaffPermissionState={
  permissions:StaffPermissions|null;
  loading:boolean;
  error:string;
  ready:boolean;
  refresh:()=>Promise<void>;
};
const readError='無法確認此帳號的系統權限，請檢查網路後重試。';
const syncError='帳號權限同步中斷，請重新連線後重試。';

export function useStaffPermissions(authUserId:string|null):StaffPermissionState{
  const channelId=useId();
  const activeUser=useRef(authUserId);
  activeUser.current=authUserId;
  const request=useRef(0);
  const mounted=useRef(false);
  const syncUnavailable=useRef(false);
  const [snapshot,setSnapshot]=useState<Snapshot>({userId:authUserId,permissions:null,loading:Boolean(authUserId),error:''});

  const refresh=useCallback(async():Promise<void>=>{
    if(!mounted.current||activeUser.current!==authUserId)return;
    const generation=++request.current;
    if(!authUserId){setSnapshot({userId:null,permissions:null,loading:false,error:''});return;}
    // Suspend access before checking the database; cached grants never authorize a refresh.
    setSnapshot({userId:authUserId,permissions:null,loading:true,error:''});
    try{
      const permissions=await getStaffPermissions(authUserId);
      if(!mounted.current||activeUser.current!==authUserId||generation!==request.current)return;
      if(syncUnavailable.current){setSnapshot({userId:authUserId,permissions:null,loading:false,error:syncError});return;}
      setSnapshot({userId:authUserId,permissions,loading:false,error:''});
    }catch{
      if(mounted.current&&activeUser.current===authUserId&&generation===request.current)
        setSnapshot({userId:authUserId,permissions:null,loading:false,error:syncUnavailable.current?syncError:readError});
    }
  },[authUserId]);

  useEffect(()=>{
    mounted.current=true;
    syncUnavailable.current=false;
    let active=true;
    const invalidate=()=>{request.current++;};
    const reload=()=>{if(active)void refresh();};
    const unavailable=()=>{
      if(!active)return;
      syncUnavailable.current=true;
      invalidate();
      setSnapshot({userId:authUserId,permissions:null,loading:false,error:syncError});
    };
    reload();
    if(!authUserId)return()=>{active=false;mounted.current=false;invalidate();};
    let unsubscribe=()=>{};
    try{
      const client=requireSupabase();
      const channel=client.channel(`staff-permissions:${authUserId}:${channelId}`)
        .on('postgres_changes',{event:'*',schema:'public',table:'staff_permissions',filter:`user_id=eq.${authUserId}`},()=>{
          // Realtime payloads only invalidate. A grant must always come from an authenticated DB read.
          reload();
        })
        .subscribe(status=>{
          if(!active)return;
          if(status==='SUBSCRIBED'){syncUnavailable.current=false;reload();}
          else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'||status==='CLOSED')unavailable();
        });
      unsubscribe=()=>{void client.removeChannel(channel);};
    }catch{unavailable();}
    const visible=()=>{if(document.visibilityState==='visible')reload();};
    window.addEventListener('focus',reload);
    window.addEventListener('online',reload);
    window.addEventListener('offline',unavailable);
    document.addEventListener('visibilitychange',visible);
    return()=>{
      active=false;mounted.current=false;invalidate();
      unsubscribe();
      window.removeEventListener('focus',reload);
      window.removeEventListener('online',reload);
      window.removeEventListener('offline',unavailable);
      document.removeEventListener('visibilitychange',visible);
    };
  },[authUserId,channelId,refresh]);

  // Mask the previous account synchronously, before effects run on an account switch.
  const current=snapshot.userId===authUserId?snapshot:{userId:authUserId,permissions:null,loading:Boolean(authUserId),error:''};
  const permissions=current.loading||current.error?null:current.permissions;
  return{permissions,loading:current.loading,error:current.error,
    ready:Boolean(authUserId)&&!current.loading&&!current.error&&getAllowedPages(permissions).length>0,refresh};
}
