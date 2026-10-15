import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Session,StaffPermissions} from '../types';

type AuthValue={user:{id:string;email:string}};
type PermissionChannel={listener:()=>void;filter:string};
type RpcResult={data:unknown;error:unknown};
const remote=vi.hoisted(()=>({
  permissions:new Map<string,StaffPermissions|null>(),channels:new Set<PermissionChannel>(),
  authListener:null as null|((event:string,next:AuthValue|null)=>void),
  getSession:vi.fn(),onAuthStateChange:vi.fn(),unsubscribeAuth:vi.fn(),getPermissions:vi.fn(),
  rpc:vi.fn(),from:vi.fn(),listSessions:vi.fn(),listParticipants:vi.fn(),
  subscribeSessions:vi.fn(),subscribeParticipants:vi.fn(),
}));
vi.mock('../lib/supabase',()=>{
  const client={
    auth:{getSession:remote.getSession,onAuthStateChange:remote.onAuthStateChange},
    rpc:remote.rpc,from:remote.from,
    channel:()=>{
      const subscription:PermissionChannel={listener:()=>{},filter:''};
      const channel={
        on:(_event:string,filter:{filter:string},listener:()=>void)=>{
          subscription.listener=listener;subscription.filter=filter.filter;return channel;
        },
        subscribe:()=>{remote.channels.add(subscription);return subscription;},
      };
      return channel;
    },
    removeChannel:(subscription:PermissionChannel)=>{remote.channels.delete(subscription);return Promise.resolve();},
  };
  return{isSupabaseConfigured:true,supabase:client,requireSupabase:()=>client};
});
vi.mock('../features/auth/permissions',async importOriginal=>({
  ...await importOriginal<typeof import('../features/auth/permissions')>(),getStaffPermissions:remote.getPermissions,
}));
vi.mock('../features/auth/service',()=>({signIn:vi.fn(),signOut:vi.fn()}));
vi.mock('../features/sessions/service',()=>({listSessions:remote.listSessions,createSession:vi.fn(),updateSessionRoomCount:vi.fn()}));
vi.mock('../features/schedule/service',()=>({listParticipants:remote.listParticipants}));
vi.mock('../features/sync/realtime',()=>({subscribeSessions:remote.subscribeSessions,subscribeParticipants:remote.subscribeParticipants}));
vi.mock('../features/workflow/WorkflowCheckin',()=>({WorkflowCheckin:()=> <section data-work-page="registration"/>}));
vi.mock('../features/console/Console',()=>({UltrasoundConsole:()=> <section data-work-page="console"/>}));
vi.mock('../features/room/UltrasoundRoom',()=>({UltrasoundRoom:()=> <section data-work-page="room"/>}));
vi.mock('../features/roster/RosterManager',()=>({RosterManager:()=>null}));
vi.mock('../features/roster/db',()=>({clearPreparedSchedule:vi.fn()}));
vi.mock('../features/room/RoomStatusOverview',()=>({RoomStatusOverview:()=>null}));
vi.mock('../features/room/useRoomClaims',()=>({useRoomClaims:()=>({release:async()=>true})}));
vi.mock('../features/sessions/management',()=>({clearSessionSchedule:vi.fn(),deleteSession:vi.fn()}));
vi.mock('../features/examination/service',()=>({listExaminations:vi.fn()}));
vi.mock('../features/export/sessionExport',()=>({downloadCheckinReport:vi.fn(),downloadUltrasoundReport:vi.fn()}));

import App from '../App';

const tokenA='a'.repeat(64);
const tokenB='b'.repeat(64);
const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
const staff=(patch:Partial<StaffPermissions>={}):StaffPermissions=>({
  userId:'staff-1',loginEmail:'staff-1@example.test',displayName:'',
  canRegistration:true,canConsole:false,canRoom:false,isActive:true,...patch,
});
const session=(patch:Partial<Session>={}):Session=>({id:'session-a',companyName:'測試公司',sessionDate:'2026-10-15',status:'active',roomCount:4,...patch});
const auth=(id='staff-1'):AuthValue=>({user:{id,email:`${id}@example.test`}});
const result=(data:unknown):RpcResult=>({data,error:null});
function deferred<T>(){
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});
  return{promise,resolve};
}
let root:Root;
let container:HTMLDivElement;
async function mount(){await act(async()=>{root.render(<App/>);});}
function button(label:string){
  const found=Array.from(container.querySelectorAll('button')).find(element=>element.textContent===label);
  if(!found)throw new Error(`找不到按鈕：${label}`);
  return found;
}
async function click(label:string){await act(async()=>{button(label).click();});}
async function manage(simple=false){await click('場次管理');await click(simple?'清除資料或刪除場次':'清除排程或刪除場次');}
function navigation(){return Array.from(container.querySelectorAll('nav[aria-label="工作站導覽"] button')).map(element=>element.textContent);}
function boardLink(){return container.querySelector<HTMLAnchorElement>('a[href*="#/board/"]');}
async function revoke(){
  await act(async()=>{for(const subscription of remote.channels)if(subscription.filter==='user_id=eq.staff-1')subscription.listener();});
}
async function settleRefresh(){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,110));});}

