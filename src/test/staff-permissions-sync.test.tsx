import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {StaffPermissions} from '../types';

const remote=vi.hoisted(()=>({get:vi.fn(),channel:vi.fn(),removeChannel:vi.fn()}));
vi.mock('../lib/supabase',()=>({requireSupabase:()=>({channel:remote.channel,removeChannel:remote.removeChannel})}));
vi.mock('../features/auth/permissions',async importOriginal=>({...await importOriginal<typeof import('../features/auth/permissions')>(),getStaffPermissions:remote.get}));

import {useStaffPermissions} from '../features/auth/useStaffPermissions';

type Channel={change?:(payload?:unknown)=>void;status?:(status:string)=>void;filter?:Record<string,string>;on:ReturnType<typeof vi.fn>;subscribe:ReturnType<typeof vi.fn>};
const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
const value=(userId='worker-1',overrides:Partial<StaffPermissions>={}):StaffPermissions=>({userId,loginEmail:`${userId}@itri.example.com`,displayName:'',canRegistration:true,canConsole:true,canRoom:true,isActive:true,...overrides});
let root:Root;let container:HTMLDivElement;let channels:Channel[];let latest:ReturnType<typeof useStaffPermissions>;
function Harness({userId}:{userId:string|null}){latest=useStaffPermissions(userId);return <div>{latest.ready?'工作頁面':latest.loading?'確認權限中':latest.error||'沒有頁面權限'}</div>;}
async function render(userId:string|null='worker-1'){await act(async()=>{root.render(<Harness userId={userId}/>);});}
async function event(callback:()=>void){await act(async()=>{callback();});}

