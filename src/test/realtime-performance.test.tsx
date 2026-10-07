import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Examination,Participant,RoomState,Session,StaffPermissions} from '../types';

type Payload={eventType:'UPDATE'|'INSERT'|'DELETE';new:Record<string,unknown>;old:Record<string,unknown>};
type Listener={table:string;callback:(payload:Payload)=>void};
type Channel={listeners:Listener[];status:(value:string)=>void};
const remote=vi.hoisted(()=>({
  channels:new Set<Channel>(),sessions:[] as Session[],participants:new Map<string,Participant[]>(),
  getSession:vi.fn(),onAuthStateChange:vi.fn(),listSessions:vi.fn(),listParticipants:vi.fn(),
  listExaminations:vi.fn(),listRooms:vi.fn(),getSessionRoomCount:vi.fn(),callParticipant:vi.fn(),
}));

vi.mock('../lib/supabase',()=>{
  const client={
    auth:{getSession:remote.getSession,onAuthStateChange:remote.onAuthStateChange},
    channel:()=>{
      const entry:Channel={listeners:[],status:()=>{}};
      const channel={
        on:(_event:string,filter:{table:string},callback:(payload:Payload)=>void)=>{
          entry.listeners.push({table:filter.table,callback});return channel;
        },
        subscribe:(status:(value:string)=>void)=>{entry.status=status;remote.channels.add(entry);return channel;},
      };
      return Object.assign(channel,{entry});
    },
    removeChannel:(channel:{entry:Channel})=>{remote.channels.delete(channel.entry);return Promise.resolve();},
  };
  return{isSupabaseConfigured:true,supabase:client,requireSupabase:()=>client};
});
vi.mock('../features/auth/service',()=>({signIn:vi.fn(),signOut:vi.fn()}));
vi.mock('../features/auth/useStaffPermissions',()=>({useStaffPermissions:()=>({
  ready:true,loading:false,error:'',permissions:{
    userId:'counter-user',loginEmail:'counter@example.test',displayName:'',isActive:true,
    canRegistration:false,canConsole:true,canRoom:false,
  } satisfies StaffPermissions,
})}));
vi.mock('../features/sessions/service',()=>({listSessions:remote.listSessions,createSession:vi.fn(),updateSessionRoomCount:vi.fn()}));
vi.mock('../features/schedule/service',()=>({listParticipants:remote.listParticipants}));
vi.mock('../features/room/service',()=>({listRooms:remote.listRooms,getSessionRoomCount:remote.getSessionRoomCount,setRoomAway:vi.fn()}));
vi.mock('../features/console/service',()=>({callParticipant:remote.callParticipant,updateWaitingStatus:vi.fn()}));
vi.mock('../features/examination/service',async original=>({
  ...await original<typeof import('../features/examination/service')>(),
  listExaminations:remote.listExaminations,enqueueAdditionalExamination:vi.fn(),
}));
// These pages are outside this console measurement. Keep App, Console, room
// status hook, Realtime payload routing and refresh controllers unmocked.
vi.mock('../features/room/useRoomClaims',()=>({useRoomClaims:()=>({release:async()=>false})}));
vi.mock('../features/room/UltrasoundRoom',()=>({UltrasoundRoom:()=>null}));
vi.mock('../features/checkin/Checkin',()=>({Checkin:()=>null}));
vi.mock('../features/roster/RosterManager',()=>({RosterManager:()=>null}));
vi.mock('../features/roster/db',()=>({clearPreparedSchedule:vi.fn()}));
vi.mock('../features/export/sessionExport',()=>({downloadCheckinReport:vi.fn(),downloadUltrasoundReport:vi.fn()}));
vi.mock('../features/sessions/management',()=>({clearSessionSchedule:vi.fn(),deleteSession:vi.fn()}));

import App from '../App';