describe('App 僅讓報到站管理權限操作公開看板設定',()=>{
  beforeEach(()=>{
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;localStorage.clear();remote.permissions.clear();remote.channels.clear();remote.authListener=null;
    for(const value of Object.values(remote))if(typeof value==='function'&&'mockReset' in value)value.mockReset();
    remote.permissions.set('staff-1',staff());
    remote.getPermissions.mockImplementation(async(id:string)=>remote.permissions.get(id)??null);
    remote.getSession.mockResolvedValue({data:{session:auth()}});
    remote.onAuthStateChange.mockImplementation((listener:typeof remote.authListener)=>{
      remote.authListener=listener;return{data:{subscription:{unsubscribe:remote.unsubscribeAuth}}};
    });
    remote.listSessions.mockResolvedValue([session()]);remote.listParticipants.mockResolvedValue([]);
    remote.subscribeSessions.mockReturnValue(()=>undefined);remote.subscribeParticipants.mockReturnValue(()=>undefined);
    remote.rpc.mockImplementation(async(name:string,args:{p_enabled?:boolean})=>{
      if(name==='get_public_board_settings')return result({enabled:false,token:null});
      if(name==='set_public_board_enabled')return result({enabled:args.p_enabled,token:args.p_enabled?tokenA:null});
      throw new Error(`Unexpected RPC: ${name}`);
    });
    container=document.createElement('div');document.body.append(container);root=createRoot(container);
  });
  afterEach(async()=>{
    await act(async()=>{root.unmount();});container.remove();localStorage.clear();actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;
  });

  it.each(['standard','simple'] as const)('%s registration-only 由管理場次讀取與啟用看板，工作站導覽不增加頁面',async workflowMode=>{
    remote.listSessions.mockResolvedValue([session({workflowMode})]);
    await mount();expect(navigation()).toEqual(['健檢報到站']);expect(remote.rpc).not.toHaveBeenCalled();
    await click('場次管理');expect(remote.rpc).not.toHaveBeenCalled();
    await click(workflowMode==='simple'?'清除資料或刪除場次':'清除排程或刪除場次');
    expect(container.querySelector('[role="dialog"][aria-label="管理場次"]')?.textContent).toContain('受檢進度看板');
    expect(remote.rpc).toHaveBeenCalledExactlyOnceWith('get_public_board_settings',{p_session_id:'session-a'});
    await click('啟用公開看板');
    expect(remote.rpc).toHaveBeenLastCalledWith('set_public_board_enabled',{p_session_id:'session-a',p_enabled:true});
    expect(boardLink()?.href).toContain(`#/board/${tokenA}`);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="公開看板網址"]')?.value).toBe(boardLink()?.href);
    expect(navigation()).toEqual(['健檢報到站']);expect(remote.from).not.toHaveBeenCalled();
  });

  it('全權限帳號仍只有三個工作站，切換控制台與診間不載入看板管理',async()=>{
    remote.permissions.set('staff-1',staff({canConsole:true,canRoom:true}));
    await mount();expect(navigation()).toEqual(['健檢報到站','超音波控制台','超音波診間']);
    await click('超音波控制台');await click('超音波診間');await click('健檢報到站');
    expect(remote.rpc).not.toHaveBeenCalled();expect(container.textContent).not.toContain('受檢進度看板');expect(boardLink()).toBeNull();
  });

  it.each(['console','room'] as const)('%s-only 不掛載管理場次或看板設定，也不讀取私有設定 RPC',async page=>{
    remote.permissions.set('staff-1',staff({canRegistration:false,canConsole:page==='console',canRoom:page==='room'}));
    await mount();expect(container.querySelector('[data-work-page]')?.getAttribute('data-work-page')).toBe(page);
    expect(navigation()).toEqual([page==='console'?'超音波控制台':'超音波診間']);
    expect(container.textContent).not.toContain('場次管理');expect(container.textContent).not.toContain('受檢進度看板');
    expect(boardLink()).toBeNull();expect(remote.rpc).not.toHaveBeenCalled();expect(remote.from).not.toHaveBeenCalled();
  });

  it('Realtime 撤銷 registration 當下移除已啟用網址，確認後只進入控制台',async()=>{
    remote.rpc.mockResolvedValueOnce(result({enabled:true,token:tokenA}));
    await mount();await manage();const oldLink=boardLink()!;expect(oldLink.href).toContain(tokenA);
    const pending=deferred<StaffPermissions|null>();remote.getPermissions.mockReturnValueOnce(pending.promise);
    await revoke();
    expect(oldLink.isConnected).toBe(false);expect(boardLink()).toBeNull();expect(container.textContent).not.toContain('受檢進度看板');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await settleRefresh();
    await act(async()=>{pending.resolve(staff({canRegistration:false,canConsole:true}));});
    expect(navigation()).toEqual(['超音波控制台']);expect(container.querySelector('[data-work-page]')?.getAttribute('data-work-page')).toBe('console');
    expect(remote.rpc).toHaveBeenCalledTimes(1);expect(container.innerHTML).not.toContain(tokenA);
  });

  it('撤銷全部頁面權限後，延遲啟用成功不可復活網址或管理畫面',async()=>{
    await mount();await manage();const pending=deferred<RpcResult>();remote.rpc.mockReturnValueOnce(pending.promise);
    await click('啟用公開看板');
    expect(button('正在啟用…').disabled).toBe(true);
    remote.permissions.set('staff-1',staff({canRegistration:false}));await revoke();
    expect(container.textContent).not.toContain('受檢進度看板');expect(boardLink()).toBeNull();
    await settleRefresh();await act(async()=>{pending.resolve(result({enabled:true,token:tokenA}));});
    expect(container.textContent).toContain('此帳號目前沒有可使用的工作頁面');
    expect(navigation()).toEqual([]);expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.innerHTML).not.toContain(tokenA);expect(remote.rpc).toHaveBeenCalledTimes(2);
  });

  it('更換帳號立即移除舊網址與管理視窗，新帳號需重新開啟及讀取設定',async()=>{
    remote.rpc.mockResolvedValueOnce(result({enabled:true,token:tokenA}));
    await mount();await manage();const oldLink=boardLink()!;
    remote.permissions.set('staff-2',staff({userId:'staff-2',loginEmail:'staff-2@example.test'}));
    const pending=deferred<StaffPermissions|null>();remote.getPermissions.mockReturnValueOnce(pending.promise);
    await act(async()=>{remote.authListener?.('SIGNED_IN',auth('staff-2'));});
    expect(oldLink.isConnected).toBe(false);expect(boardLink()).toBeNull();expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.innerHTML).not.toContain(tokenA);
    await act(async()=>{pending.resolve(remote.permissions.get('staff-2')!);});
    expect(navigation()).toEqual(['健檢報到站']);expect(container.textContent).not.toContain('受檢進度看板');
    expect(remote.rpc).toHaveBeenCalledTimes(1);
    remote.rpc.mockResolvedValueOnce(result({enabled:true,token:tokenB}));await manage();
    expect(boardLink()?.href).toContain(tokenB);expect(container.innerHTML).not.toContain(tokenA);expect(remote.rpc).toHaveBeenCalledTimes(2);
  });

  it('舊帳號延遲啟用回應不得污染新帳號重新開啟的管理設定',async()=>{
    await mount();await manage();const pending=deferred<RpcResult>();remote.rpc.mockReturnValueOnce(pending.promise);
    await click('啟用公開看板');
    remote.permissions.set('staff-2',staff({userId:'staff-2',loginEmail:'staff-2@example.test'}));
    await act(async()=>{remote.authListener?.('SIGNED_IN',auth('staff-2'));});
    expect(container.querySelector('[role="dialog"]')).toBeNull();expect(boardLink()).toBeNull();
    remote.rpc.mockResolvedValueOnce(result({enabled:true,token:tokenB}));await manage();
    expect(boardLink()?.href).toContain(tokenB);
    await act(async()=>{pending.resolve(result({enabled:true,token:tokenA}));});
    expect(boardLink()?.href).toContain(tokenB);expect(container.innerHTML).not.toContain(tokenA);
    expect(button('停用公開看板').disabled).toBe(false);expect(navigation()).toEqual(['健檢報到站']);
    expect(remote.rpc.mock.calls.map(([name])=>name)).toEqual(['get_public_board_settings','set_public_board_enabled','get_public_board_settings']);
  });
});
