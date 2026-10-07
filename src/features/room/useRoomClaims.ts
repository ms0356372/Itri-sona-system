import {useCallback,useEffect,useId,useRef,useState} from 'react';
import {requireSupabase} from '../../lib/supabase';
import {ROOM_CLAIM_HEARTBEAT_SECONDS,ROOM_CLAIM_REFRESH_SECONDS,ROOM_CLAIM_RELEASE_WAIT_MS,ROOM_CLAIM_TTL_SECONDS} from './claimConfig';
import {claimRoom,formatRoomClaimError,getRoomClaims,heartbeatRoomClaim,isRoomClaimDenied,releaseRoomClaim,switchRoomClaim,type RoomClaim} from './claims';
import {getRoomCount,getRoomIds,isRoomEnabled,normalizeRoomId} from './status';
import {getDeviceIdentity} from './device';
import {createRefreshCoalescer,type RefreshCoalescer} from '../sync/refresh';

export type RoomClaimState={
  roomId:string|null;claims:RoomClaim[];isOwned:boolean;claimConfirmed:boolean;
  loading:boolean;busy:boolean;error:string;warning:string;allOccupied:boolean;
  selectRoom:(roomId:string)=>Promise<boolean>;refresh:()=>Promise<void>;
  release:()=>Promise<boolean>;revoke:()=>void;
};
type Snapshot={sessionId:string|null;claim:RoomClaim|null;claims:RoomClaim[];loading:boolean;busy:boolean;error:string;warning:string};
type Scope={sessionId:string;token:symbol;active:boolean;eventVersion:number;initialized:boolean;refresh?:RefreshCoalescer;heartbeat?:RefreshCoalescer;mutationRooms:Set<string>};
type ClaimEvent={eventType?:string;new?:Record<string,unknown>;old?:Record<string,unknown>};
const claimFields=['claimed_by_device_id','claimed_by_user_id','claimed_at','claim_expires_at'] as const;
// Serialize each device's lifecycle in this browser, including delayed unmount cleanup.
// A superseded component may never release a newer component's confirmed claim.
const owners=new Map<string,symbol>();
const queues=new Map<string,Promise<void>>();
function enqueue<T>(scope:Scope,run:()=>Promise<T>,allowInactive=false):Promise<T|undefined>{
  const previous=queues.get(scope.sessionId)??Promise.resolve();
  const operation=previous.catch(()=>{}).then(()=>{
    if(owners.get(scope.sessionId)!==scope.token||!scope.active&&!allowInactive)return undefined;
    return run();
  });
  const settled=operation.then(()=>{},()=>{});
  queues.set(scope.sessionId,settled);
  void settled.then(()=>{if(queues.get(scope.sessionId)===settled)queues.delete(scope.sessionId);});
  return operation;
}

const empty=(sessionId:string|null,loading=false):Snapshot=>({sessionId,claim:null,claims:[],loading,busy:false,error:'',warning:''});
const lostMessage='本機已失去此診間的使用權，請重新選擇診間。';
const networkWarning='診間連線暫時異常，系統將自動重試。';

