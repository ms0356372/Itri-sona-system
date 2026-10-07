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
async function advance(ms=100){await act(async()=>{await vi.advanceTimersByTimeAsync(ms);});}

describe('登入者權限讀取與Realtime安全隔離',()=>{
  beforeEach(()=>{
    vi.useFakeTimers();
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
  afterEach(async()=>{await act(async()=>{root.unmount();});container.remove();vi.useRealTimers();actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;});

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
    await advance();
    await event(()=>resolve(value('worker-1',{canRegistration:false,canConsole:false,canRoom:true})));
    expect(latest.permissions?.canRegistration).toBe(false);expect(latest.ready).toBe(true);
    remote.get.mockResolvedValue(null);
    await event(()=>channels[0].change?.({eventType:'DELETE'}));expect(latest.ready).toBe(false);expect(latest.permissions).toBeNull();
    await advance();expect(latest.loading).toBe(false);
  });

  it('重新整理、focus、visible、online與SUBSCRIBED皆重讀本人權限',async()=>{
    await render();remote.get.mockResolvedValue(value('worker-1',{canRoom:false}));
    await event(()=>window.dispatchEvent(new Event('focus')));await advance();expect(latest.permissions?.canRoom).toBe(false);
    await event(()=>document.dispatchEvent(new Event('visibilitychange')));await advance();
    await event(()=>window.dispatchEvent(new Event('online')));await advance();
    await event(()=>channels[0].status?.('SUBSCRIBED'));await advance();
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
    await event(()=>window.dispatchEvent(new Event('focus')));await advance();expect(latest.ready).toBe(false);expect(latest.error).toContain('同步中斷');
    await event(()=>channels[0].status?.('SUBSCRIBED'));await advance();expect(latest.ready).toBe(true);expect(latest.error).toBe('');
  });

  it('offline撤權，online不能消除已知斷線，subscription恢復才重授權',async()=>{
    await render();await event(()=>window.dispatchEvent(new Event('offline')));expect(latest.ready).toBe(false);
    await event(()=>window.dispatchEvent(new Event('online')));await advance();expect(latest.ready).toBe(false);
    await event(()=>channels[0].status?.('SUBSCRIBED'));await advance();expect(latest.ready).toBe(true);
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
    await advance();
    remote.get.mockResolvedValue(value('worker-1',{canRegistration:false,canConsole:false,canRoom:false}));
    await event(()=>channels[0].change?.());
    await event(()=>resolve(value()));expect(latest.ready).toBe(false);expect(latest.permissions).toBeNull();
    await advance();expect(latest.ready).toBe(false);expect(latest.permissions?.canRoom).toBe(false);
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

  it('同帳號初始讀取中focus、visible、online、SUBSCRIBED與public refresh共用一個promise及一筆查詢',async()=>{
    let resolve!:(permissions:StaffPermissions)=>void;
    remote.get.mockImplementationOnce(()=>new Promise<StaffPermissions>(yes=>{resolve=yes;}));
    await render();let first!:Promise<void>;let second!:Promise<void>;
    await event(()=>{
      first=latest.refresh();second=latest.refresh();
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('online'));
      channels[0].status?.('SUBSCRIBED');
    });
    expect(first).toBe(second);await advance();
    expect(remote.get).toHaveBeenCalledTimes(1);expect(latest.ready).toBe(false);
    await act(async()=>{resolve(value());await first;});
    expect(latest.ready).toBe(true);expect(remote.get).toHaveBeenCalledTimes(1);
  });

  it('focus與visible等短時間事件聚合一次權限查詢，聚合等待期間仍立即撤下工作access',async()=>{
    await render();remote.get.mockResolvedValue(value('worker-1',{canRoom:false}));
    await event(()=>{
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('online'));
      channels[0].status?.('SUBSCRIBED');
    });
    expect(latest.ready).toBe(false);expect(latest.permissions).toBeNull();expect(remote.get).toHaveBeenCalledTimes(1);
    await advance(99);expect(remote.get).toHaveBeenCalledTimes(1);
    await advance(1);expect(remote.get).toHaveBeenCalledTimes(2);expect(latest.ready).toBe(true);expect(latest.permissions?.canRoom).toBe(false);
  });

  it('同一交易多個Realtime權限事件當場failclosed，100ms後僅讀一次最新資料',async()=>{
    await render();remote.get.mockResolvedValue(value('worker-1',{isActive:false}));
    await event(()=>{for(let index=0;index<4;index++)channels[0].change?.({new:{is_active:true}});});
    expect(latest.ready).toBe(false);expect(latest.permissions).toBeNull();expect(remote.get).toHaveBeenCalledTimes(1);
    await advance();expect(remote.get).toHaveBeenCalledTimes(2);expect(latest.permissions?.isActive).toBe(false);expect(latest.ready).toBe(false);
  });

  it('Realtime在權限查詢中到達只追加一次新讀，舊全權限結果在最新確認前絕不可顯示',async()=>{
    let resolveOld!:(permissions:StaffPermissions)=>void;let resolveLatest!:(permissions:StaffPermissions)=>void;
    remote.get.mockImplementationOnce(()=>new Promise<StaffPermissions>(yes=>{resolveOld=yes;}));
    remote.get.mockImplementationOnce(()=>new Promise<StaffPermissions>(yes=>{resolveLatest=yes;}));
    await render();
    await event(()=>{for(let index=0;index<3;index++)channels[0].change?.({new:{can_room:false}});});
    await advance();expect(remote.get).toHaveBeenCalledTimes(1);
    await event(()=>resolveOld(value()));
    expect(remote.get).toHaveBeenCalledTimes(2);expect(latest.ready).toBe(false);expect(latest.loading).toBe(true);expect(latest.permissions).toBeNull();
    await event(()=>resolveLatest(value('worker-1',{canRegistration:false,canConsole:false,canRoom:false})));
    expect(latest.ready).toBe(false);expect(latest.permissions?.canRoom).toBe(false);expect(remote.get).toHaveBeenCalledTimes(2);
  });

  it('Realtime聚合尚未送出即切換帳號或卸載，舊timer不發query也不污染新帳號',async()=>{
    await render();await event(()=>channels[0].change?.());
    remote.get.mockResolvedValue(value('worker-2',{canRegistration:false,canConsole:false}));
    await render('worker-2');await advance();
    expect(remote.get.mock.calls.map(([id])=>id)).toEqual(['worker-1','worker-2']);expect(latest.permissions?.userId).toBe('worker-2');
    await event(()=>channels[1].change?.());await event(()=>root.unmount());root=createRoot(container);await advance();
    expect(remote.get).toHaveBeenCalledTimes(2);
  });

  it('舊權限讀取期間離線再focus不會卡在loading，重連必須重新确认才授權',async()=>{
    let resolveOld!:(permissions:StaffPermissions)=>void;
    remote.get.mockImplementationOnce(()=>new Promise<StaffPermissions>(yes=>{resolveOld=yes;}));
    await render();await event(()=>window.dispatchEvent(new Event('offline')));
    expect(latest.error).toContain('同步中斷');expect(latest.ready).toBe(false);
    await event(()=>window.dispatchEvent(new Event('focus')));await advance();
    await event(()=>resolveOld(value()));
    expect(remote.get).toHaveBeenCalledTimes(2);expect(latest.loading).toBe(false);expect(latest.error).toContain('同步中斷');expect(latest.ready).toBe(false);
    await event(()=>channels[0].status?.('SUBSCRIBED'));await advance();
    expect(remote.get).toHaveBeenCalledTimes(3);expect(latest.ready).toBe(true);
  });
});
