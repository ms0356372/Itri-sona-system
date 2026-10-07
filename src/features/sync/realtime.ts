import type {RealtimePostgresChangesPayload,REALTIME_SUBSCRIBE_STATES} from '@supabase/supabase-js';
import {requireSupabase} from '../../lib/supabase';

export type ChangePayload=RealtimePostgresChangesPayload<Record<string,unknown>>;
export type RealtimeStatus=REALTIME_SUBSCRIBE_STATES;
type StatusHandler=(status:RealtimeStatus)=>void;
export type ParticipantScope={
  getKnownParticipantIds?:()=>ReadonlySet<string>;
  onDelete?:(id:string)=>void;
  onStatus?:StatusHandler;
};
export type ExaminationScope={
  getParticipantIds:()=>ReadonlySet<string>;
  getKnownExaminationIds:()=>ReadonlySet<string>;
  onDelete?:(id:string)=>void;
};
let subscriptionId=0;
const recordId=(row:Record<string,unknown>)=>typeof row.id==='string'&&row.id?row.id:null;

export function subscribeParticipants(sessionId:string,onChange:()=>void,scope:ParticipantScope={}){
  const client=requireSupabase();let active=true;
  const channel=client.channel(`participants:${sessionId}:${++subscriptionId}`)
    .on('postgres_changes',{event:'*',schema:'public',table:'participants',filter:`session_id=eq.${sessionId}`},payload=>{
      if(!active)return;
      if(payload.eventType==='DELETE'){
        // DELETE may contain only the PK; its session filter is not sufficient.
        const id=recordId(payload.old);if(!id)return;
        const known=scope.getKnownParticipantIds?.().has(id);
        scope.onDelete?.(id);
        if(known)onChange();
        return;
      }
      if(payload.new.session_id===sessionId)onChange();
    })
    .subscribe(status=>{
      if(!active)return;
      if(scope.onStatus)scope.onStatus(status);else if(status==='SUBSCRIBED')onChange();
    });
  return()=>{active=false;void client.removeChannel(channel);};
}

export function subscribeExaminations(scope:ExaminationScope,onChange:()=>void,onStatus?:StatusHandler){
  const client=requireSupabase();let active=true;
  const channel=client.channel(`examinations:${++subscriptionId}`)
    .on('postgres_changes',{event:'*',schema:'public',table:'examinations'},payload=>{
      if(!active)return;
      if(payload.eventType==='DELETE'){
        const id=recordId(payload.old);if(!id)return;
        // The caller can retain unknown PK tombstones while a read is in flight,
        // without reloading for deletions belonging to another session.
        const known=scope.getKnownExaminationIds().has(id);
        scope.onDelete?.(id);
        if(known)onChange();
        return;
      }
      const participantId=payload.new.participant_id;
      const id=recordId(payload.new)??recordId(payload.old);
      if(typeof participantId==='string'&&scope.getParticipantIds().has(participantId)
        ||id!==null&&scope.getKnownExaminationIds().has(id))onChange();
    })
    .subscribe(status=>{
      if(!active)return;
      if(onStatus)onStatus(status);else if(status==='SUBSCRIBED')onChange();
    });
  return()=>{active=false;void client.removeChannel(channel);};
}

export function subscribeRooms(sessionId:string,onPayload:(payload:ChangePayload)=>void,onStatus?:StatusHandler){
  const client=requireSupabase();let active=true;
  const channel=client.channel(`rooms:${sessionId}:${++subscriptionId}`)
    .on('postgres_changes',{event:'*',schema:'public',table:'rooms',filter:`session_id=eq.${sessionId}`},payload=>{
      if(!active)return;
      const row=payload.eventType==='DELETE'?payload.old:payload.new;
      // rooms has a composite PK, so DELETE can still be scoped precisely.
      if(row.session_id===sessionId&&typeof row.room_id==='string'&&row.room_id)onPayload(payload);
    })
    .subscribe(status=>{if(active)onStatus?.(status);});
  return()=>{active=false;void client.removeChannel(channel);};
}

export function subscribeSessions(onChange:()=>void,onStatus?:StatusHandler){
  const client=requireSupabase();let active=true;
  const channel=client.channel(`health-sessions:${++subscriptionId}`)
    .on('postgres_changes',{event:'*',schema:'public',table:'health_sessions'},()=>{if(active)onChange();})
    .subscribe(status=>{
      if(!active)return;
      if(onStatus)onStatus(status);else if(status==='SUBSCRIBED')onChange();
    });
  return()=>{active=false;void client.removeChannel(channel);};
}
