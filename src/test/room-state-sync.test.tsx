import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {RoomState} from '../types';

const remote=vi.hoisted(()=>({list:vi.fn(),count:vi.fn(),channel:vi.fn(),removeChannel:vi.fn()}));
vi.mock('../lib/supabase',()=>({requireSupabase:()=>({channel:remote.channel,removeChannel:remote.removeChannel})}));
vi.mock('../features/room/service',()=>({listRooms:remote.list,getSessionRoomCount:remote.count}));

import {useRoomStates} from '../features/room/useRoomStates';

type Channel={change?:()=>void;sessionChange?:(payload:{eventType:string;new:{room_count?:number|null}})=>void;status?:(status:string)=>void;filter?:Record<string,string>;on:ReturnType<typeof vi.fn>;subscribe:ReturnType<typeof vi.fn>};
const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
const states=(sessionId='session-1',status:RoomState['status']='idle'):RoomState[]=>[{sessionId,roomId:'診間 1',status,updatedAt:'2026-10-07T02:00:00Z'}];
let root:Root;
let container:HTMLDivElement;
let channels:Channel[];
let latest:ReturnType<typeof useRoomStates>;

function Harness({sessionId,roomCount}:{sessionId:string|null;roomCount?:number|null}){latest=useRoomStates(sessionId,roomCount);return <div>{latest.loading?'讀取中':latest.error||latest.rooms.map(room=>room.status).join(',')}</div>;}
async function render(sessionId:string|null='session-1',roomCount?:number|null){await act(async()=>{root.render(<Harness sessionId={sessionId} roomCount={roomCount}/>);});}
async function event(callback:()=>void){await act(async()=>{callback();});}

