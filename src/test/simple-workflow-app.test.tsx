import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Participant,Session,WorkflowMode} from '../types';

type CheckinProps={current:Session|null;participants:Participant[]};
const remote=vi.hoisted(()=>({
  permissions:{userId:'staff-1',loginEmail:'staff@example.test',displayName:'',canRegistration:true,canConsole:true,canRoom:true,isActive:true},
  sessions:[] as Session[],people:new Map<string,Participant[]>(),
  getSession:vi.fn(),onAuthStateChange:vi.fn(),unsubscribeAuth:vi.fn(),
  listSessions:vi.fn(),createSession:vi.fn(),updateSessionRoomCount:vi.fn(),listParticipants:vi.fn(),
  subscribeParticipants:vi.fn(),subscribeSessions:vi.fn(),
  standardCheckin:vi.fn(),simpleCheckin:vi.fn(),
}));
vi.mock('../lib/supabase',()=>{
  const client={
    auth:{getSession:remote.getSession,onAuthStateChange:remote.onAuthStateChange},
    channel:()=>{const channel={on:()=>channel,subscribe:()=>channel};return channel;},removeChannel:vi.fn(),
  };
  return{isSupabaseConfigured:true,supabase:client,requireSupabase:()=>client};
});
vi.mock('../features/auth/service',()=>({signIn:vi.fn(),signOut:vi.fn()}));
vi.mock('../features/auth/permissions',async importOriginal=>({
  ...await importOriginal<typeof import('../features/auth/permissions')>(),getStaffPermissions:async()=>remote.permissions,
}));
vi.mock('../features/sessions/service',()=>({listSessions:remote.listSessions,createSession:remote.createSession,updateSessionRoomCount:remote.updateSessionRoomCount}));
vi.mock('../features/schedule/service',()=>({listParticipants:remote.listParticipants}));
vi.mock('../features/sync/realtime',()=>({subscribeParticipants:remote.subscribeParticipants,subscribeSessions:remote.subscribeSessions}));
vi.mock('../features/roster/RosterManager',()=>({RosterManager:({current}:{current:Session})=><output data-roster-session={current.id} data-roster-mode={current.workflowMode??'standard'}/> }));
vi.mock('../features/roster/db',()=>({clearPreparedSchedule:vi.fn()}));
vi.mock('../features/checkin/Checkin',()=>({Checkin:remote.standardCheckin}));
vi.mock('../features/checkin/SimpleCheckin',()=>({SimpleCheckin:remote.simpleCheckin}));
vi.mock('../features/console/Console',()=>({UltrasoundConsole:({current}:{current:Session|null})=><output data-console-session={current?.id??''} data-workflow-mode={current?.workflowMode??'standard'}/> }));
vi.mock('../features/room/UltrasoundRoom',()=>({UltrasoundRoom:({current}:{current:Session|null})=><output data-room-session={current?.id??''} data-workflow-mode={current?.workflowMode??'standard'}/> }));
vi.mock('../features/room/useRoomClaims',()=>({useRoomClaims:()=>({roomId:null,claims:[],isOwned:false,claimConfirmed:false,loading:false,busy:false,error:'',warning:'',allOccupied:false,selectRoom:vi.fn(),refresh:vi.fn(),release:async()=>true})}));
vi.mock('../features/room/RoomStatusOverview',()=>({RoomStatusOverview:()=>null}));
vi.mock('../features/sessions/management',()=>({clearSessionSchedule:vi.fn(),deleteSession:vi.fn()}));
vi.mock('../features/examination/service',()=>({listExaminations:vi.fn()}));
vi.mock('../features/export/sessionExport',()=>({downloadCheckinReport:vi.fn(),downloadUltrasoundReport:vi.fn()}));

import App from '../App';

