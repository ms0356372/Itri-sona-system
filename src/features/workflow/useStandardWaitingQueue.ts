import {useCallback,useEffect,useRef,useState} from 'react';
import {formatError} from '../../lib/errors';
import type {Participant} from '../../types';
import {createRefreshCoalescer,type RefreshCoalescer} from '../sync/refresh';
import {getStandardWaitingQueue} from './service';

type QueueState={sessionId:string|null;version:number;ranks:ReadonlyMap<string,number>|undefined;loading:boolean;error:string};
type QueueInput={sessionId:string|null;signature:string;version:number};

export function useStandardWaitingQueue(sessionId:string|null,simple:boolean,participants:Participant[]){
  const scope=simple?null:sessionId;
  const signature=JSON.stringify(participants.filter(person=>person.sessionId===scope).map(person=>[
    person.id,person.status,person.checkedInAt,person.checkinSequence,person.promotedAt,person.groupCode,person.slot,person.sequence,person.checkinNo,
  ]).sort((left,right)=>String(left[0]).localeCompare(String(right[0]))));
  const input=useRef<QueueInput>({sessionId:scope,signature,version:0});
  if(input.current.sessionId!==scope||input.current.signature!==signature)input.current={sessionId:scope,signature,version:input.current.version+1};
  const[state,setState]=useState<QueueState>({sessionId:null,version:-1,ranks:undefined,loading:false,error:''});
  const controller=useRef<{sessionId:string;signature:string;coalescer:RefreshCoalescer}|null>(null);

  useEffect(()=>{
    if(!scope)return;
    let active=true;
    const load=async()=>{
      if(!active||input.current.sessionId!==scope)return;
      const version=input.current.version;
      const current=()=>active&&input.current.sessionId===scope&&input.current.version===version;
      setState(old=>({sessionId:scope,version,ranks:old.sessionId===scope&&old.version===version?old.ranks:undefined,loading:true,error:''}));
      try{
        const ranks=await getStandardWaitingQueue(scope);
        if(current())setState({sessionId:scope,version,ranks,loading:false,error:''});
      }catch(error){
        if(current())setState({sessionId:scope,version,ranks:undefined,loading:false,error:`候檢順位讀取失敗：${formatError(error)}`});
      }
    };
    const coalescer=createRefreshCoalescer(load);
    const entry={sessionId:scope,signature:input.current.signature,coalescer};
    controller.current=entry;
    const focus=()=>{void coalescer.schedule(false);};
    const visible=()=>{if(document.visibilityState==='visible')focus();};
    window.addEventListener('focus',focus);window.addEventListener('online',focus);document.addEventListener('visibilitychange',visible);
    void coalescer.refresh();
    return()=>{
      active=false;coalescer.dispose();if(controller.current===entry)controller.current=null;
      window.removeEventListener('focus',focus);window.removeEventListener('online',focus);document.removeEventListener('visibilitychange',visible);
    };
  },[scope]);

  useEffect(()=>{
    const entry=controller.current;
    if(!scope||entry?.sessionId!==scope||entry.signature===signature)return;
    entry.signature=signature;
    void entry.coalescer.schedule(true);
  },[scope,signature]);

  const refresh=useCallback(async()=>{
    const entry=controller.current;
    if(entry&&entry.sessionId===input.current.sessionId)await entry.coalescer.refresh(true);
  },[]);
  const matching=state.sessionId===scope&&state.version===input.current.version;
  return{
    ranks:scope&&matching?state.ranks:undefined,
    loading:Boolean(scope)&&(!matching||state.loading),
    error:scope&&matching?state.error:'',
    refresh,
  };
}
