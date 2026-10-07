import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Examination,Participant,Session,StaffPermissions} from '../types';

type AuthValue={user:{id:string;email:string}};
type PermissionChannel={listener:()=>void;status:(value:string)=>void;filter:string};
type WorkProps={current:Session|null;participants:Participant[];canRoom?:boolean};
const remote=vi.hoisted(()=>({
  permissions:new Map<string,StaffPermissions|null>(),
  channels:new Set<PermissionChannel>(),
  sessionListeners:new Set<()=>void>(),participantListeners:new Set<()=>void>(),
  authListener:null as null|((event:string,next:AuthValue|null)=>void),
  getSession:vi.fn(),onAuthStateChange:vi.fn(),unsubscribeAuth:vi.fn(),signOut:vi.fn(),
  getPermissions:vi.fn(),removeChannel:vi.fn(),
  listSessions:vi.fn(),listParticipants:vi.fn(),unsubscribeSessions:vi.fn(),unsubscribeParticipants:vi.fn(),
  createSession:vi.fn(),listExaminations:vi.fn(),downloadCheckinReport:vi.fn(),downloadUltrasoundReport:vi.fn(),
  subscribeSessions:vi.fn(),subscribeSession:vi.fn(),
  checkin:vi.fn(),console:vi.fn(),room:vi.fn(),
  claims:vi.fn(),releaseClaim:vi.fn(),
}));
vi.mock('../lib/supabase',()=>{
  const client={
    auth:{getSession:remote.getSession,onAuthStateChange:remote.onAuthStateChange},
    channel:()=>{
      const subscription:PermissionChannel={listener:()=>{},status:()=>{},filter:''};
      const channel={
        on:(_event:string,filter:{filter:string},listener:()=>void)=>{
          subscription.listener=listener;subscription.filter=filter.filter;return channel;
        },
        subscribe:(status:(value:string)=>void)=>{
          subscription.status=status;remote.channels.add(subscription);return subscription;
        },
      };
      return channel;
    },
    removeChannel:(channel:PermissionChannel)=>{remote.channels.delete(channel);remote.removeChannel(channel);return Promise.resolve();},
  };
  return{isSupabaseConfigured:true,supabase:client,requireSupabase:()=>client};
});
vi.mock('../features/auth/permissions',async importOriginal=>({
  ...await importOriginal<typeof import('../features/auth/permissions')>(),
  getStaffPermissions:remote.getPermissions,
}));
vi.mock('../features/auth/service',()=>({signIn:vi.fn(),signOut:remote.signOut}));
vi.mock('../features/sessions/service',()=>({listSessions:remote.listSessions,createSession:remote.createSession,updateSessionRoomCount:vi.fn()}));
vi.mock('../features/schedule/service',()=>({listParticipants:remote.listParticipants}));
vi.mock('../features/sync/realtime',()=>({subscribeSession:remote.subscribeSession,subscribeSessions:remote.subscribeSessions}));
vi.mock('../features/roster/RosterManager',()=>({RosterManager:()=>null}));
vi.mock('../features/roster/db',()=>({clearPreparedSchedule:vi.fn()}));
vi.mock('../features/checkin/Checkin',()=>({Checkin:remote.checkin}));
vi.mock('../features/console/Console',()=>({UltrasoundConsole:remote.console}));
vi.mock('../features/room/UltrasoundRoom',()=>({UltrasoundRoom:remote.room}));
vi.mock('../features/room/useRoomClaims',()=>({useRoomClaims:remote.claims}));
vi.mock('../features/room/RoomStatusOverview',()=>({RoomStatusOverview:()=>null}));
vi.mock('../features/sessions/management',()=>({clearSessionSchedule:vi.fn(),deleteSession:vi.fn()}));
vi.mock('../features/examination/service',()=>({listExaminations:remote.listExaminations}));
vi.mock('../features/export/sessionExport',()=>({downloadCheckinReport:remote.downloadCheckinReport,downloadUltrasoundReport:remote.downloadUltrasoundReport}));

import App from '../App';