const baseTime='2026-10-07T00:00:00Z';
const session=(id='counter-a',patch:Partial<Session>={}):Session=>({id,companyName:id,sessionDate:'2026-10-07',status:'active',roomCount:4,...patch});
const person=(sessionId='counter-a',patch:Partial<Participant>={}):Participant=>({
  id:`${sessionId}-person`,sessionId,sequence:1,employeeNo:'001',name:`${sessionId}受檢者`,gender:'男',slot:'08:00',groupCode:'A',
  plannedItems:['腹部超音波'],checkinNo:'A1',status:'等候中',checkedInAt:baseTime,calledAt:null,note:'',updatedAt:baseTime,...patch,
});
const roomRows=(sessionId:string,count=4):RoomState[]=>Array.from({length:count},(_,index)=>({sessionId,roomId:`診間 ${index+1}`,status:'idle',updatedAt:baseTime}));
const counters=()=>({
  participants:remote.listParticipants.mock.calls.length,examinations:remote.listExaminations.mock.calls.length,
  rooms:remote.listRooms.mock.calls.length,roomCount:remote.getSessionRoomCount.mock.calls.length,
});
const clearCounters=()=>{remote.listSessions.mockClear();remote.listParticipants.mockClear();remote.listExaminations.mockClear();remote.listRooms.mockClear();remote.getSessionRoomCount.mockClear();};
const noQueries={participants:0,examinations:0,rooms:0,roomCount:0};
const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
let root:Root;let container:HTMLDivElement;

function payload(row:Record<string,unknown>,old:Record<string,unknown>={}):Payload{return{eventType:'UPDATE',new:row,old};}
async function emit(table:string,value:Payload){
  await act(async()=>{for(const channel of [...remote.channels])for(const listener of channel.listeners)if(listener.table===table)listener.callback(value);});
}
async function settle(){
  // Flush the 100 ms burst window plus React commits; never advance the
  // unrelated 30-second claim/fallback timers when counting a single event.
  await act(async()=>{await vi.advanceTimersByTimeAsync(150);});
}
async function mount(){
  await act(async()=>{root.render(<App/>);});
  await settle();
  expect(container.querySelector('table')).not.toBeNull();
  expect(container.textContent).toContain('counter-a受檢者');
  clearCounters();
}
async function chooseSession(id:string){
  const select=container.querySelector<HTMLSelectElement>('select[aria-label="工作場次"]');
  if(!select)throw new Error('找不到工作場次選擇器。');
  await act(async()=>{select.value=id;select.dispatchEvent(new Event('change',{bubbles:true}));});
  await settle();
}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}

