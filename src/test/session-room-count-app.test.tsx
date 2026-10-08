import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Participant,Session} from '../types';

const remote=vi.hoisted(()=>({
  permissions:{userId:'staff-1',loginEmail:'staff@example.test',displayName:'',canRegistration:true,canConsole:true,canRoom:true,isActive:true},
  sessions:[] as Session[],listeners:new Set<()=>void>(),
  getSession:vi.fn(),onAuthStateChange:vi.fn(),unsubscribeAuth:vi.fn(),
  listSessions:vi.fn(),createSession:vi.fn(),updateSessionRoomCount:vi.fn(),listParticipants:vi.fn(),
  subscribeParticipants:vi.fn(),subscribeSessions:vi.fn(),unsubscribeSessions:vi.fn(),
}));
vi.mock('../lib/supabase',()=>{
  const client={
    auth:{getSession:remote.getSession,onAuthStateChange:remote.onAuthStateChange},
    channel:()=>{const channel={on:()=>channel,subscribe:()=>channel};return channel;},
    removeChannel:vi.fn(),
  };
  return{isSupabaseConfigured:true,supabase:client,requireSupabase:()=>client};
});
vi.mock('../features/auth/service',()=>({signIn:vi.fn(),signOut:vi.fn()}));
vi.mock('../features/auth/permissions',async importOriginal=>({
  ...await importOriginal<typeof import('../features/auth/permissions')>(),
  getStaffPermissions:async()=>remote.permissions,
}));
// Keep real timers for Realtime/coalesced refreshes; only the business date is fixed.
vi.mock('../lib/time',async importOriginal=>({
  ...await importOriginal<typeof import('../lib/time')>(),
  taiwanToday:vi.fn(),
}));
vi.mock('../features/sessions/service',()=>({listSessions:remote.listSessions,createSession:remote.createSession,updateSessionRoomCount:remote.updateSessionRoomCount}));
vi.mock('../features/schedule/service',()=>({listParticipants:remote.listParticipants}));
vi.mock('../features/sync/realtime',()=>({subscribeParticipants:remote.subscribeParticipants,subscribeSessions:remote.subscribeSessions}));
vi.mock('../features/roster/RosterManager',()=>({RosterManager:()=>null}));
vi.mock('../features/roster/db',()=>({clearPreparedSchedule:vi.fn()}));
vi.mock('../features/checkin/Checkin',()=>({Checkin:({current,participants}:{current:Session|null;participants:Participant[]})=><div data-checkin-session={current?.id??''} data-participant-count={participants.length}>{participants.map(person=><span key={person.id} data-participant-session={person.sessionId}>{person.name}</span>)}</div>}));
vi.mock('../features/console/Console',()=>({UltrasoundConsole:({current}:{current:Session|null})=><output data-current-room-count={current?.roomCount??4}>控制台場次：{current?.id}</output>}));
vi.mock('../features/room/UltrasoundRoom',()=>({UltrasoundRoom:({current}:{current:Session|null})=><output data-current-room-count={current?.roomCount??4}>診間場次：{current?.id}</output>}));
vi.mock('../features/room/useRoomClaims',()=>({useRoomClaims:()=>({roomId:null,claims:[],isOwned:false,claimConfirmed:false,loading:false,busy:false,error:'',warning:'',allOccupied:false,selectRoom:vi.fn(),refresh:vi.fn(),release:async()=>true})}));
vi.mock('../features/room/RoomStatusOverview',()=>({RoomStatusOverview:({sessionId,roomCount}:{sessionId:string;roomCount?:number|null})=><output data-overview-session={sessionId} data-current-room-count={roomCount??4}/> }));
vi.mock('../features/sessions/management',()=>({clearSessionSchedule:vi.fn(),deleteSession:vi.fn()}));
vi.mock('../features/examination/service',()=>({listExaminations:vi.fn()}));
vi.mock('../features/export/sessionExport',()=>({downloadCheckinReport:vi.fn(),downloadUltrasoundReport:vi.fn()}));

