import {act,StrictMode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {RoomState} from '../types';

const remote=vi.hoisted(()=>({list:vi.fn(),count:vi.fn(),channel:vi.fn(),removeChannel:vi.fn()}));
vi.mock('../lib/supabase',()=>({requireSupabase:()=>({channel:remote.channel,removeChannel:remote.removeChannel})}));
vi.mock('../features/room/service',()=>({listRooms:remote.list,getSessionRoomCount:remote.count}));

import {useRoomStates} from '../features/room/useRoomStates';
import {roomStatusDotClasses} from '../features/room/status';

type Change={eventType?:string;new?:Record<string,unknown>;old?:Record<string,unknown>};
type Channel={change?:(payload?:Change)=>void;sessionChange?:(payload:Change)=>void;status?:(status:string)=>void;filter?:Record<string,string>;on:ReturnType<typeof vi.fn>;subscribe:ReturnType<typeof vi.fn>};
const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
const states=(sessionId='session-1',status:RoomState['status']='idle'):RoomState[]=>[{sessionId,roomId:'診間 1',status,updatedAt:'2026-10-07T02:00:00Z'}];
let root:Root;
let container:HTMLDivElement;
let channels:Channel[];
let latest:ReturnType<typeof useRoomStates>;
let renders:number;

function Harness({sessionId,roomCount}:{sessionId:string|null;roomCount?:number|null}){renders++;latest=useRoomStates(sessionId,roomCount);return <div>{latest.loading?'讀取中':latest.error||latest.rooms.map(room=><span key={room.roomId} className={roomStatusDotClasses[room.status]}>{room.status}</span>)}</div>;}
async function render(sessionId:string|null='session-1',roomCount?:number|null){await act(async()=>{root.render(<Harness sessionId={sessionId} roomCount={roomCount}/>);});}
async function event(callback:()=>void,flush=true){await act(async()=>{callback();if(flush)await vi.advanceTimersByTimeAsync(100);});}
const payload=(room:RoomState,eventType='UPDATE'):Change=>({eventType,new:{session_id:room.sessionId,room_id:room.roomId,status:room.status,updated_at:room.updatedAt}});

describe('診間房態即時同步與隔離',()=>{
  beforeEach(()=>{
    vi.useFakeTimers();renders=0;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;
    remote.list.mockReset();remote.count.mockReset();remote.channel.mockReset();remote.removeChannel.mockReset();
    remote.list.mockResolvedValue(states());
    remote.count.mockResolvedValue(4);
    channels=[];
    remote.channel.mockImplementation(()=>{
      const channel:Channel={on:vi.fn(),subscribe:vi.fn()};
      channel.on.mockImplementation((_event:string,filter:Record<string,string>,change:(payload?:Change)=>void)=>{if(filter.table==='health_sessions')channel.sessionChange=change;else{channel.filter=filter;channel.change=change;}return channel;});
      channel.subscribe.mockImplementation((status:(status:string)=>void)=>{channel.status=status;return channel;});
      channels.push(channel);
      return channel;
    });
    container=document.createElement('div');document.body.append(container);root=createRoot(container);
  });
  afterEach(async()=>{await act(async()=>{root.unmount();});container.remove();vi.useRealTimers();actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;});

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

  it.each([
    {message:'permission denied for table rooms',code:'42501'},
    {message:'permission_denied',code:'P0001'},
    {message:'not_authorized',code:'P0001'},
  ])('房態查詢被RLS或RPC拒絕時清除房態且顯示權限中文 %s',async error=>{
    await render();remote.list.mockRejectedValueOnce(error);
    await act(async()=>{await expect(latest.refresh()).rejects.toEqual(error);});
    expect(latest.rooms).toEqual([]);expect(latest.error).toBe('此帳號沒有執行此功能的權限。');
    expect(latest.loading).toBe(false);
  });

  it('場次診間數量RLS讀取被拒絕時不使用快取資料或繼續載房態',async()=>{
    await render();const queries=remote.list.mock.calls.length;
    const error={message:'permission denied for table health_sessions',code:'42501'};
    remote.count.mockRejectedValueOnce(error);
    await act(async()=>{await expect(latest.refresh()).rejects.toEqual(error);});
    expect(latest.rooms).toEqual([]);expect(latest.error).toBe('此帳號沒有執行此功能的權限。');
    expect(remote.list).toHaveBeenCalledTimes(queries);
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

  it('相同場次在途read後接Realtime刷新，最後保留更新後的房態',async()=>{
    await render();let resolve!:(value:RoomState[])=>void;
    remote.list.mockImplementationOnce(()=>new Promise<RoomState[]>(yes=>{resolve=yes;}));
    await event(()=>channels[0].change?.());
    remote.list.mockResolvedValue(states('session-1','away'));
    await event(()=>channels[0].change?.());
    await event(()=>resolve(states()));
    expect(latest.rooms[0].status).toBe('away');
  });

  it('成功RPC的房態取代同診間snapshot，較早read返回仍保留該patch',async()=>{
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

  it('4個heartbeat只改租約，不重查count/rooms也不重複render房態',async()=>{
    await render();remote.list.mockClear();remote.count.mockClear();const before=renders;
    await event(()=>{
      for(let index=0;index<4;index++)channels[0].change?.({...payload(states()[0]),old:payload(states()[0]).new,new:{...payload(states()[0]).new,claim_expires_at:`2026-10-07T02:0${index}:00Z`,claimed_by_device_id:'device-1'}});
    });
    expect(remote.count).not.toHaveBeenCalled();expect(remote.list).not.toHaveBeenCalled();
    expect(renders).toBe(before);expect(latest.rooms).toEqual(states());
  });

  it('健康Realtime在暫時REST讀取失敗後觸發完整恢復，單row先保留錯誤',async()=>{
    remote.list.mockRejectedValueOnce(new Error('temporary read failure'));
    await render();expect(latest.rooms).toEqual([]);expect(latest.error).toContain('無法確認診間狀態');
    remote.count.mockClear();remote.list.mockClear();
    const changed={...states('session-1','away')[0],updatedAt:'2026-10-07T02:00:01Z'};
    const recovered=[changed,{...states('session-1','in_progress')[0],roomId:'診間 2'}];
    remote.list.mockResolvedValue(recovered);
    await event(()=>channels[0].change?.(payload(changed)),false);
    expect(latest.error).toContain('無法確認診間狀態');expect(remote.list).not.toHaveBeenCalled();
    await event(()=>{});
    expect(remote.count).toHaveBeenCalledTimes(1);expect(remote.list).toHaveBeenCalledTimes(1);
    expect(latest.rooms).toEqual(recovered);expect(latest.error).toBe('');expect(latest.loading).toBe(false);
    remote.count.mockClear();remote.list.mockClear();
    await event(()=>channels[0].change?.({...payload(changed),old:payload(changed).new}));
    expect(remote.count).not.toHaveBeenCalled();expect(remote.list).not.toHaveBeenCalled();
  });

  it('已知訂閱斷線時單rowpayload保留同步錯誤，不自行REST恢復',async()=>{
    await render();await event(()=>channels[0].status?.('CHANNEL_ERROR'));
    remote.count.mockClear();remote.list.mockClear();
    await event(()=>channels[0].change?.(payload({...states('session-1','away')[0],updatedAt:'2026-10-07T02:00:01Z'})));
    expect(latest.error).toContain('同步中斷');expect(remote.count).not.toHaveBeenCalled();expect(remote.list).not.toHaveBeenCalled();
  });

  it('有效Realtime房態直接更新紅綠黃燈，無需任何REST且不等待100ms',async()=>{
    await render();remote.list.mockClear();remote.count.mockClear();const started=Date.now();
    for(const[status,seconds]of [['in_progress',1],['away',2],['idle',3]] as const){
      const room={...states('session-1',status)[0],updatedAt:`2026-10-07T02:00:0${seconds}Z`};
      await event(()=>channels[0].change?.(payload(room)),false);
      expect(latest.rooms[0]).toEqual(room);expect(container.querySelector('span')?.className).toBe(roomStatusDotClasses[status]);
    }
    expect(Date.now()-started).toBe(0);expect(remote.count).not.toHaveBeenCalled();expect(remote.list).not.toHaveBeenCalled();
  });

  it('missed away事件可由相同old/new房態的heartbeat直接補正，仍為0query',async()=>{
    await render();remote.list.mockClear();remote.count.mockClear();
    const room={...states('session-1','away')[0],updatedAt:'2026-10-07T02:00:01Z'};
    await event(()=>channels[0].change?.({...payload(room),old:payload(room).new}));
    expect(latest.rooms[0]).toEqual(room);expect(remote.count).not.toHaveBeenCalled();expect(remote.list).not.toHaveBeenCalled();
  });

  it('場次metadata與相同room_count不觸發全量房態查詢',async()=>{
    await render();remote.list.mockClear();remote.count.mockClear();const before=renders;
    await event(()=>{
      channels[0].sessionChange?.({eventType:'UPDATE',new:{id:'session-1',room_count:4,company_name:'改名'}});
      channels[0].sessionChange?.({eventType:'UPDATE',new:{id:'session-1',room_count:4,status:'closing'}});
    });
    expect(remote.count).not.toHaveBeenCalled();expect(remote.list).not.toHaveBeenCalled();expect(renders).toBe(before);
  });

  it('同burst增加房號多個事件與prop同步只讀count+rooms一次，不重新訂閱',async()=>{
    await render('session-1',4);remote.list.mockClear();remote.count.mockClear();
    remote.count.mockResolvedValue(6);
    const expanded=[...states(),{...states()[0],roomId:'診間 5'},{...states()[0],roomId:'診間 6'}];
    remote.list.mockResolvedValue(expanded);
    await event(()=>{
      channels[0].sessionChange?.({eventType:'UPDATE',new:{id:'session-1',room_count:5}});
      channels[0].sessionChange?.({eventType:'UPDATE',new:{id:'session-1',room_count:6}});
      channels[0].sessionChange?.({eventType:'UPDATE',new:{id:'session-1',room_count:6}});
    },false);
    await render('session-1',6);
    await event(()=>{});
    expect(remote.count).toHaveBeenCalledTimes(1);expect(remote.list).toHaveBeenCalledTimes(1);
    expect(remote.channel).toHaveBeenCalledTimes(1);expect(latest.roomCount).toBe(6);expect(latest.rooms).toEqual(expanded);
  });

  it('focus+visible+online+reconnect同burst只做一次count+rooms安全刷新',async()=>{
    await render();await event(()=>channels[0].status?.('CHANNEL_ERROR'));
    remote.list.mockClear();remote.count.mockClear();remote.list.mockResolvedValue(states('session-1','away'));
    const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
    try{
      await event(()=>{
        window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));
        document.dispatchEvent(new Event('visibilitychange'));channels[0].status?.('SUBSCRIBED');
      });
      expect(remote.count).toHaveBeenCalledTimes(1);expect(remote.list).toHaveBeenCalledTimes(1);
      expect(latest.rooms[0].status).toBe('away');expect(latest.error).toBe('');
    }finally{visibility.mockRestore();}
  });

  it('focus與一般SUBSCRIBED共用同scope在途read，不建立第二個相同查詢',async()=>{
    await render();remote.list.mockClear();remote.count.mockClear();
    let resolve!:(rooms:RoomState[])=>void;let reading!:Promise<void>;
    remote.list.mockImplementationOnce(()=>new Promise<RoomState[]>(yes=>{resolve=yes;}));
    await event(()=>{reading=latest.refresh();},false);
    await event(()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));channels[0].status?.('SUBSCRIBED');});
    expect(remote.count).toHaveBeenCalledTimes(1);expect(remote.list).toHaveBeenCalledTimes(1);
    await act(async()=>{resolve(states('session-1','away'));await reading;});
    expect(latest.rooms[0].status).toBe('away');expect(remote.list).toHaveBeenCalledTimes(1);
  });

  it('未知、malformed與DELETE房態同burst安全fallback一次，其他場次與範圍外不重讀',async()=>{
    await render();remote.list.mockClear();remote.count.mockClear();
    await event(()=>{
      channels[0].change?.(payload(states('other-session','away')[0]));
      channels[0].change?.(payload({...states()[0],roomId:'診間 7',status:'away'}));
    });
    expect(remote.list).not.toHaveBeenCalled();
    remote.list.mockResolvedValue(states('session-1','away'));
    await event(()=>{
      channels[0].change?.();
      channels[0].change?.({eventType:'UPDATE',new:{session_id:'session-1',room_id:'診間 1',status:'invalid',updated_at:'broken'}});
      channels[0].change?.({eventType:'DELETE',old:{session_id:'session-1',room_id:'診間 1'}});
    });
    expect(remote.count).toHaveBeenCalledTimes(1);expect(remote.list).toHaveBeenCalledTimes(1);expect(latest.rooms[0].status).toBe('away');
  });

  it('initial read期間單診間patch保持loading，最後合併其他房且不丟掉最新狀態',async()=>{
    let resolve!:(rooms:RoomState[])=>void;
    remote.list.mockImplementationOnce(()=>new Promise<RoomState[]>(yes=>{resolve=yes;}));
    await render();expect(latest.loading).toBe(true);
    const room={...states('session-1','in_progress')[0],updatedAt:'2026-10-07T02:00:01Z'};
    await event(()=>channels[0].change?.(payload(room)),false);
    expect(latest.rooms).toEqual([room]);expect(latest.loading).toBe(true);
    const other={...states('session-1','away')[0],roomId:'診間 2'};
    await event(()=>resolve([...states(),other]));
    expect(latest.rooms).toEqual([room,other]);expect(latest.loading).toBe(false);
    expect(remote.count).toHaveBeenCalledTimes(1);expect(remote.list).toHaveBeenCalledTimes(1);
  });

  it('mutation在full read期間發生時只接一個trailing read，保留最後rows',async()=>{
    await render();remote.list.mockClear();remote.count.mockClear();
    let resolve!:(rooms:RoomState[])=>void;let first!:Promise<void>;let second!:Promise<void>;
    remote.list.mockImplementationOnce(()=>new Promise<RoomState[]>(yes=>{resolve=yes;}));
    await event(()=>{first=latest.refresh();},false);
    const changed=[...states('session-1','away'),{...states()[0],roomId:'診間 2',status:'in_progress' as const}];
    remote.list.mockResolvedValue(changed);
    await event(()=>{
      second=latest.refresh();
      channels[0].change?.({eventType:'UPDATE',new:{session_id:'session-1'}});
      channels[0].change?.();
    });
    expect(second).toBe(first);expect(remote.list).toHaveBeenCalledTimes(1);
    await act(async()=>{resolve(states());await first;});
    expect(remote.count).toHaveBeenCalledTimes(2);expect(remote.list).toHaveBeenCalledTimes(2);expect(latest.rooms).toEqual(changed);
  });

  it('count read在數量更新之前開始也不會回退最新room_count，trailing最後補齊新房',async()=>{
    await render();remote.list.mockClear();remote.count.mockClear();
    let resolve!:(value:number)=>void;let reading!:Promise<void>;
    remote.count.mockImplementationOnce(()=>new Promise<number>(yes=>{resolve=yes;}));
    await event(()=>{reading=latest.refresh();},false);
    remote.count.mockResolvedValue(6);
    const expanded=[...states(),{...states()[0],roomId:'診間 6'}];remote.list.mockResolvedValue(expanded);
    await event(()=>channels[0].sessionChange?.({eventType:'UPDATE',new:{id:'session-1',room_count:6}}));
    expect(latest.roomCount).toBe(6);
    await act(async()=>{resolve(4);await reading;});
    expect(latest.roomCount).toBe(6);expect(latest.rooms).toEqual(expanded);
    expect(remote.list).toHaveBeenLastCalledWith('session-1',6);expect(remote.count).toHaveBeenCalledTimes(2);
  });

  it('同時收到舊場次DELETE不會把目前場次房態標為unavailable',async()=>{
    await render();remote.list.mockClear();remote.count.mockClear();
    await event(()=>channels[0].sessionChange?.({eventType:'DELETE',old:{id:'other-session'},new:{}}));
    expect(latest.rooms).toEqual(states());expect(latest.error).toBe('');expect(remote.list).not.toHaveBeenCalled();expect(remote.count).not.toHaveBeenCalled();
  });

  it('斷線invalidate在途read後重連必須有新read，舊response不讓房態永久unknown',async()=>{
    let resolve!:(rooms:RoomState[])=>void;
    remote.list.mockImplementationOnce(()=>new Promise<RoomState[]>(yes=>{resolve=yes;}));
    await render();await event(()=>channels[0].status?.('CHANNEL_ERROR'));
    remote.list.mockResolvedValue(states('session-1','away'));
    await event(()=>channels[0].status?.('SUBSCRIBED'));
    expect(latest.rooms).toEqual([]);
    await event(()=>resolve(states()));
    expect(latest.rooms).toEqual(states('session-1','away'));expect(latest.error).toBe('');
    expect(remote.count).toHaveBeenCalledTimes(2);expect(remote.list).toHaveBeenCalledTimes(2);
  });

  it('React StrictMode重設effect後不共用已dispose的controller',async()=>{
    await act(async()=>root.render(<StrictMode><Harness sessionId="session-1"/></StrictMode>));
    expect(latest.loading).toBe(false);expect(latest.rooms).toEqual(states());
    await event(()=>channels.at(-1)?.change?.(payload({...states('session-1','away')[0],updatedAt:'2026-10-07T02:00:01Z'})),false);
    expect(latest.rooms[0].status).toBe('away');expect(remote.removeChannel).toHaveBeenCalledWith(channels[0]);
  });
});