describe('App → Console Realtime request counters',()=>{
  beforeEach(()=>{
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;vi.useFakeTimers();
    remote.channels.clear();localStorage.clear();
    remote.sessions=[session(),session('counter-b')];remote.participants=new Map(remote.sessions.map(value=>[value.id,[person(value.id)]]));
    remote.getSession.mockReset().mockResolvedValue({data:{session:{user:{id:'counter-user',email:'counter@example.test'}}}});
    remote.onAuthStateChange.mockReset().mockReturnValue({data:{subscription:{unsubscribe:vi.fn()}}});
    remote.listSessions.mockReset().mockImplementation(async()=>remote.sessions.map(value=>({...value})));
    remote.listParticipants.mockReset().mockImplementation(async(id:string)=>(remote.participants.get(id)??[]).map(value=>({...value})));
    remote.listExaminations.mockReset().mockResolvedValue([]);
    remote.getSessionRoomCount.mockReset().mockImplementation(async(id:string)=>remote.sessions.find(value=>value.id===id)?.roomCount??4);
    remote.listRooms.mockReset().mockImplementation(async(id:string,count=4)=>roomRows(id,count));
    remote.callParticipant.mockReset().mockResolvedValue(undefined);
    container=document.createElement('div');document.body.append(container);root=createRoot(container);
  });
  afterEach(async()=>{
    await act(async()=>{root.unmount();});container.remove();remote.channels.clear();
    vi.useRealTimers();vi.restoreAllMocks();actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;
  });

  it('four separate room heartbeats issue no participant, examination or full room-state query',async()=>{
    await mount();
    for(let number=1;number<=4;number++){
      const old={session_id:'counter-a',room_id:`診間 ${number}`,status:'idle',updated_at:baseTime,claim_expires_at:baseTime};
      await emit('rooms',payload({...old,claim_expires_at:'2026-10-07T00:03:00Z'},old));
      await settle();
    }
    expect(counters()).toEqual(noQueries);
  });

  it('a participant status update makes one roster query and no examination query for unchanged IDs',async()=>{
    await mount();remote.participants.set('counter-a',[person('counter-a',{status:'已叫號'})]);
    await emit('participants',payload({id:'counter-a-person',session_id:'counter-a',status:'已叫號'}));await settle();
    expect(counters()).toEqual({...noQueries,participants:1});
    expect(container.querySelector('tbody')?.textContent).toContain('已叫號');
  });

  it('three participant events in one short transaction burst coalesce into one roster query',async()=>{
    await mount();
    await emit('participants',payload({id:'counter-a-person',session_id:'counter-a',status:'等候中'}));
    await emit('participants',payload({id:'counter-a-person',session_id:'counter-a',status:'已叫號'}));
    await emit('participants',payload({id:'counter-a-person',session_id:'counter-a',status:'檢查中'}));
    await settle();
    expect(counters()).toEqual({...noQueries,participants:1});
  });

  it('session metadata refresh preserves roster and examination scope despite new object identities',async()=>{
    await mount();remote.sessions=remote.sessions.map(value=>({...value,companyName:`${value.companyName}更新`}));
    await emit('health_sessions',payload({id:'counter-a',company_name:'counter-a更新',room_count:4}));await settle();
    expect(remote.listSessions).toHaveBeenCalledTimes(1);
    expect(counters()).toEqual(noQueries);
    expect(container.textContent).toContain('counter-a更新');
  });

  it('calling a participant refreshes immediately and shares the nearby matching Realtime event',async()=>{
    await mount();
    remote.callParticipant.mockImplementationOnce(async()=>{
      remote.participants.set('counter-a',[person('counter-a',{status:'已叫號'})]);
      for(const channel of remote.channels)for(const listener of channel.listeners)if(listener.table==='participants'){
        listener.callback(payload({id:'counter-a-person',session_id:'counter-a',status:'已叫號'}));
      }
    });
    const call=Array.from(container.querySelectorAll('button')).find(button=>button.textContent==='叫號');
    expect(call).toBeDefined();await act(async()=>{call!.click();});
    expect(container.querySelector('tbody')?.textContent).toContain('已叫號');
    await settle();expect(counters()).toEqual({...noQueries,participants:1});
  });

  it('an old roster response cannot replace a new session and ignored old events issue no request',async()=>{
    await mount();const old=deferred<Participant[]>();remote.listParticipants.mockImplementationOnce(()=>old.promise);
    await emit('participants',payload({id:'counter-a-person',session_id:'counter-a'}));await settle();
    expect(remote.listParticipants).toHaveBeenCalledTimes(1);
    await chooseSession('counter-b');expect(container.textContent).toContain('counter-b受檢者');
    clearCounters();
    await act(async()=>{old.resolve([person('counter-a',{name:'不得顯示的舊回應'})]);});await settle();
    await emit('participants',payload({id:'counter-a-person',session_id:'counter-a'}));
    await emit('examinations',payload({id:'old-exam',participant_id:'counter-a-person'}));await settle();
    expect(counters()).toEqual(noQueries);
    expect(container.textContent).toContain('counter-b受檢者');expect(container.textContent).not.toContain('不得顯示的舊回應');
  });

  it('an examination event never reloads the App roster, while Console refreshes only its own participant scope',async()=>{
    await mount();
    await emit('examinations',payload({id:'foreign-exam',participant_id:'counter-b-person'}));await settle();
    expect(counters()).toEqual(noQueries);
    remote.listExaminations.mockResolvedValueOnce([{
      id:'current-exam',participantId:'counter-a-person',roundNo:1,roomId:'診間 1',startedAt:baseTime,
      completedAt:'2026-10-07T00:01:00Z',durationSeconds:60,selectedItems:['腹部超音波'],actualItems:['腹部超音波'],itemCount:1,status:'completed',
    } satisfies Examination]);
    await emit('examinations',payload({id:'current-exam',participant_id:'counter-a-person',status:'completed'}));await settle();
    expect(counters()).toEqual({...noQueries,examinations:1});
    expect(container.querySelector('tbody')?.textContent).toContain('1 件');
  });
});