import App from '../App';
import {taiwanToday} from '../lib/time';

const TEST_TODAY='2026-10-07';
const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
const session=(patch:Partial<Session>={}):Session=>({id:'session-a',companyName:'ITRI',sessionDate:TEST_TODAY,status:'active',roomCount:3,...patch});
const participant=(sessionId:string):Participant=>({id:`person-${sessionId}`,sessionId,sequence:1,employeeNo:'001',name:`${sessionId} 受檢者`,gender:'男',slot:'08:00',groupCode:'A',plannedItems:['腹部超音波'],checkinNo:null,status:'未報到',checkedInAt:null,calledAt:null,note:'',updatedAt:'2026-10-07T00:00:00Z'});
let apps:{root:Root;container:HTMLDivElement}[];

async function mount(){
  const container=document.createElement('div');document.body.append(container);
  const root=createRoot(container);apps.push({root,container});
  await act(async()=>{root.render(<App/>);});
  return container;
}
function button(container:HTMLElement,label:string){
  const result=Array.from(container.querySelectorAll('button')).find(element=>element.textContent===label);
  if(!result)throw new Error(`找不到按鈕：${label}`);
  return result;
}
async function click(container:HTMLElement,label:string){await act(async()=>{button(container,label).click();});}
async function input(element:HTMLInputElement,value:string){
  const setValue=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;
  await act(async()=>{setValue.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));});
}
function creation(container:HTMLElement){
  const heading=Array.from(container.querySelectorAll('h3')).find(element=>element.textContent==='建立今日場次');
  if(!heading?.parentElement)throw new Error('找不到建立場次畫面。');
  return heading.parentElement;
}
function countInput(container:HTMLElement){return creation(container).querySelector<HTMLInputElement>('input[type="number"]')!;}
function selection(container:HTMLElement){return container.querySelector<HTMLSelectElement>('select[aria-label="目前場次"]')!;}
async function select(container:HTMLElement,id:string){
  await act(async()=>{const element=selection(container);element.value=id;element.dispatchEvent(new Event('change',{bubbles:true}));});
}
async function manage(container:HTMLElement){await click(container,'場次管理');}
async function settleRefresh(){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,110));});}
async function broadcast(){await act(async()=>{for(const listener of remote.listeners)listener();});await settleRefresh();}
function currentCount(container:HTMLElement){return container.querySelector('[data-current-room-count]')?.getAttribute('data-current-room-count');}