describe('診間房態即時同步與隔離',()=>{
  beforeEach(()=>{
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;
    remote.list.mockReset();remote.count.mockReset();remote.channel.mockReset();remote.removeChannel.mockReset();
    remote.list.mockResolvedValue(states());
    remote.count.mockResolvedValue(4);
    channels=[];
    remote.channel.mockImplementation(()=>{
      const channel:Channel={on:vi.fn(),subscribe:vi.fn()};
      channel.on.mockImplementation((_event:string,filter:Record<string,string>,change:()=>void)=>{if(filter.table==='health_sessions')channel.sessionChange=change;else{channel.filter=filter;channel.change=change;}return channel;});
      channel.subscribe.mockImplementation((status:(status:string)=>void)=>{channel.status=status;return channel;});
      channels.push(channel);
      return channel;
    });
    container=document.createElement('div');document.body.append(container);root=createRoot(container);
  });
  afterEach(async()=>{await act(async()=>{root.unmount();});container.remove();actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;});

  it('重新掛載或重新整理後從雲端取得away，以session filter訂閱rooms',async()=>{
    remote.list.mockResolvedValue(states('session-1','away'));
    await render();
    expect(latest.rooms[0].status).toBe('away');expect(latest.error).toBe('');
    expect(channels[0].filter).toEqual({event:'*',schema:'public',table:'rooms',filter:'session_id=eq.session-1'});
    await event(()=>{root.unmount();});
    root=createRoot(container);
    await render();
    expect(latest.rooms[0].status).toBe('away');
    expect(remote.list).toHaveBeenCalledTimes(2);
    expect(remote.removeChannel).toHaveBeenCalledWith(channels[0]);
  });

  it('其他平板realtime事件與返回診間會更新房態，focus及online也重讀',async()=>{
    await render();
    remote.list.mockResolvedValue(states('session-1','away'));
    await event(()=>channels[0].change?.());expect(latest.rooms[0].status).toBe('away');
    remote.list.mockResolvedValue(states('session-1','idle'));
    await event(()=>channels[0].change?.());expect(latest.rooms[0].status).toBe('idle');
    await event(()=>window.dispatchEvent(new Event('focus')));
    await event(()=>window.dispatchEvent(new Event('online')));
    expect(remote.list).toHaveBeenCalledTimes(5);
  });

  it('雲端讀取失敗將房態清為unknown，refresh回報錯誤且可重試',async()=>{
    remote.list.mockRejectedValueOnce(new Error('network failure'));
    await render();expect(latest.rooms).toEqual([]);expect(latest.error).toContain('無法確認診間狀態');expect(latest.loading).toBe(false);
    await act(async()=>{await latest.refresh();});expect(latest.rooms[0].status).toBe('idle');
    remote.list.mockRejectedValueOnce(new Error('network failure'));
    await act(async()=>{await expect(latest.refresh()).rejects.toThrow('network failure');});
    expect(latest.rooms).toEqual([]);
  });

  it('訂閱中斷後REST成功亦不假裝已同步，必須SUBSCRIBED重連才恢復',async()=>{
    await render();
    await event(()=>channels[0].status?.('CHANNEL_ERROR'));
    expect(latest.rooms).toEqual([]);expect(latest.error).toContain('同步中斷');
    await event(()=>window.dispatchEvent(new Event('focus')));
    expect(latest.rooms).toEqual([]);expect(latest.error).toContain('同步中斷');
    await act(async()=>{await expect(latest.refresh()).rejects.toThrow('room_sync_disconnected');});
    remote.list.mockResolvedValue(states('session-1','away'));
    await event(()=>channels[0].status?.('SUBSCRIBED'));
    expect(latest.rooms[0].status).toBe('away');expect(latest.error).toBe('');
  });

  it('offline立即使房態unknown，online讀取不得清掉斷線狀態',async()=>{
    await render();
    await event(()=>window.dispatchEvent(new Event('offline')));
    expect(latest.rooms).toEqual([]);expect(latest.error).toContain('同步中斷');
    await event(()=>window.dispatchEvent(new Event('online')));
    expect(latest.rooms).toEqual([]);expect(latest.error).toContain('同步中斷');
    await event(()=>channels[0].status?.('SUBSCRIBED'));
    expect(latest.rooms[0].status).toBe('idle');
  });

  it.each(['resolve','reject'] as const)('切换場次後舊查詢延遲%s不污染新場次',async outcome=>{
    let resolve!:(value:RoomState[])=>void;let reject!:(error:Error)=>void;
    remote.list.mockImplementationOnce(()=>new Promise<RoomState[]>((yes,no)=>{resolve=yes;reject=no;}));
    await render();expect(latest.loading).toBe(true);
    remote.list.mockResolvedValue(states('session-2','away'));
    await render('session-2');
    await event(()=>{if(outcome==='resolve')resolve(states('session-1'));else reject(new Error('old failure'));});
    expect(latest.rooms).toEqual(states('session-2','away'));expect(latest.error).toBe('');
    expect(remote.removeChannel).toHaveBeenCalledWith(channels[0]);
  });

  it('舊refresh閉包不會取消新場次仍在讀取的request',async()=>{
    await render();const oldRefresh=latest.refresh;
    let resolve!:(value:RoomState[])=>void;
    remote.list.mockImplementationOnce(()=>new Promise<RoomState[]>(yes=>{resolve=yes;}));
    await render('session-2');expect(latest.loading).toBe(true);
    await act(async()=>{await oldRefresh();});
    expect(remote.list).toHaveBeenCalledTimes(2);
    await event(()=>resolve(states('session-2','away')));
    expect(latest.rooms).toEqual(states('session-2','away'));expect(latest.loading).toBe(false);
  });

  it('相同場次同時刷新時只採用最後發出的query，舊realtime不得覆盖',async()=>{
    await render();let resolve!:(value:RoomState[])=>void;
    remote.list.mockImplementationOnce(()=>new Promise<RoomState[]>(yes=>{resolve=yes;}));
    await event(()=>channels[0].change?.());
    remote.list.mockResolvedValue(states('session-1','away'));
    await event(()=>channels[0].change?.());
    await event(()=>resolve(states()));
    expect(latest.rooms[0].status).toBe('away');
  });

  it('成功RPC的房態取代同診間snapshot且取消較早尚未返回的query',async()=>{
    await render();let resolve!:(value:RoomState[])=>void;
    remote.list.mockImplementationOnce(()=>new Promise<RoomState[]>(yes=>{resolve=yes;}));
    await event(()=>channels[0].change?.());
    await event(()=>latest.acceptRoom(states('session-1','away')[0]));
    expect(latest.rooms[0].status).toBe('away');expect(latest.loading).toBe(false);
    await event(()=>resolve(states()));
    expect(latest.rooms[0].status).toBe('away');
    await event(()=>latest.acceptRoom(states('other-session')[0]));
    expect(latest.rooms[0].status).toBe('away');
  });

  it('acceptRoom保留其他診間及syncError，後續重新讀取仍由雲端決定',async()=>{
    remote.list.mockResolvedValue([...states(),{...states()[0],roomId:'診間 2',status:'in_progress'}]);
    await render();
    await event(()=>latest.acceptRoom(states('session-1','away')[0]));
    expect(latest.rooms.map(room=>room.status)).toEqual(['away','in_progress']);
    await event(()=>channels[0].status?.('CHANNEL_ERROR'));
    await event(()=>latest.acceptRoom(states('session-1','away')[0]));
    expect(latest.rooms[0].status).toBe('away');expect(latest.error).toContain('同步中斷');
    remote.list.mockResolvedValue(states());
    await event(()=>channels[0].status?.('SUBSCRIBED'));
    expect(latest.rooms).toEqual(states());expect(latest.error).toBe('');
  });

  it('未選場次不讀雲端且不訂閱',async()=>{
    await render(null);expect(latest.rooms).toEqual([]);expect(latest.loading).toBe(false);
    expect(remote.list).not.toHaveBeenCalled();expect(remote.channel).not.toHaveBeenCalled();
  });

  it('只接受有效診間RPC，切換不同數量場次與重新掛載都讀取持久化設定',async()=>{
    remote.count.mockResolvedValue(3);
    remote.list.mockResolvedValue([...states(),{...states()[0],roomId:'診間 4',status:'away'}]);
    await render('session-1',3);
    expect(latest.roomCount).toBe(3);expect(latest.rooms.map(room=>room.roomId)).toEqual(['診間 1']);
    await event(()=>latest.acceptRoom({...states()[0],roomId:'room_4',status:'in_progress'}));
    expect(latest.rooms.map(room=>room.roomId)).toEqual(['診間 1']);
    await event(()=>latest.acceptRoom({...states()[0],roomId:'room_3',status:'away'}));
    expect(latest.rooms.at(-1)).toMatchObject({roomId:'診間 3',status:'away'});
    remote.count.mockResolvedValue(2);remote.list.mockResolvedValue(states('session-2'));
    await render('session-2',2);expect(latest.roomCount).toBe(2);expect(remote.list).toHaveBeenLastCalledWith('session-2',2);
    await event(()=>root.unmount());root=createRoot(container);
    await render('session-2',2);expect(latest.roomCount).toBe(2);expect(remote.count).toHaveBeenLastCalledWith('session-2');
  });

  it('其他平板修改場次數量的Realtime事件同步房號，減少後排除保留的舊row',async()=>{
    await render();
    const expanded=[...states('session-1','away'),{...states()[0],roomId:'診間 5'},{...states()[0],roomId:'診間 6'}];
    remote.count.mockResolvedValue(6);remote.list.mockResolvedValue(expanded);
    await event(()=>channels[0].sessionChange?.({eventType:'UPDATE',new:{room_count:6}}));
    expect(latest.roomCount).toBe(6);expect(latest.rooms).toEqual(expanded);expect(latest.rooms[0].status).toBe('away');
    remote.count.mockResolvedValue(4);
    await event(()=>channels[0].sessionChange?.({eventType:'UPDATE',new:{room_count:4}}));
    expect(latest.roomCount).toBe(4);expect(latest.rooms).toEqual(states('session-1','away'));
  });

  it('漏掉數量事件後重新連線仍重新讀取雲端6間，focus也可恢復新數量',async()=>{
    await render('session-1',4);
    await event(()=>channels[0].status?.('CHANNEL_ERROR'));
    remote.count.mockResolvedValue(6);remote.list.mockResolvedValue([...states(),{...states()[0],roomId:'診間 6'}]);
    await event(()=>channels[0].status?.('SUBSCRIBED'));
    expect(latest.roomCount).toBe(6);expect(latest.rooms.at(-1)?.roomId).toBe('診間 6');expect(latest.error).toBe('');
    remote.count.mockResolvedValue(2);
    await event(()=>window.dispatchEvent(new Event('focus')));
    expect(latest.roomCount).toBe(2);expect(latest.rooms).toEqual(states());
  });

  it('雲端count讀取失敗即使已有room snapshot也清為unknown',async()=>{
    await render();
    remote.count.mockRejectedValueOnce(new Error('count offline'));
    await act(async()=>{await expect(latest.refresh()).rejects.toThrow('count offline');});
    expect(latest.rooms).toEqual([]);expect(latest.error).toContain('無法確認診間狀態');
  });

  it('舊場次count讀取延遲返回不得覆蓋新場次房號設定',async()=>{
    let resolve!:(count:number)=>void;
    remote.count.mockImplementationOnce(()=>new Promise<number>(yes=>{resolve=yes;}));
    await render('session-1',4);
    remote.count.mockResolvedValue(2);remote.list.mockResolvedValue(states('session-2','away'));
    await render('session-2',2);
    await event(()=>resolve(8));
    expect(latest.roomCount).toBe(2);expect(latest.rooms).toEqual(states('session-2','away'));
    expect(remote.list).toHaveBeenCalledTimes(1);expect(remote.list).toHaveBeenCalledWith('session-2',2);
  });
});