const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
const staff=(patch:Partial<StaffPermissions>={}):StaffPermissions=>({
  userId:'staff-1',loginEmail:'staff-1@example.test',displayName:'',
  canRegistration:true,canConsole:true,canRoom:true,isActive:true,...patch,
});
const session=(patch:Partial<Session>={}):Session=>({
  id:'session-a',companyName:'ITRI',sessionDate:'2026-10-07',status:'active',roomCount:3,...patch,
});
const participant=(name:string):Participant=>({
  id:name,sessionId:'session-a',sequence:1,employeeNo:'001',name,gender:'男',slot:'08:00',groupCode:'A',
  plannedItems:['腹部超音波'],checkinNo:null,status:'未報到',checkedInAt:null,calledAt:null,note:'',updatedAt:'2026-10-07T00:00:00Z',
});
const auth=(id='staff-1'):AuthValue=>({user:{id,email:`${id}@example.test`}});
let apps:{root:Root;container:HTMLDivElement}[];

function work(page:string,{current,participants,canRoom}:WorkProps){
  return <section data-work-page={page} data-session-id={current?.id??''} data-can-room={String(canRoom)}>
    {current?.companyName}{participants.map(person=><span key={person.id}>{person.name}</span>)}
  </section>;
}
async function mount(){
  const container=document.createElement('div');document.body.append(container);
  const root=createRoot(container);apps.push({root,container});
  await act(async()=>{root.render(<App/>);});
  return container;
}
function navigation(container:HTMLElement){
  return Array.from(container.querySelectorAll('nav[aria-label="工作站導覽"] button')).map(element=>element.textContent);
}
function activePage(container:HTMLElement){return container.querySelector('[data-work-page]')?.getAttribute('data-work-page')??null;}
async function click(container:HTMLElement,label:string){
  const element=Array.from(container.querySelectorAll('button')).find(button=>button.textContent===label);
  if(!element)throw new Error(`找不到按鈕：${label}`);
  await act(async()=>{element.click();});
}
async function input(element:HTMLInputElement,value:string){
  const setValue=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;
  await act(async()=>{setValue.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));});
}
async function emitAuth(id:string|null){await act(async()=>{remote.authListener?.(id?'SIGNED_IN':'SIGNED_OUT',id?auth(id):null);});}
async function emitPermissions(id='staff-1'){
  await act(async()=>{for(const subscription of remote.channels)if(subscription.filter===`user_id=eq.${id}`)subscription.listener();});
}
function deferred<T>(){
  let resolve!:(value:T)=>void;let reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return{promise,resolve,reject};
}
function noWorkData(){
  expect(remote.listSessions).not.toHaveBeenCalled();expect(remote.listParticipants).not.toHaveBeenCalled();
  expect(remote.subscribeSessions).not.toHaveBeenCalled();expect(remote.subscribeSession).not.toHaveBeenCalled();
  expect(remote.checkin).not.toHaveBeenCalled();expect(remote.console).not.toHaveBeenCalled();expect(remote.room).not.toHaveBeenCalled();
}