describe('App 場次診間數量建立及跨裝置同步',()=>{
  beforeEach(()=>{
    vi.mocked(taiwanToday).mockReset().mockReturnValue(TEST_TODAY);
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;apps=[];localStorage.clear();remote.listeners.clear();
    for(const value of Object.values(remote))if(typeof value==='function'&&'mockReset' in value)value.mockReset();
    remote.sessions=[session()];
    remote.getSession.mockResolvedValue({data:{session:{user:{id:'staff-1',email:'staff@example.test'}}}});
    remote.onAuthStateChange.mockReturnValue({data:{subscription:{unsubscribe:remote.unsubscribeAuth}}});
    remote.listSessions.mockImplementation(async()=>remote.sessions.map(value=>({...value})));
    remote.listParticipants.mockResolvedValue([]);
    remote.subscribeParticipants.mockReturnValue(()=>undefined);
    remote.subscribeSessions.mockImplementation((listener:()=>void)=>{
      remote.listeners.add(listener);
      return()=>{remote.listeners.delete(listener);remote.unsubscribeSessions();};
    });
    remote.createSession.mockImplementation(async(companyName:string,sessionDate:string,_userId:string,roomCount:number)=>{
      const value=session({id:'created-session',companyName,sessionDate,roomCount});
      remote.sessions.push(value);return {...value};
    });
    remote.updateSessionRoomCount.mockImplementation(async(id:string,roomCount:number)=>{
      const value=remote.sessions.find(item=>item.id===id)!;value.roomCount=roomCount;return {...value};
    });
  });
  afterEach(async()=>{
    await act(async()=>{for(const app of apps)app.root.unmount();});
    for(const app of apps)app.container.remove();
    localStorage.clear();actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;
    vi.mocked(taiwanToday).mockReset();
  });

  it.each([4,2,8])('新增場次設定 %i 間，透過既有建立流程儲存且選擇新場次',async roomCount=>{
    remote.sessions=[];
    const container=await mount();await manage(container);
    const card=creation(container);
    expect(countInput(container).value).toBe('4');
    expect(countInput(container).min).toBe('1');expect(countInput(container).max).toBe('8');
    await input(card.querySelector<HTMLInputElement>('input:not([type])')!,'測試公司');
    await input(countInput(container),String(roomCount));
    expect(Array.from(card.querySelectorAll('li')).map(element=>element.textContent)).toEqual(Array.from({length:roomCount},(_,index)=>`診間${index+1}`));
    await click(container,'建立場次');
    expect(remote.createSession).toHaveBeenCalledExactlyOnceWith('測試公司',expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),'staff-1',roomCount,'standard');
    expect(selection(container).value).toBe('created-session');
    expect(selection(container).selectedOptions[0].textContent).toContain(`超音波診間：${roomCount}間`);
    expect(countInput(container).value).toBe('4');
    expect(container.textContent).toContain('場次建立成功。');
  });

  it.each([0,9])('新增場次輸入 %i 間不可儲存，也不呼叫雲端建立',async roomCount=>{
    remote.sessions=[];const container=await mount();await manage(container);
    await input(creation(container).querySelector<HTMLInputElement>('input:not([type])')!,'測試公司');
    await input(countInput(container),String(roomCount));
    expect(countInput(container).getAttribute('aria-invalid')).toBe('true');
    expect(button(container,'建立場次').disabled).toBe(true);
    expect(creation(container).textContent).toContain('請輸入 1～8 的整數診間數量。');
    await click(container,'建立場次');expect(remote.createSession).not.toHaveBeenCalled();
  });

  it('場次列表顯示各自診間數量，切換場次與工作站都使用選擇的設定',async()=>{
    remote.sessions=[session(),session({id:'session-b',companyName:'另一公司',roomCount:8}),session({id:'legacy',companyName:'舊場次',roomCount:null})];
    const container=await mount();expect(currentCount(container)).toBe('3');await manage(container);
    expect(Array.from(selection(container).options).map(option=>option.textContent)).toEqual([
      '選擇既有場次','2026-10-07｜ITRI｜超音波診間：3間','2026-10-07｜另一公司｜超音波診間：8間','2026-10-07｜舊場次｜超音波診間：4間',
    ]);
    await select(container,'session-b');
    expect(container.querySelector<HTMLFormElement>('form')?.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('8');
    await click(container,'返回報到站');expect(currentCount(container)).toBe('8');
    await click(container,'超音波控制台');expect(currentCount(container)).toBe('8');
    await click(container,'超音波診間');expect(currentCount(container)).toBe('8');
    await click(container,'健檢報到站');await manage(container);await select(container,'legacy');
    await click(container,'返回報到站');expect(currentCount(container)).toBe('4');
  });

  it('儲存編輯後重新載入場次，報到站取得已儲存數量',async()=>{
    remote.sessions=[session({sessionDate:taiwanToday()})];
    expect(remote.sessions[0].sessionDate).toBe(TEST_TODAY);
    expect(remote.sessions[0].roomCount).toBe(3);
    const container=await mount();await manage(container);
    const editor=container.querySelector<HTMLFormElement>('form')!;
    expect(button(container,'儲存診間數量').disabled).toBe(false);
    await input(editor.querySelector<HTMLInputElement>('input[type="number"]')!,'6');
    await act(async()=>{editor.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    expect(remote.updateSessionRoomCount).toHaveBeenCalledExactlyOnceWith('session-a',6);
    expect(selection(container).selectedOptions[0].textContent).toContain('超音波診間：6間');
    expect(container.textContent).toContain('超音波診間數量已更新為 6 間。');
    await click(container,'返回報到站');expect(currentCount(container)).toBe('6');
  });

  it('歷史日期的 active 場次診間數量唯讀，禁止儲存或直接提交',async()=>{
    remote.sessions=[session({sessionDate:'2026-10-06',roomCount:6})];
    expect(taiwanToday()).toBe(TEST_TODAY);
    const container=await mount();await manage(container);
    const editor=container.querySelector<HTMLFormElement>('form')!;
    const count=editor.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(count.value).toBe('6');expect(count.disabled).toBe(true);
    expect(button(container,'儲存診間數量').disabled).toBe(true);
    await click(container,'儲存診間數量');
    await act(async()=>{editor.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    expect(remote.updateSessionRoomCount).not.toHaveBeenCalled();
    expect(remote.sessions[0].roomCount).toBe(6);
  });

  it('場次 Realtime 事件重新載入目前場次，兩個 App 同步讀取同一雲端數量',async()=>{
    const first=await mount();const second=await mount();
    expect(remote.listeners.size).toBe(2);expect(currentCount(first)).toBe('3');expect(currentCount(second)).toBe('3');
    await click(first,'超音波控制台');await manage(second);
    remote.sessions[0].roomCount=6;await broadcast();
    expect(currentCount(first)).toBe('6');
    expect(selection(second).selectedOptions[0].textContent).toContain('超音波診間：6間');
    expect(second.querySelector<HTMLFormElement>('form')?.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('6');
    await click(second,'返回報到站');expect(currentCount(second)).toBe('6');
    remote.sessions[0].roomCount=2;await broadcast();
    expect(currentCount(first)).toBe('2');expect(currentCount(second)).toBe('2');
  });

  it('Realtime 在場次查詢中到達時不並行重讀，完成後追讀最新診間數量',async()=>{
    const container=await mount();expect(currentCount(container)).toBe('3');
    let resolveEarlier!:(values:Session[])=>void;
    const earlierSnapshot=remote.sessions.map(value=>({...value}));
    remote.listSessions.mockImplementationOnce(()=>new Promise<Session[]>(resolve=>{resolveEarlier=resolve;}));
    await broadcast();
    expect(remote.listSessions).toHaveBeenCalledTimes(2);
    remote.sessions[0].roomCount=6;
    await broadcast();
    expect(remote.listSessions).toHaveBeenCalledTimes(2);
    expect(currentCount(container)).toBe('3');
    await act(async()=>{resolveEarlier(earlierSnapshot);});
    expect(currentCount(container)).toBe('6');
    await manage(container);
    expect(selection(container).selectedOptions[0].textContent).toContain('超音波診間：6間');
    expect(container.querySelector<HTMLFormElement>('form')?.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('6');
    expect(remote.listSessions).toHaveBeenCalledTimes(3);
  });

  it('切換場次後，舊場次受檢者查詢延遲回覆不會污染新場次名單',async()=>{
    remote.sessions=[session(),session({id:'session-b',companyName:'另一公司',roomCount:6})];
    let resolveEarlier!:(values:Participant[])=>void;
    remote.listParticipants.mockImplementation((id:string)=>id==='session-a'?new Promise<Participant[]>(resolve=>{resolveEarlier=resolve;}):Promise.resolve([participant('session-b')]));
    const container=await mount();
    expect(remote.listParticipants).toHaveBeenCalledExactlyOnceWith('session-a');
    await manage(container);await select(container,'session-b');await click(container,'返回報到站');
    expect(container.querySelector('[data-checkin-session]')?.getAttribute('data-checkin-session')).toBe('session-b');
    expect(container.textContent).toContain('session-b 受檢者');
    await act(async()=>{resolveEarlier([participant('session-a')]);});
    expect(container.textContent).toContain('session-b 受檢者');
    expect(container.textContent).not.toContain('session-a 受檢者');
    expect(container.querySelector('[data-participant-count]')?.getAttribute('data-participant-count')).toBe('1');
    expect(currentCount(container)).toBe('6');
  });

  it('其他平板刪除目前場次後，自動切到另一場次且讀取中不顯示舊受檢者',async()=>{
    remote.sessions=[session(),session({id:'session-b',companyName:'另一公司',roomCount:2})];
    let resolveNext!:(values:Participant[])=>void;
    remote.listParticipants.mockImplementation((id:string)=>id==='session-a'?Promise.resolve([participant('session-a')]):new Promise<Participant[]>(resolve=>{resolveNext=resolve;}));
    const container=await mount();expect(container.textContent).toContain('session-a 受檢者');
    remote.sessions=remote.sessions.filter(value=>value.id!=='session-a');
    await broadcast();
    expect(remote.listParticipants).toHaveBeenLastCalledWith('session-b');
    expect(container.querySelector('[data-checkin-session]')?.getAttribute('data-checkin-session')).toBe('session-b');
    expect(container.querySelector('[data-participant-count]')?.getAttribute('data-participant-count')).toBe('0');
    expect(container.textContent).not.toContain('session-a 受檢者');
    expect(container.textContent).toContain('今日排程 0 人');
    expect(currentCount(container)).toBe('2');
    await act(async()=>{resolveNext([participant('session-b')]);});
    expect(container.textContent).toContain('session-b 受檢者');
    expect(container.textContent).not.toContain('session-a 受檢者');
    expect(container.querySelector('[data-participant-count]')?.getAttribute('data-participant-count')).toBe('1');
  });

  it('重新掛載會重讀雲端並恢復所選場次，不套用建立場次的預設值',async()=>{
    remote.sessions=[session(),session({id:'session-b',companyName:'另一公司',roomCount:7})];
    const container=await mount();await manage(container);await select(container,'session-b');
    expect(localStorage.getItem('itri-current-session')).toBe('session-b');
    const oldApp=apps.shift()!;await act(async()=>{oldApp.root.unmount();});oldApp.container.remove();
    expect(remote.unsubscribeSessions).toHaveBeenCalledOnce();
    const refreshed=await mount();expect(currentCount(refreshed)).toBe('7');
    expect(refreshed.querySelector('[data-overview-session]')?.getAttribute('data-overview-session')).toBe('session-b');
    expect(remote.listSessions).toHaveBeenCalledTimes(2);
  });

  it('focus 重新讀取場次設定，歷史場次保留原數量且維持唯讀',async()=>{
    remote.sessions=[session({id:'historical-session',status:'closed',roomCount:2})];
    const container=await mount();await manage(container);
    expect(selection(container).selectedOptions[0].textContent).toContain('超音波診間：2間');
    const editor=container.querySelector<HTMLFormElement>('form')!;
    expect(editor.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('2');
    expect(editor.querySelector<HTMLInputElement>('input[type="number"]')?.disabled).toBe(true);
    expect(button(container,'儲存診間數量').disabled).toBe(true);
    expect(remote.updateSessionRoomCount).not.toHaveBeenCalled();
    remote.sessions[0].roomCount=3;
    await act(async()=>{window.dispatchEvent(new Event('focus'));});
    await settleRefresh();
    expect(currentCount(container)).toBe('3');await manage(container);
    expect(selection(container).selectedOptions[0].textContent).toContain('超音波診間：3間');
    expect(container.querySelector<HTMLFormElement>('form')?.querySelector<HTMLInputElement>('input[type="number"]')?.disabled).toBe(true);
  });
});