const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
const session=(patch:Partial<Session>={}):Session=>({id:'standard-session',companyName:'ITRI',sessionDate:'2026-10-07',status:'active',roomCount:4,...patch});
const participant=(id:string,index:number,patch:Partial<Participant>={}):Participant=>({
  id:`${id}-${index}`,sessionId:id,sequence:index,employeeNo:String(index).padStart(5,'0'),name:`受檢者 ${index}`,gender:'男',slot:'08:00',groupCode:'A',
  plannedItems:['一般'],checkinNo:`A${index}`,status:index===1?'已完成':'等候中',checkedInAt:'2026-10-07T00:30:00Z',calledAt:null,note:'',updatedAt:'2026-10-07T00:30:00Z',...patch,
});
let apps:{root:Root;container:HTMLDivElement}[];

async function mount(){
  const container=document.createElement('div');document.body.append(container);
  const root=createRoot(container);apps.push({root,container});
  await act(async()=>{root.render(<App/>);});return container;
}
function button(container:HTMLElement,label:string){
  const result=Array.from(container.querySelectorAll('button')).find(element=>element.textContent===label);
  if(!result)throw new Error(`找不到按鈕：${label}`);return result;
}
async function click(container:HTMLElement,label:string){await act(async()=>{button(container,label).click();});}
async function input(element:HTMLInputElement,value:string){
  const setValue=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;
  await act(async()=>{setValue.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));});
}
function creation(container:HTMLElement){
  const heading=Array.from(container.querySelectorAll('h3')).find(element=>element.textContent==='建立今日場次');
  if(!heading?.parentElement)throw new Error('找不到建立場次畫面。');return heading.parentElement;
}
function radio(container:HTMLElement,mode:WorkflowMode){return creation(container).querySelector<HTMLInputElement>(`input[type="radio"][value="${mode}"]`)!;}
function selection(container:HTMLElement){return container.querySelector<HTMLSelectElement>('select[aria-label="目前場次"]')!;}
async function select(container:HTMLElement,id:string){
  await act(async()=>{const element=selection(container);element.value=id;element.dispatchEvent(new Event('change',{bubbles:true}));});
}
function statistics(container:HTMLElement){
  return Object.fromEntries(Array.from(container.querySelectorAll('dl dt')).map(element=>[element.textContent,element.nextElementSibling?.textContent]));
}
function checkin(mode:string,{current,participants}:CheckinProps){
  return <output data-checkin-mode={mode} data-checkin-session={current?.id??''} data-participant-count={participants.length}>{mode==='simple'?'簡易報到':'標準報到'}</output>;
}