export function useRoomClaims(sessionId:string|null,roomCount?:number|null,preferredRoomId?:string|null):RoomClaimState{
  const channelId=useId();
  const count=getRoomCount(roomCount);
  const inputs=useRef({sessionId,count,preferredRoomId});inputs.current={sessionId,count,preferredRoomId};
  const scopeRef=useRef<Scope|null>(null);
  const lease=useRef<RoomClaim|null>(null);
  const deadline=useRef(0);
  const expiryTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const revision=useRef(0);
  const restoreBlocked=useRef(false);
  const busyRef=useRef(false);
  const refreshLatest=useRef<()=>Promise<void>>(()=>Promise.resolve());
  const [snapshot,setSnapshot]=useState<Snapshot>(()=>empty(sessionId,Boolean(sessionId)));
  const isCurrent=useCallback((scope:Scope)=>scope.active&&scopeRef.current===scope&&inputs.current.sessionId===scope.sessionId&&owners.get(scope.sessionId)===scope.token,[]);

  const clearLease=useCallback((message=lostMessage)=>{
    lease.current=null;deadline.current=0;revision.current++;
    if(expiryTimer.current!==null){clearTimeout(expiryTimer.current);expiryTimer.current=null;}
    const scope=scopeRef.current;
    if(scope&&isCurrent(scope))setSnapshot(previous=>({...previous,claim:null,claims:previous.claims.map(claim=>claim.isMine?{...claim,isMine:false}:claim),loading:false,error:message,warning:''}));
  },[isCurrent]);

  const confirm=useCallback((scope:Scope,claim:RoomClaim,startedAt:number):boolean=>{
    if(!isCurrent(scope))return false;
    if(!claim.isMine||!claim.isClaimed||!claim.claimExpiresAt||!isRoomEnabled(claim.roomId,inputs.current.count)){clearLease();return false;}
    // Use server time and a monotonic local clock; a tablet's clock cannot extend its lease.
    const remaining=Math.min(ROOM_CLAIM_TTL_SECONDS*1000,Date.parse(claim.claimExpiresAt)-Date.parse(claim.serverNow));
    const due=startedAt+Math.max(0,remaining);
    if(due<=performance.now()){clearLease();return false;}
    lease.current=claim;deadline.current=due;
    setSnapshot(previous=>({...previous,sessionId:scope.sessionId,claim,
      claims:[...previous.claims.filter(value=>value.roomId!==claim.roomId).map(value=>value.isMine?{...value,isMine:false,isClaimed:false,claimedAt:null,claimExpiresAt:null}:value),claim],
      loading:false,error:'',warning:''}));
    if(expiryTimer.current!==null)clearTimeout(expiryTimer.current);
    expiryTimer.current=setTimeout(()=>{
      if(isCurrent(scope)&&deadline.current===due&&performance.now()>=due){
        clearLease('診間使用權已逾時，請重新選擇診間。');
        void refreshLatest.current();
      }
    },Math.max(0,due-performance.now()));
    return true;
  },[clearLease,isCurrent]);

  const failure=useCallback((scope:Scope,error:unknown)=>{
    if(!isCurrent(scope))return;
    if(isRoomClaimDenied(error)){restoreBlocked.current=true;clearLease(formatRoomClaimError(error));return;}
    if(lease.current&&deadline.current>performance.now())setSnapshot(previous=>({...previous,loading:false,warning:networkWarning}));
    else setSnapshot(previous=>({...previous,loading:false,error:formatRoomClaimError(error),warning:''}));
  },[clearLease,isCurrent]);

  const refresh=useCallback(():Promise<void>=>{
    const scope=scopeRef.current;
    return scope&&isCurrent(scope)?scope.refresh?.refresh()??Promise.resolve():Promise.resolve();
  },[isCurrent]);
  refreshLatest.current=()=>{
    const scope=scopeRef.current;
    return scope&&isCurrent(scope)?scope.refresh?.refresh(true)??Promise.resolve():Promise.resolve();
  };

  const runHeartbeat=useCallback(async(scope:Scope):Promise<void>=>{
    if(!isCurrent(scope))return;
    try{
      await enqueue(scope,async()=>{
        const current=lease.current;
        if(!current)return;
        const version=revision.current;const started=performance.now();
        const claim=await heartbeatRoomClaim(scope.sessionId,current.roomId);
        if(isCurrent(scope)&&version===revision.current)confirm(scope,claim,started);
      });
    }catch(error){failure(scope,error);}
  },[confirm,failure,isCurrent]);

  const selectRoom=useCallback(async(requestedRoom:string):Promise<boolean>=>{
    const scope=scopeRef.current;const roomId=normalizeRoomId(requestedRoom);
    if(!scope||!isCurrent(scope)||busyRef.current)return false;
    if(!isRoomEnabled(roomId,inputs.current.count)){setSnapshot(previous=>({...previous,error:'此場次沒有這個診間。'}));return false;}
    busyRef.current=true;setSnapshot(previous=>({...previous,busy:true,error:''}));
    try{
      return await enqueue(scope,async()=>{
        const current=lease.current;const version=revision.current;const started=performance.now();
        scope.mutationRooms.add(roomId);if(current)scope.mutationRooms.add(current.roomId);
        let claim:RoomClaim;
        try{
          claim=current&&current.roomId!==roomId
            ?await switchRoomClaim(scope.sessionId,current.roomId,roomId)
            :await claimRoom(scope.sessionId,roomId);
        }finally{scope.mutationRooms.clear();}
        if(!isCurrent(scope)){
          // The component disappeared while acquisition was in flight. A newer scope owns cleanup.
          void enqueue(scope,()=>releaseRoomClaim(scope.sessionId,claim.roomId,claim.claimedAt),true).catch(()=>{});
          return false;
        }
        if(version!==revision.current){
          void enqueue(scope,()=>releaseRoomClaim(scope.sessionId,claim.roomId,claim.claimedAt),true).catch(()=>{});
          return false;
        }
        restoreBlocked.current=false;
        return confirm(scope,claim,started);
      })??false;
    }catch(error){
      if(isCurrent(scope)){
        // Atomic switch failure leaves the existing confirmed room available.
        if(isRoomClaimDenied(error)){restoreBlocked.current=true;clearLease(formatRoomClaimError(error));}
        else setSnapshot(previous=>({...previous,error:formatRoomClaimError(error)}));
      }
      return false;
    }finally{
      if(scopeRef.current===scope){busyRef.current=false;if(isCurrent(scope))setSnapshot(previous=>({...previous,busy:false}));}
    }
  },[clearLease,confirm,isCurrent]);

  const release=useCallback(async():Promise<boolean>=>{
    const scope=scopeRef.current;
    if(!scope||!isCurrent(scope)||busyRef.current)return false;
    busyRef.current=true;setSnapshot(previous=>({...previous,busy:true,error:''}));
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try{
      const operation=enqueue(scope,async()=>{
        const current=lease.current;if(!current)return true;
        scope.mutationRooms.add(current.roomId);
        try{await releaseRoomClaim(scope.sessionId,current.roomId,current.claimedAt);}
        finally{scope.mutationRooms.delete(current.roomId);}
        if(isCurrent(scope))clearLease('');
        return true;
      });
      // Bound logout/page-close waiting while preserving mutation ordering. A subsequent
      // acquisition stays behind the original request, so its late release cannot clear it.
      const result=await Promise.race([operation,new Promise<false>(resolve=>{
        timeout=setTimeout(()=>{
          if(isCurrent(scope))setSnapshot(previous=>({...previous,warning:'診間釋放尚未確認；若無法連線，使用權將於逾時後自動釋放。'}));
          resolve(false);
        },ROOM_CLAIM_RELEASE_WAIT_MS);
      })]);
      return result??false;
    }catch(error){
      if(isCurrent(scope)){
        if(isRoomClaimDenied(error)){restoreBlocked.current=true;clearLease(formatRoomClaimError(error));}
        else setSnapshot(previous=>({...previous,error:formatRoomClaimError(error)}));
      }
      return false;
    }
    finally{if(timeout!==undefined)clearTimeout(timeout);if(scopeRef.current===scope){busyRef.current=false;if(isCurrent(scope))setSnapshot(previous=>({...previous,busy:false}));}}
  },[clearLease,isCurrent]);

  useEffect(()=>{
    revision.current++;restoreBlocked.current=false;lease.current=null;deadline.current=0;busyRef.current=false;
    setSnapshot(empty(sessionId,Boolean(sessionId)));
    if(!sessionId){scopeRef.current=null;return;}
    const scope:Scope={sessionId,token:Symbol(sessionId),active:true,eventVersion:0,initialized:false,mutationRooms:new Set()};scopeRef.current=scope;owners.set(sessionId,scope.token);
    const invalidate=()=>{revision.current++;};
    const initialPreferred=inputs.current.preferredRoomId;
    const initialVersion=revision.current;
    busyRef.current=true;setSnapshot(previous=>({...previous,busy:true}));
    scope.refresh=createRefreshCoalescer(async()=>{
      const initializing=!scope.initialized;
      try{
        await enqueue(scope,async()=>{
          const version=revision.current;const eventVersion=scope.eventVersion;const startedRead=performance.now();
          const claims=(await getRoomClaims(sessionId)).filter(value=>isRoomEnabled(value.roomId,inputs.current.count));
          if(!isCurrent(scope)||version!==revision.current||eventVersion!==scope.eventVersion){
            if(initializing&&isCurrent(scope)&&initialVersion!==revision.current)scope.initialized=true;
            return;
          }
          setSnapshot(previous=>({...previous,claims,loading:false,warning:''}));
          const mine=claims.find(value=>value.isMine&&value.isClaimed);
          if(!initializing){
            if(mine&&!restoreBlocked.current)confirm(scope,mine,startedRead);
            else if(lease.current)clearLease();
            return;
          }
          scope.initialized=true;
          if(initialVersion!==revision.current)return;
          const preferred=initialPreferred&&isRoomEnabled(initialPreferred,inputs.current.count)?normalizeRoomId(initialPreferred):getRoomIds(inputs.current.count)[0];
          const target=mine?.roomId??preferred;
          if(!mine&&claims.some(value=>value.roomId===target&&value.isClaimed)){setSnapshot(previous=>({...previous,loading:false,error:'此診間目前正在其他設備使用中。'}));return;}
          scope.mutationRooms.add(target);
          const started=performance.now();let claim:RoomClaim;
          try{claim=await claimRoom(sessionId,target);}
          finally{scope.mutationRooms.delete(target);}
          if(isCurrent(scope)&&initialVersion===revision.current)confirm(scope,claim,started);
          else void enqueue(scope,()=>releaseRoomClaim(sessionId,claim.roomId,claim.claimedAt),true).catch(()=>{});
        });
      }catch(error){scope.initialized=true;failure(scope,error);}
      finally{
        if(initializing&&scope.initialized&&scopeRef.current===scope){busyRef.current=false;if(isCurrent(scope))setSnapshot(previous=>({...previous,loading:false,busy:false}));}
      }
    });
    scope.heartbeat=createRefreshCoalescer(()=>runHeartbeat(scope));
    void scope.refresh.refresh();
    const reload=()=>{if(isCurrent(scope))void scope.refresh?.schedule(false);};
    const renew=()=>{if(isCurrent(scope))void scope.heartbeat?.schedule(false);};
    const changed=(payload?:ClaimEvent)=>{
      if(!isCurrent(scope))return;
      const next=payload?.new;
      const scopedRow=payload?.eventType==='DELETE'?payload.old:next;
      if(scopedRow&&typeof scopedRow.session_id==='string'&&scopedRow.session_id!==sessionId)return;
      if(scopedRow&&typeof scopedRow.room_id==='string'&&!isRoomEnabled(scopedRow.room_id,inputs.current.count))return;
      if(next&&typeof next.session_id==='string'&&next.session_id!==sessionId)return;
      if(next&&typeof next.room_id==='string'){
        const roomId=normalizeRoomId(next.room_id);
        if(!isRoomEnabled(roomId,inputs.current.count))return;
        const old=payload?.old;
        // A complete payload proves that a room-status-only update did not change its lease.
        if(payload?.eventType==='UPDATE'&&old&&claimFields.every(field=>field in next&&field in old&&next[field]===old[field]))return;
        try{
          const {deviceId}=getDeviceIdentity();
          const mine=lease.current;
          // Our mutation's RPC response confirms its own lease. Its Realtime echo never
          // grants access or needs another list request for unrelated rooms.
          if(scope.mutationRooms.has(roomId)&&(next.claimed_by_device_id===deviceId||next.claimed_by_device_id===null))return;
          if(mine?.roomId===roomId&&next.claimed_by_device_id===deviceId&&next.claimed_at===mine.claimedAt&&typeof next.claim_expires_at==='string'
            &&mine.claimExpiresAt&&Date.parse(next.claim_expires_at)>=Date.parse(mine.claimExpiresAt))return;
        }catch{/* Unknown credentials cannot justify ignoring an ownership event. */}
      }
      scope.eventVersion++;void scope.refresh?.schedule();
    };
    let unsubscribe=()=>{};
    try{
      const client=requireSupabase();
      const channel=client.channel(`room-claims:${sessionId}:${channelId}`)
        .on('postgres_changes',{event:'*',schema:'public',table:'rooms',filter:`session_id=eq.${sessionId}`},changed)
        .subscribe(status=>{
          if(!isCurrent(scope))return;
          if(status==='SUBSCRIBED'){reload();renew();}
          else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'||status==='CLOSED')setSnapshot(previous=>({...previous,warning:networkWarning}));
        });
      unsubscribe=()=>{void client.removeChannel(channel);};
    }catch{if(isCurrent(scope))setSnapshot(previous=>({...previous,warning:networkWarning}));}
    const heartbeatTimer=setInterval(()=>{void scope.heartbeat?.refresh();},ROOM_CLAIM_HEARTBEAT_SECONDS*1000);
    const refreshTimer=setInterval(()=>{void refresh();},ROOM_CLAIM_REFRESH_SECONDS*1000);
    const focus=()=>{reload();renew();};
    const online=()=>{renew();reload();};
    const visible=()=>{if(document.visibilityState==='visible')focus();};
    const offline=()=>{if(isCurrent(scope))setSnapshot(previous=>({...previous,warning:networkWarning}));};
    const pagehide=()=>{void release();};
    window.addEventListener('focus',focus);window.addEventListener('online',online);window.addEventListener('offline',offline);window.addEventListener('pagehide',pagehide);
    document.addEventListener('visibilitychange',visible);
    return()=>{
      scope.active=false;invalidate();
      scope.refresh?.dispose();scope.heartbeat?.dispose();
      if(expiryTimer.current!==null){clearTimeout(expiryTimer.current);expiryTimer.current=null;}
      clearInterval(heartbeatTimer);clearInterval(refreshTimer);unsubscribe();
      window.removeEventListener('focus',focus);window.removeEventListener('online',online);window.removeEventListener('offline',offline);window.removeEventListener('pagehide',pagehide);
      document.removeEventListener('visibilitychange',visible);
      const current=lease.current;
      if(current)void enqueue(scope,()=>releaseRoomClaim(sessionId,current.roomId,current.claimedAt),true).catch(()=>{});
    };
  },[sessionId,channelId,clearLease,confirm,failure,isCurrent,refresh,release,runHeartbeat]);

  const previousCount=useRef({sessionId,count});
  useEffect(()=>{
    const previous=previousCount.current;previousCount.current={sessionId,count};
    if(sessionId===previous.sessionId&&count!==previous.count&&sessionId){
      const scope=scopeRef.current;if(scope&&isCurrent(scope)){scope.eventVersion++;void scope.refresh?.refresh(true);}
    }
  },[sessionId,count,isCurrent]);
  const current=snapshot.sessionId===sessionId?snapshot:empty(sessionId,Boolean(sessionId));
  const validClaim=current.claim&&isRoomEnabled(current.claim.roomId,count)&&deadline.current>performance.now()?current.claim:null;
  const claims=current.claims.filter(claim=>isRoomEnabled(claim.roomId,count));
  return{roomId:validClaim?.roomId??null,claims,isOwned:Boolean(validClaim),claimConfirmed:Boolean(validClaim),
    loading:current.loading,busy:current.busy,error:current.error,warning:current.warning,
    allOccupied:getRoomIds(count).every(roomId=>claims.some(claim=>claim.roomId===roomId&&claim.isClaimed&&!claim.isMine)),
    selectRoom,refresh,release,revoke:()=>{restoreBlocked.current=true;clearLease();}};
}