describe('App 帳號頁面權限、資料載入與同步',()=>{
  beforeEach(()=>{
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;apps=[];localStorage.clear();
    remote.permissions.clear();remote.channels.clear();remote.sessionListeners.clear();remote.participantListeners.clear();remote.authListener=null;
    for(const value of Object.values(remote))if(typeof value==='function'&&'mockReset' in value)value.mockReset();
    remote.permissions.set('staff-1',staff());
    remote.getPermissions.mockImplementation(async(id:string)=>remote.permissions.get(id)??null);
    remote.getSession.mockResolvedValue({data:{session:auth()}});
    remote.onAuthStateChange.mockImplementation((listener:typeof remote.authListener)=>{
      remote.authListener=listener;return{data:{subscription:{unsubscribe:remote.unsubscribeAuth}}};
    });
    remote.signOut.mockImplementation(async()=>{remote.authListener?.('SIGNED_OUT',null);});
    remote.releaseClaim.mockResolvedValue(true);
    remote.claims.mockImplementation(()=>({roomId:'診間 1',claims:[],isOwned:true,claimConfirmed:true,loading:false,busy:false,error:'',warning:'',allOccupied:false,selectRoom:vi.fn(),refresh:vi.fn(),release:remote.releaseClaim}));
    remote.listSessions.mockResolvedValue([session()]);remote.listParticipants.mockResolvedValue([participant('今日受檢者')]);
    remote.listExaminations.mockResolvedValue([]);
    remote.subscribeSessions.mockImplementation((listener:()=>void)=>{
      remote.sessionListeners.add(listener);return()=>{remote.sessionListeners.delete(listener);remote.unsubscribeSessions();};
    });
    remote.subscribeSession.mockImplementation((_id:string,listener:()=>void)=>{
      remote.participantListeners.add(listener);return()=>{remote.participantListeners.delete(listener);remote.unsubscribeParticipants();};
    });
    remote.checkin.mockImplementation((props:WorkProps)=>work('registration',props));
    remote.console.mockImplementation((props:WorkProps)=>work('console',props));
    remote.room.mockImplementation((props:WorkProps)=>work('room',props));
  });
  afterEach(async()=>{
    await act(async()=>{for(const app of apps)app.root.unmount();});
    for(const app of apps)app.container.remove();
    localStorage.clear();actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;
  });

  it.each([
    {label:'全權限',registration:true,console:true,room:true,nav:['健檢報到站','超音波控制台','超音波診間'],page:'registration'},
    {label:'room-only',registration:false,console:false,room:true,nav:['超音波診間'],page:'room'},
    {label:'console-only',registration:false,console:true,room:false,nav:['超音波控制台'],page:'console'},
    {label:'registration-only',registration:true,console:false,room:false,nav:['健檢報到站'],page:'registration'},
    {label:'console + room',registration:false,console:true,room:true,nav:['超音波控制台','超音波診間'],page:'console'},
    {label:'registration + room',registration:true,console:false,room:true,nav:['健檢報到站','超音波診間'],page:'registration'},
    {label:'registration + console',registration:true,console:true,room:false,nav:['健檢報到站','超音波控制台'],page:'registration'},
  ])('$label 僅顯示允許頁面並依權限優先順序進入預設頁',async value=>{
    remote.permissions.set('staff-1',staff({canRegistration:value.registration,canConsole:value.console,canRoom:value.room}));
    const container=await mount();
    expect(navigation(container)).toEqual(value.nav);expect(activePage(container)).toBe(value.page);
    expect(remote.listSessions).toHaveBeenCalledOnce();expect(remote.listParticipants).toHaveBeenCalledWith('session-a');
    expect(container.textContent).toContain('今日受檢者');
    if(!value.registration){expect(remote.checkin).not.toHaveBeenCalled();expect(container.textContent).not.toContain('場次管理');expect(container.textContent).not.toContain('名單管理');}
    if(!value.console)expect(remote.console).not.toHaveBeenCalled();
    if(!value.room)expect(remote.room).not.toHaveBeenCalled();
  });

  it('全權限帳號可以切換三個工作頁面，控制台取得診間功能授權',async()=>{
    const container=await mount();await click(container,'超音波控制台');
    expect(activePage(container)).toBe('console');expect(container.querySelector('[data-can-room]')?.getAttribute('data-can-room')).toBe('true');
    await click(container,'超音波診間');expect(activePage(container)).toBe('room');
    await click(container,'健檢報到站');expect(activePage(container)).toBe('registration');
  });

  it('console-only 控制台不取得追加檢查等診間功能授權',async()=>{
    remote.permissions.set('staff-1',staff({canRegistration:false,canRoom:false}));
    const container=await mount();expect(container.querySelector('[data-can-room]')?.getAttribute('data-can-room')).toBe('false');
  });

  it.each([
    {label:'沒有 permission row',permissions:null,message:'此帳號尚未設定系統權限，請洽管理員。'},
    {label:'三頁皆 false',permissions:staff({canRegistration:false,canConsole:false,canRoom:false}),message:'此帳號目前沒有可使用的工作頁面，請洽管理員。'},
    {label:'is_active=false',permissions:staff({isActive:false}),message:'此帳號目前已停用，請洽管理員。'},
  ])('$label 只提供登出且不載入或訂閱工作資料',async value=>{
    remote.permissions.set('staff-1',value.permissions);
    const container=await mount();expect(container.textContent).toContain(value.message);
    expect(navigation(container)).toEqual([]);expect(activePage(container)).toBeNull();
    expect(Array.from(container.querySelectorAll('button')).map(element=>element.textContent)).toEqual(['登出']);
    noWorkData();await click(container,'登出');expect(remote.signOut).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('工作人員登入');
  });

  it('權限查詢失敗時維持拒絕存取，不 fallback 成全權限',async()=>{
    remote.getPermissions.mockRejectedValue(new Error('network unavailable'));
    const container=await mount();expect(container.textContent).toContain('無法確認此帳號的系統權限');
    expect(navigation(container)).toEqual([]);expect(activePage(container)).toBeNull();noWorkData();
  });

  it('權限讀取完成前不 render 任何工作頁面、不查詢場次或受檢者',async()=>{
    const pending=deferred<StaffPermissions|null>();remote.getPermissions.mockReturnValue(pending.promise);
    const container=await mount();expect(container.textContent).toContain('正在確認');noWorkData();
    await act(async()=>{pending.resolve(staff({canRegistration:false,canConsole:false}));});
    expect(navigation(container)).toEqual(['超音波診間']);expect(activePage(container)).toBe('room');
    expect(remote.checkin).not.toHaveBeenCalled();expect(remote.console).not.toHaveBeenCalled();
    expect(remote.listSessions).toHaveBeenCalledOnce();
  });

  it('Realtime 撤銷目前診間頁權限時立即移除頁面並轉入控制台',async()=>{
    remote.permissions.set('staff-1',staff({canRegistration:false}));
    const container=await mount();await click(container,'超音波診間');expect(activePage(container)).toBe('room');
    const rendersBefore=remote.room.mock.calls.length;
    remote.permissions.set('staff-1',staff({canRegistration:false,canRoom:false}));await emitPermissions();
    expect(navigation(container)).toEqual(['超音波控制台']);expect(activePage(container)).toBe('console');
    expect(remote.room.mock.calls.length).toBe(rendersBefore);
    expect(container.querySelector('[data-can-room]')?.getAttribute('data-can-room')).toBe('false');
  });

  it('三頁權限全被撤銷時清除畫面與資料訂閱，舊回呼不會再查詢資料',async()=>{
    const container=await mount();expect(container.textContent).toContain('今日受檢者');
    const oldSessionListener=[...remote.sessionListeners][0];const oldParticipantListener=[...remote.participantListeners][0];
    const reads=remote.listParticipants.mock.calls.length;const sessionReads=remote.listSessions.mock.calls.length;
    remote.permissions.set('staff-1',staff({canRegistration:false,canConsole:false,canRoom:false}));await emitPermissions();
    expect(container.textContent).toContain('此帳號目前沒有可使用的工作頁面');
    expect(container.textContent).not.toContain('今日受檢者');expect(container.textContent).not.toContain('ITRI');
    expect(navigation(container)).toEqual([]);expect(activePage(container)).toBeNull();
    expect(remote.sessionListeners.size).toBe(0);expect(remote.participantListeners.size).toBe(0);
    expect(remote.unsubscribeSessions).toHaveBeenCalled();expect(remote.unsubscribeParticipants).toHaveBeenCalled();
    await act(async()=>{oldSessionListener();oldParticipantListener();window.dispatchEvent(new Event('focus'));});
    expect(remote.listSessions).toHaveBeenCalledTimes(sessionReads);expect(remote.listParticipants).toHaveBeenCalledTimes(reads);
    expect(activePage(container)).toBeNull();
  });

  it('重新確認權限期間收回現有畫面及資料訂閱，失敗後不復用舊授權',async()=>{
    const container=await mount();expect(container.textContent).toContain('今日受檢者');
    const pending=deferred<StaffPermissions|null>();remote.getPermissions.mockReturnValueOnce(pending.promise);
    await act(async()=>{window.dispatchEvent(new Event('focus'));});
    expect(activePage(container)).toBeNull();expect(container.textContent).not.toContain('今日受檢者');
    expect(remote.sessionListeners.size).toBe(0);expect(remote.participantListeners.size).toBe(0);
    await act(async()=>{pending.reject(new Error('network down'));});
    expect(container.textContent).toContain('無法確認此帳號的系統權限');expect(activePage(container)).toBeNull();
  });

  it('focus權限確認期間隱藏業務畫面但不取消原場次租約，恢復後仍使用同一scope',async()=>{
    const container=await mount();await click(container,'超音波診間');
    expect(remote.claims).toHaveBeenLastCalledWith('session-a',3,null);
    const calls=remote.claims.mock.calls.length;
    const pending=deferred<StaffPermissions|null>();remote.getPermissions.mockReturnValueOnce(pending.promise);
    await act(async()=>{window.dispatchEvent(new Event('focus'));});
    expect(activePage(container)).toBeNull();expect(container.textContent).not.toContain('今日受檢者');
    expect(remote.claims).toHaveBeenLastCalledWith('session-a',3,null);
    await act(async()=>{pending.resolve(staff());});
    expect(activePage(container)).toBe('room');
    expect(remote.claims.mock.calls.slice(calls).every(call=>call[0]==='session-a')).toBe(true);
    expect(remote.releaseClaim).not.toHaveBeenCalled();
  });

  it('短暫offline不釋放原場次租約，畫面依權限守門停止顯示；重連重新確認後恢復',async()=>{
    const container=await mount();await click(container,'超音波診間');
    await act(async()=>{window.dispatchEvent(new Event('offline'));});
    expect(activePage(container)).toBeNull();expect(remote.claims).toHaveBeenLastCalledWith('session-a',3,null);
    await act(async()=>{for(const channel of remote.channels)channel.status('SUBSCRIBED');});
    expect(activePage(container)).toBe('room');expect(remote.claims).toHaveBeenLastCalledWith('session-a',3,null);
    expect(remote.releaseClaim).not.toHaveBeenCalled();
  });

  it('權限重讀後優先恢復目前持有租約的場次，不因另一分頁變更偏好就切房',async()=>{
    remote.listSessions.mockResolvedValue([session(),session({id:'session-b',companyName:'另一場次',roomCount:2})]);
    const container=await mount();await click(container,'超音波診間');
    localStorage.setItem('itri-current-session','session-b');
    const pending=deferred<StaffPermissions|null>();remote.getPermissions.mockReturnValueOnce(pending.promise);
    await act(async()=>{window.dispatchEvent(new Event('focus'));});
    expect(activePage(container)).toBeNull();expect(remote.claims).toHaveBeenLastCalledWith('session-a',3,null);
    await act(async()=>{pending.resolve(staff());});
    expect(container.querySelector('[data-session-id]')?.getAttribute('data-session-id')).toBe('session-a');
    expect(remote.claims).toHaveBeenLastCalledWith('session-a',3,null);
    expect(localStorage.getItem('itri-current-session')).toBe('session-a');
  });

  it.each(['none','console','inactive','missing'])('確認權限撤回為%s後取消lease scope，不持續續租',async mode=>{
    const container=await mount();await click(container,'超音波診間');
    remote.permissions.set('staff-1',mode==='missing'?null:staff({canRegistration:false,canConsole:mode==='console',canRoom:false,isActive:mode!=='inactive'}));
    await emitPermissions();
    expect(remote.claims).toHaveBeenLastCalledWith(null,undefined,null);
    expect(activePage(container)).toBe(mode==='console'?'console':null);
  });

  it('離開診間頁或切換帳號取消舊lease scope',async()=>{
    const container=await mount();await click(container,'超音波診間');
    await click(container,'超音波控制台');expect(remote.claims).toHaveBeenLastCalledWith(null,undefined,null);
    await click(container,'超音波診間');expect(remote.claims).toHaveBeenLastCalledWith('session-a',3,null);
    const pending=deferred<StaffPermissions|null>();remote.getPermissions.mockReturnValueOnce(pending.promise);
    await emitAuth('staff-2');expect(remote.claims).toHaveBeenLastCalledWith(null,undefined,null);
    await act(async()=>{pending.resolve(staff({userId:'staff-2',canRegistration:false,canConsole:false}));});
    expect(activePage(container)).toBe('room');
  });

  it('切換工作場次直接變更lease scope，不沿用另一場次診間',async()=>{
    remote.listSessions.mockResolvedValue([session(),session({id:'session-b',roomCount:2})]);
    const container=await mount();await click(container,'超音波診間');
    const chooser=container.querySelector<HTMLSelectElement>('select[aria-label="工作場次"]')!;
    await act(async()=>{chooser.value='session-b';chooser.dispatchEvent(new Event('change',{bubbles:true}));});
    expect(remote.claims).toHaveBeenLastCalledWith('session-b',2,null);
    await act(async()=>{chooser.value='';chooser.dispatchEvent(new Event('change',{bubbles:true}));});
    expect(remote.claims).toHaveBeenLastCalledWith(null,undefined,null);
  });

  it('登出先嘗試釋放租約，檢查中無法釋放仍可登出交由TTL收回',async()=>{
    const container=await mount();await click(container,'超音波診間');
    const pending=deferred<boolean>();remote.releaseClaim.mockReturnValueOnce(pending.promise);
    await click(container,'登出');expect(remote.releaseClaim).toHaveBeenCalledOnce();expect(remote.signOut).not.toHaveBeenCalled();
    await act(async()=>{pending.resolve(false);});
    expect(remote.signOut).toHaveBeenCalledOnce();expect(container.textContent).toContain('工作人員登入');
    expect(remote.claims).toHaveBeenLastCalledWith(null,undefined,null);
  });

  it('tab focus 重讀權限，管理員停用後不再保留先前工作畫面',async()=>{
    const container=await mount();remote.permissions.set('staff-1',staff({isActive:false}));
    await act(async()=>{window.dispatchEvent(new Event('focus'));});
    expect(remote.getPermissions).toHaveBeenCalledTimes(2);expect(container.textContent).toContain('此帳號目前已停用');
    expect(navigation(container)).toEqual([]);expect(activePage(container)).toBeNull();
    expect(remote.sessionListeners.size).toBe(0);expect(remote.participantListeners.size).toBe(0);
  });

  it('權限列被移除後不 fallback，重新掛載仍重新查詢並禁止工作資料',async()=>{
    const first=await mount();await click(first,'超音波診間');remote.permissions.set('staff-1',null);await emitPermissions();
    expect(first.textContent).toContain('此帳號尚未設定系統權限');expect(activePage(first)).toBeNull();
    const old=apps.shift()!;await act(async()=>{old.root.unmount();});old.container.remove();
    const reads=remote.listSessions.mock.calls.length;const peopleReads=remote.listParticipants.mock.calls.length;
    const refreshed=await mount();expect(refreshed.textContent).toContain('此帳號尚未設定系統權限');
    expect(navigation(refreshed)).toEqual([]);expect(activePage(refreshed)).toBeNull();
    expect(remote.listSessions).toHaveBeenCalledTimes(reads);expect(remote.listParticipants).toHaveBeenCalledTimes(peopleReads);
  });

  it('撤銷權限後場次查詢延遲回覆不會還原場次或觸發受檢者查詢',async()=>{
    const pending=deferred<Session[]>();remote.listSessions.mockReturnValueOnce(pending.promise);
    const container=await mount();expect(remote.listSessions).toHaveBeenCalledOnce();
    remote.permissions.set('staff-1',staff({isActive:false}));await emitPermissions();
    await act(async()=>{pending.resolve([session({companyName:'禁止顯示的舊場次'})]);});
    expect(container.textContent).toContain('此帳號目前已停用');expect(container.textContent).not.toContain('禁止顯示的舊場次');
    expect(remote.listParticipants).not.toHaveBeenCalled();expect(remote.subscribeSession).not.toHaveBeenCalled();
  });

  it('撤權後再次授權會重讀資料，撤權前的延遲名單不能覆寫重新載入的名單',async()=>{
    const container=await mount();const oldRead=deferred<Participant[]>();
    remote.listParticipants.mockReturnValueOnce(oldRead.promise);
    await act(async()=>{for(const listener of remote.participantListeners)listener();});
    remote.permissions.set('staff-1',staff({canRegistration:false,canConsole:false,canRoom:false}));await emitPermissions();
    expect(activePage(container)).toBeNull();expect(container.textContent).not.toContain('今日受檢者');
    remote.listParticipants.mockResolvedValue([participant('重新授權後的名單')]);
    remote.permissions.set('staff-1',staff({canRegistration:false,canConsole:false}));await emitPermissions();
    expect(activePage(container)).toBe('room');expect(container.textContent).toContain('重新授權後的名單');
    await act(async()=>{oldRead.resolve([participant('撤權前的舊名單')]);});
    expect(container.textContent).toContain('重新授權後的名單');expect(container.textContent).not.toContain('撤權前的舊名單');
    expect(remote.listSessions.mock.calls.length).toBeGreaterThan(1);
  });

  it('帳號切換時上一帳號未完成的場次查詢不可污染新帳號頁面',async()=>{
    const oldRead=deferred<Session[]>();remote.listSessions.mockReturnValueOnce(oldRead.promise);
    remote.permissions.set('staff-2',staff({userId:'staff-2',canRegistration:false,canRoom:false}));
    const container=await mount();expect(remote.listSessions).toHaveBeenCalledOnce();
    await emitAuth('staff-2');expect(activePage(container)).toBe('console');expect(navigation(container)).toEqual(['超音波控制台']);
    expect(container.textContent).toContain('staff-2@example.test');
    await act(async()=>{oldRead.resolve([session({id:'old-account-session',companyName:'舊帳號場次'})]);});
    expect(container.textContent).not.toContain('舊帳號場次');expect(container.querySelector('[data-session-id]')?.getAttribute('data-session-id')).toBe('session-a');
    expect(remote.listParticipants).not.toHaveBeenCalledWith('old-account-session');
    expect([...remote.channels].map(channel=>channel.filter)).toEqual(['user_id=eq.staff-2']);
  });

  it('切換帳號但仍選同一場次時，上一帳號延遲受檢者查詢也不可復用',async()=>{
    const oldRead=deferred<Participant[]>();remote.listParticipants.mockReturnValueOnce(oldRead.promise).mockResolvedValue([participant('新帳號受檢者')]);
    remote.permissions.set('staff-2',staff({userId:'staff-2',canRegistration:false,canConsole:false}));
    const container=await mount();await emitAuth('staff-2');expect(activePage(container)).toBe('room');
    expect(container.textContent).toContain('新帳號受檢者');
    await act(async()=>{oldRead.resolve([participant('舊帳號受檢者')]);});
    expect(container.textContent).toContain('新帳號受檢者');expect(container.textContent).not.toContain('舊帳號受檢者');
  });

  it('帳號切換期間的權限讀取不沿用先前頁面，舊權限回覆不會授權新帳號',async()=>{
    const oldRead=deferred<StaffPermissions|null>();const nextRead=deferred<StaffPermissions|null>();
    remote.getPermissions.mockImplementation((id:string)=>id==='staff-1'?oldRead.promise:nextRead.promise);
    const container=await mount();await emitAuth('staff-2');
    await act(async()=>{oldRead.resolve(staff());});
    expect(navigation(container)).toEqual([]);expect(activePage(container)).toBeNull();noWorkData();
    await act(async()=>{nextRead.resolve(staff({userId:'staff-2',canRegistration:false,canConsole:false}));});
    expect(navigation(container)).toEqual(['超音波診間']);expect(activePage(container)).toBe('room');
    expect(remote.checkin).not.toHaveBeenCalled();expect(remote.console).not.toHaveBeenCalled();
  });

  it('登出後延遲場次回覆不可重新開啟工作資料讀取',async()=>{
    const pending=deferred<Session[]>();remote.listSessions.mockReturnValueOnce(pending.promise);
    const container=await mount();await emitAuth(null);
    await act(async()=>{pending.resolve([session()]);});
    expect(container.textContent).toContain('工作人員登入');expect(activePage(container)).toBeNull();
    expect(remote.listParticipants).not.toHaveBeenCalled();expect(remote.subscribeSession).not.toHaveBeenCalled();expect(remote.channels.size).toBe(0);
  });

  it.each(['console','none'])('報到匯出名單仍讀取中時撤銷 registration → %s，不下載延遲回覆的資料',async target=>{
    const container=await mount();await click(container,'場次管理');
    const pending=deferred<Participant[]>();remote.listParticipants.mockReturnValueOnce(pending.promise);
    await click(container,'匯出今日報到狀況');
    expect(remote.listParticipants).toHaveBeenLastCalledWith('session-a');expect(remote.downloadCheckinReport).not.toHaveBeenCalled();
    remote.permissions.set('staff-1',staff({canRegistration:false,canConsole:target==='console',canRoom:false}));await emitPermissions();
    expect(activePage(container)).toBe(target==='console'?'console':null);
    expect(container.textContent).not.toContain('資料匯出');
    await act(async()=>{pending.resolve([participant('已撤權的延遲匯出名單')]);});
    expect(remote.downloadCheckinReport).not.toHaveBeenCalled();expect(remote.downloadUltrasoundReport).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('今日報到狀況 Excel 已完成下載。');
    expect(container.textContent).not.toContain('已撤權的延遲匯出名單');
  });

  it.each(['console','none'])('超音波匯出檢查紀錄仍讀取中時撤銷 registration → %s，不下載延遲回覆的資料',async target=>{
    const container=await mount();await click(container,'場次管理');
    const pending=deferred<Examination[]>();remote.listExaminations.mockReturnValueOnce(pending.promise);
    await click(container,'匯出今日超音波狀況');
    expect(remote.listExaminations).toHaveBeenCalledExactlyOnceWith(['今日受檢者']);expect(remote.downloadUltrasoundReport).not.toHaveBeenCalled();
    remote.permissions.set('staff-1',staff({canRegistration:false,canConsole:target==='console',canRoom:false}));await emitPermissions();
    expect(activePage(container)).toBe(target==='console'?'console':null);
    expect(container.textContent).not.toContain('資料匯出');
    await act(async()=>{pending.resolve([{
      id:'late-examination',participantId:'今日受檢者',roundNo:1,roomId:'診間 1',
      startedAt:'2026-10-07T01:00:00Z',completedAt:'2026-10-07T01:05:00Z',durationSeconds:300,
      selectedItems:['腹部超音波'],actualItems:['腹部超音波'],itemCount:1,status:'completed',
    }]);});
    expect(remote.downloadUltrasoundReport).not.toHaveBeenCalled();expect(remote.downloadCheckinReport).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('今日超音波狀況 Excel 已完成下載');
  });

  it('場次建立仍執行中換成另一全權限帳號，舊成功回呼不可選取或載入舊帳號新增的場次',async()=>{
    const pending=deferred<Session>();remote.createSession.mockReturnValueOnce(pending.promise);
    remote.permissions.set('staff-2',staff({userId:'staff-2'}));
    remote.listSessions.mockResolvedValueOnce([session()]).mockResolvedValue([session({id:'new-account-session',companyName:'新帳號場次'})]);
    const container=await mount();await click(container,'場次管理');
    await input(container.querySelector<HTMLInputElement>('input:not([type])')!,'舊帳號建立公司');
    await click(container,'建立場次');expect(remote.createSession).toHaveBeenCalledOnce();
    await emitAuth('staff-2');expect(activePage(container)).toBe('registration');
    expect(container.querySelector('[data-session-id]')?.getAttribute('data-session-id')).toBe('new-account-session');
    const reads=remote.listSessions.mock.calls.length;
    await act(async()=>{pending.resolve(session({id:'created-by-old-account',companyName:'舊帳號建立公司'}));});
    expect(remote.listSessions).toHaveBeenCalledTimes(reads);
    expect(container.querySelector('[data-session-id]')?.getAttribute('data-session-id')).toBe('new-account-session');
    expect(container.textContent).not.toContain('場次建立成功。');expect(container.textContent).not.toContain('舊帳號建立公司');
    expect(remote.listParticipants).not.toHaveBeenCalledWith('created-by-old-account');
    expect(localStorage.getItem('itri-current-session')).toBe('new-account-session');
  });
});