describe('登入者權限讀取與Realtime安全隔離',()=>{
  beforeEach(()=>{
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;
    remote.get.mockReset();remote.channel.mockReset();remote.removeChannel.mockReset();
    remote.get.mockResolvedValue(value());channels=[];
    remote.channel.mockImplementation(()=>{
      const channel:Channel={on:vi.fn(),subscribe:vi.fn()};
      channel.on.mockImplementation((_event:string,filter:Record<string,string>,change:(payload?:unknown)=>void)=>{channel.filter=filter;channel.change=change;return channel;});
      channel.subscribe.mockImplementation((status:(status:string)=>void)=>{channel.status=status;return channel;});
      channels.push(channel);return channel;
    });
    container=document.createElement('div');document.body.append(container);root=createRoot(container);
  });
  afterEach(async()=>{await act(async()=>{root.unmount();});container.remove();actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;});

  it('首次取得本人權限前不授權，完成才允許載入工作資料，訂閱只filter本人',async()=>{
    let resolve!:(permissions:StaffPermissions)=>void;
    remote.get.mockImplementationOnce(()=>new Promise<StaffPermissions>(yes=>{resolve=yes;}));
    await render();expect(latest.ready).toBe(false);expect(latest.loading).toBe(true);expect(latest.permissions).toBeNull();
    expect(channels[0].filter).toEqual({event:'*',schema:'public',table:'staff_permissions',filter:'user_id=eq.worker-1'});
    await event(()=>resolve(value()));
    expect(latest.ready).toBe(true);expect(latest.permissions).toEqual(value());expect(latest.error).toBe('');
  });

  it.each([null,value('worker-1',{isActive:false}),value('worker-1',{canRegistration:false,canConsole:false,canRoom:false})])('missing/disabled/none不授權但保留已完成狀態 %s',async permissions=>{
    remote.get.mockResolvedValue(permissions);await render();
    expect(latest.ready).toBe(false);expect(latest.loading).toBe(false);expect(latest.error).toBe('');expect(latest.permissions).toEqual(permissions);
  });

  it('Realtime收回權限立即停止工作access，任何payload都由DB重查而非信任payload',async()=>{
    await render();expect(latest.ready).toBe(true);
    let resolve!:(permissions:StaffPermissions)=>void;
    remote.get.mockImplementationOnce(()=>new Promise<StaffPermissions>(yes=>{resolve=yes;}));
    await event(()=>channels[0].change?.({new:{can_registration:true,can_console:true,can_room:true}}));
    expect(latest.ready).toBe(false);expect(latest.permissions).toBeNull();expect(latest.loading).toBe(true);
    await event(()=>resolve(value('worker-1',{canRegistration:false,canConsole:false,canRoom:true})));
    expect(latest.permissions?.canRegistration).toBe(false);expect(latest.ready).toBe(true);
    remote.get.mockResolvedValue(null);
    await event(()=>channels[0].change?.({eventType:'DELETE'}));expect(latest.ready).toBe(false);expect(latest.permissions).toBeNull();
  });

  it('重新整理、focus、visible、online與SUBSCRIBED皆重讀本人權限',async()=>{
    await render();remote.get.mockResolvedValue(value('worker-1',{canRoom:false}));
    await event(()=>window.dispatchEvent(new Event('focus')));expect(latest.permissions?.canRoom).toBe(false);
    await event(()=>document.dispatchEvent(new Event('visibilitychange')));
    await event(()=>window.dispatchEvent(new Event('online')));
    await event(()=>channels[0].status?.('SUBSCRIBED'));
    expect(remote.get).toHaveBeenCalledTimes(5);expect(remote.get).toHaveBeenLastCalledWith('worker-1');
    await event(()=>root.unmount());root=createRoot(container);await render();
    expect(remote.get).toHaveBeenCalledTimes(6);expect(latest.permissions?.canRoom).toBe(false);
  });

  it('DB讀取錯誤撤銷所有access且顯示友善訊息，成功refresh恢復',async()=>{
    await render();remote.get.mockRejectedValueOnce(new Error('permission_denied'));
    await act(async()=>{await latest.refresh();});
    expect(latest.ready).toBe(false);expect(latest.permissions).toBeNull();expect(latest.error).toContain('無法確認此帳號');expect(latest.error).not.toContain('permission_denied');
    await act(async()=>{await latest.refresh();});expect(latest.ready).toBe(true);
  });

  it.each(['CHANNEL_ERROR','TIMED_OUT','CLOSED'])('權限同步%s立即撤權，REST讀成功不假裝已同步，重連再確認',async status=>{
    await render();await event(()=>channels[0].status?.(status));
    expect(latest.ready).toBe(false);expect(latest.permissions).toBeNull();expect(latest.error).toContain('同步中斷');
    await event(()=>window.dispatchEvent(new Event('focus')));expect(latest.ready).toBe(false);expect(latest.error).toContain('同步中斷');
    await event(()=>channels[0].status?.('SUBSCRIBED'));expect(latest.ready).toBe(true);expect(latest.error).toBe('');
  });

  it('offline撤權，online不能消除已知斷線，subscription恢復才重授權',async()=>{
    await render();await event(()=>window.dispatchEvent(new Event('offline')));expect(latest.ready).toBe(false);
    await event(()=>window.dispatchEvent(new Event('online')));expect(latest.ready).toBe(false);
    await event(()=>channels[0].status?.('SUBSCRIBED'));expect(latest.ready).toBe(true);
  });

  it.each(['resolve','reject'] as const)('切換帳號後舊查詢延遲%s不污染新帳號',async outcome=>{
    let resolve!:(permissions:StaffPermissions)=>void;let reject!:(error:Error)=>void;
    remote.get.mockImplementationOnce(()=>new Promise<StaffPermissions>((yes,no)=>{resolve=yes;reject=no;}));
    await render();remote.get.mockResolvedValue(value('worker-2',{canRegistration:false,canConsole:false}));
    await render('worker-2');
    await event(()=>{if(outcome==='resolve')resolve(value());else reject(new Error('old failure'));});
    expect(latest.permissions).toEqual(value('worker-2',{canRegistration:false,canConsole:false}));expect(latest.error).toBe('');
    expect(remote.removeChannel).toHaveBeenCalledWith(channels[0]);
  });

  it('相同帳號較舊refresh不能覆寫後發出的最新DB結果',async()=>{
    await render();let resolve!:(permissions:StaffPermissions)=>void;
    remote.get.mockImplementationOnce(()=>new Promise<StaffPermissions>(yes=>{resolve=yes;}));
    await event(()=>channels[0].change?.());
    remote.get.mockResolvedValue(value('worker-1',{canRegistration:false,canConsole:false,canRoom:false}));
    await event(()=>channels[0].change?.());
    await event(()=>resolve(value()));expect(latest.ready).toBe(false);expect(latest.permissions?.canRoom).toBe(false);
  });

  it('舊refresh閉包不取消新帳號仍讀取中的權限query，登出不讀取不訂閱',async()=>{
    await render();const oldRefresh=latest.refresh;let resolve!:(permissions:StaffPermissions)=>void;
    remote.get.mockImplementationOnce(()=>new Promise<StaffPermissions>(yes=>{resolve=yes;}));await render('worker-2');
    await act(async()=>{await oldRefresh();});expect(remote.get).toHaveBeenCalledTimes(2);
    await event(()=>resolve(value('worker-2')));expect(latest.ready).toBe(true);expect(latest.permissions?.userId).toBe('worker-2');
    await render(null);expect(latest.permissions).toBeNull();expect(latest.ready).toBe(false);expect(latest.loading).toBe(false);
    expect(remote.get).toHaveBeenCalledTimes(2);expect(remote.channel).toHaveBeenCalledTimes(2);
  });

  it('卸載後遲到的channel事件或query回應不重新取得授權',async()=>{
    await render();const callCount=remote.get.mock.calls.length;
    await event(()=>root.unmount());root=createRoot(container);
    await event(()=>{channels[0].change?.();channels[0].status?.('SUBSCRIBED');});
    expect(remote.get).toHaveBeenCalledTimes(callCount);expect(remote.removeChannel).toHaveBeenCalledWith(channels[0]);
  });
});