describe('App 標準與簡易場次模式分流',()=>{
  beforeEach(()=>{
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;apps=[];localStorage.clear();remote.people.clear();
    for(const value of Object.values(remote))if(typeof value==='function'&&'mockReset' in value)value.mockReset();
    remote.sessions=[session()];
    remote.people.set('standard-session',[participant('standard-session',1),participant('standard-session',2),participant('standard-session',3,{checkinNo:null,checkedInAt:null,status:'未報到'})]);
    remote.getSession.mockResolvedValue({data:{session:{user:{id:'staff-1',email:'staff@example.test'}}}});
    remote.onAuthStateChange.mockReturnValue({data:{subscription:{unsubscribe:remote.unsubscribeAuth}}});
    remote.listSessions.mockImplementation(async()=>remote.sessions.map(value=>({...value})));
    remote.listParticipants.mockImplementation(async(id:string)=>(remote.people.get(id)??[]).map(value=>({...value})));
    remote.subscribeParticipants.mockReturnValue(()=>undefined);remote.subscribeSessions.mockReturnValue(()=>undefined);
    remote.createSession.mockImplementation(async(companyName:string,sessionDate:string,_userId:string,roomCount:number,workflowMode:WorkflowMode)=>{
      const value=session({id:'created-session',companyName,sessionDate,roomCount,workflowMode});remote.sessions.push(value);return {...value};
    });
    remote.standardCheckin.mockImplementation((props:CheckinProps)=>checkin('standard',props));
    remote.simpleCheckin.mockImplementation((props:CheckinProps)=>checkin('simple',props));
  });
  afterEach(async()=>{
    await act(async()=>{for(const app of apps)app.root.unmount();});for(const app of apps)app.container.remove();
    localStorage.clear();actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;
  });

  it('新增場次預設選標準模式，提供兩種說明並以第五個參數儲存 standard',async()=>{
    remote.sessions=[];const container=await mount();await click(container,'場次管理');
    expect(radio(container,'standard').checked).toBe(true);expect(radio(container,'simple').checked).toBe(false);
    expect(creation(container).textContent).toContain('使用每日排程與 A～G 分組報到。');
    expect(creation(container).textContent).toContain('不使用每日排程，直接從公司大名單報到並依序取號。');
    await input(creation(container).querySelector<HTMLInputElement>('input:not([type])')!,'標準公司');await click(container,'建立場次');
    expect(remote.createSession).toHaveBeenCalledExactlyOnceWith('標準公司',expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),'staff-1',4,'standard');
    await click(container,'返回報到站');expect(container.querySelector('[data-checkin-mode]')?.getAttribute('data-checkin-mode')).toBe('standard');
    expect(remote.simpleCheckin).not.toHaveBeenCalled();
  });

  it('選擇簡易模式後建立會傳 simple、選取新場次，建立欄位重設標準但新場次仍走簡易報到',async()=>{
    remote.sessions=[];const container=await mount();await click(container,'場次管理');
    await act(async()=>{radio(container,'simple').click();});
    await input(creation(container).querySelector<HTMLInputElement>('input:not([type])')!,'簡易公司');
    await input(creation(container).querySelector<HTMLInputElement>('input[type="number"]')!,'6');await click(container,'建立場次');
    expect(remote.createSession).toHaveBeenCalledExactlyOnceWith('簡易公司',expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),'staff-1',6,'simple');
    expect(selection(container).value).toBe('created-session');expect(selection(container).selectedOptions[0].textContent).toContain('簡易模式');
    expect(radio(container,'standard').checked).toBe(true);expect(radio(container,'simple').checked).toBe(false);
    expect(statistics(container)).toMatchObject({'場次模式':'簡易模式','超音波診間':'6間','已報到':'0 人'});
    expect(statistics(container)).not.toHaveProperty('今日排程');expect(statistics(container)).not.toHaveProperty('未報到');
    await click(container,'返回報到站');expect(container.querySelector('[data-checkin-mode]')?.getAttribute('data-checkin-mode')).toBe('simple');
    expect(container.querySelector('[data-checkin-session]')?.getAttribute('data-checkin-session')).toBe('created-session');
    expect(container.textContent).toContain('簡易模式｜已報到 0 人');
  });

  it('既有簡易場次直接 render SimpleCheckin，摘要及管理視窗只顯示實際已報到／已完成',async()=>{
    remote.sessions=[session({id:'simple-session',workflowMode:'simple'})];
    remote.people.set('simple-session',[1,2,3].map(index=>participant('simple-session',index,{slot:null,groupCode:null,queueNumber:index,checkinNo:String(index)})));
    const container=await mount();expect(container.querySelector('[data-checkin-mode]')?.getAttribute('data-checkin-mode')).toBe('simple');
    expect(remote.standardCheckin.mock.calls.every(call=>(call[0] as CheckinProps).current===null)).toBe(true);expect(container.textContent).toContain('簡易模式｜已報到 3 人');
    expect(container.textContent).not.toContain('今日排程');expect(container.textContent).not.toContain('未報到');
    await click(container,'場次管理');expect(statistics(container)).toMatchObject({'場次模式':'簡易模式','已報到':'3 人','已完成超音波':'1 人'});
    expect(statistics(container)).not.toHaveProperty('今日排程');expect(statistics(container)).not.toHaveProperty('未報到');
    await click(container,'清除資料或刪除場次');
    const dialog=container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(statistics(dialog)).toMatchObject({'場次模式':'簡易模式','已報到':'3 人','已完成檢查':'1 人','超音波診間':'4間'});
    expect(statistics(dialog)).not.toHaveProperty('今日排程');expect(statistics(dialog)).not.toHaveProperty('未報到');
    await click(dialog,'清除本場次報到資料');
    expect(dialog.textContent).toContain('請輸入「清除報到資料」以確認');expect(dialog.textContent).not.toContain('今日排程');
    expect(button(dialog,'確認清除').disabled).toBe(true);
  });

  it.each([undefined,null,'standard'] as const)('既有 workflowMode=%s 維持標準報到、排程與未報到管理統計',async workflowMode=>{
    remote.sessions=[session({workflowMode})];
    const container=await mount();expect(container.querySelector('[data-checkin-mode]')?.getAttribute('data-checkin-mode')).toBe('standard');
    expect(remote.simpleCheckin).not.toHaveBeenCalled();expect(container.textContent).toContain('今日排程 3 人');
    await click(container,'場次管理');expect(statistics(container)).toMatchObject({'場次模式':'標準模式','今日排程':'3 人','已報到':'2 人','未報到':'1 人','已完成超音波':'1 人'});
    await click(container,'清除排程或刪除場次');const dialog=container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(statistics(dialog)).toMatchObject({'今日排程':'3 人','已報到':'2 人','未報到':'1 人','已完成檢查':'1 人'});
    await click(dialog,'清除今日排程');expect(dialog.textContent).toContain('請輸入「清除排程」以確認');
  });

  it('切換不同模式場次會重新分流報到、摘要與同一套控制台／診間',async()=>{
    remote.sessions=[session(),session({id:'simple-session',companyName:'簡易公司',workflowMode:'simple',roomCount:2})];
    remote.people.set('simple-session',[participant('simple-session',1,{slot:null,groupCode:null,queueNumber:1,checkinNo:'1'})]);
    const container=await mount();await click(container,'場次管理');await select(container,'simple-session');
    expect(statistics(container)['場次模式']).toBe('簡易模式');expect(statistics(container)).not.toHaveProperty('今日排程');
    await click(container,'返回報到站');expect(container.querySelector('[data-checkin-mode]')?.getAttribute('data-checkin-mode')).toBe('simple');
    await click(container,'超音波控制台');expect(container.querySelector('[data-console-session]')?.getAttribute('data-console-session')).toBe('simple-session');
    expect(container.querySelector('[data-workflow-mode]')?.getAttribute('data-workflow-mode')).toBe('simple');
    await click(container,'超音波診間');expect(container.querySelector('[data-room-session]')?.getAttribute('data-room-session')).toBe('simple-session');
    await click(container,'健檢報到站');await click(container,'場次管理');await select(container,'standard-session');
    expect(statistics(container)).toMatchObject({'場次模式':'標準模式','今日排程':'3 人','未報到':'1 人'});
    await click(container,'返回報到站');expect(container.querySelector('[data-checkin-mode]')?.getAttribute('data-checkin-mode')).toBe('standard');
    expect(container.textContent).toContain('今日排程 3 人');
  });

  it('重新掛載重讀雲端並恢復所選簡易場次，不套用新增場次的標準預設',async()=>{
    remote.sessions=[session(),session({id:'simple-session',workflowMode:'simple'})];
    const first=await mount();await click(first,'場次管理');await select(first,'simple-session');
    expect(localStorage.getItem('itri-current-session')).toBe('simple-session');
    const old=apps.shift()!;await act(async()=>{old.root.unmount();});old.container.remove();
    const refreshed=await mount();expect(containerMode(refreshed)).toBe('simple');
    expect(refreshed.querySelector('[data-checkin-session]')?.getAttribute('data-checkin-session')).toBe('simple-session');
    expect(remote.listSessions).toHaveBeenCalledTimes(2);
  });
});

function containerMode(container:HTMLElement){return container.querySelector('[data-checkin-mode]')?.getAttribute('data-checkin-mode');}
