import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {RoomClaim} from '../features/room/claims';

const remote=vi.hoisted(()=>({list:vi.fn(),claim:vi.fn(),switch:vi.fn(),heartbeat:vi.fn(),release:vi.fn(),channel:vi.fn(),removeChannel:vi.fn()}));
vi.mock('../lib/supabase',()=>({requireSupabase:()=>({channel:remote.channel,removeChannel:remote.removeChannel})}));
vi.mock('../features/room/claims',async importOriginal=>({
  ...await importOriginal<typeof import('../features/room/claims')>(),
  getRoomClaims:remote.list,claimRoom:remote.claim,switchRoomClaim:remote.switch,heartbeatRoomClaim:remote.heartbeat,releaseRoomClaim:remote.release,
}));

import {useRoomClaims} from '../features/room/useRoomClaims';

type Channel={change?:()=>void;status?:(status:string)=>void;filters:Record<string,string>[];on:ReturnType<typeof vi.fn>;subscribe:ReturnType<typeof vi.fn>};
const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
let root:Root;
let container:HTMLDivElement;
let channels:Channel[];
let latest:ReturnType<typeof useRoomClaims>;
let snapshot:RoomClaim[];
const stamp=()=>new Date().toISOString();
const empty=(sessionId='session-1',roomId='診間 1'):RoomClaim=>({sessionId,roomId,isMine:false,isClaimed:false,claimedAt:null,claimExpiresAt:null,serverNow:stamp()});
const leased=(sessionId='session-1',roomId='診間 1',isMine=true):RoomClaim=>({...empty(sessionId,roomId),isMine,isClaimed:true,claimedAt:stamp(),claimExpiresAt:new Date(Date.now()+180_000).toISOString()});
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;return{promise:new Promise<T>((yes,no)=>{resolve=yes;reject=no;}),resolve:(value:T)=>resolve(value),reject:(error:Error)=>reject(error)};}
function Harness({sessionId,roomCount,preferredRoomId}:{sessionId:string|null;roomCount?:number|null;preferredRoomId?:string|null}){latest=useRoomClaims(sessionId,roomCount,preferredRoomId);return <div>{latest.roomId}:{latest.isOwned?'本人':'尚未認領'}</div>;}
async function render(sessionId:string|null='session-1',roomCount?:number|null,preferredRoomId?:string|null){await act(async()=>{root.render(<Harness sessionId={sessionId} roomCount={roomCount} preferredRoomId={preferredRoomId}/>);});}
async function event(callback:()=>void){await act(async()=>{callback();});}
async function advance(ms:number){await act(async()=>{await vi.advanceTimersByTimeAsync(ms);});}

function own(sessionId:string,roomId:string){const result=leased(sessionId,roomId);snapshot=snapshot.map(room=>room.roomId===roomId?result:{...room,isMine:false});return result;}

describe('診間認領同步、租約與切換',()=>{
  beforeEach(()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-07T02:00:00Z'));
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;
    for(const mock of Object.values(remote))mock.mockReset();
    snapshot=Array.from({length:4},(_,index)=>empty('session-1',`診間 ${index+1}`));
    remote.list.mockImplementation(async()=>snapshot);
    remote.claim.mockImplementation(async(sessionId:string,roomId:string)=>own(sessionId,roomId));
    remote.switch.mockImplementation(async(sessionId:string,_from:string,to:string)=>own(sessionId,to));
    remote.heartbeat.mockImplementation(async(sessionId:string,roomId:string)=>own(sessionId,roomId));
    remote.release.mockImplementation(async(sessionId:string,roomId:string)=>empty(sessionId,roomId));
    channels=[];
    remote.channel.mockImplementation(()=>{
      const channel:Channel={filters:[],on:vi.fn(),subscribe:vi.fn()};
      channel.on.mockImplementation((_event:string,filter:Record<string,string>,change:()=>void)=>{channel.filters.push(filter);channel.change=change;return channel;});
      channel.subscribe.mockImplementation((status:(status:string)=>void)=>{channel.status=status;return channel;});
      channels.push(channel);return channel;
    });
    container=document.createElement('div');document.body.append(container);root=createRoot(container);
  });
  afterEach(async()=>{await act(async()=>{root.unmount();});container.remove();vi.useRealTimers();actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;});

  it('未選場次不讀取、不認領也不訂閱',async()=>{
    await render(null);expect(latest.roomId).toBeNull();expect(latest.isOwned).toBe(false);expect(latest.loading).toBe(false);
    expect(remote.list).not.toHaveBeenCalled();expect(remote.claim).not.toHaveBeenCalled();expect(remote.channel).not.toHaveBeenCalled();
  });

  it('預設認領第一診間，只有伺服器確認後才允許操作',async()=>{
    const pending=deferred<RoomClaim>();remote.claim.mockReturnValueOnce(pending.promise);
    await render();expect(latest.isOwned).toBe(false);expect(latest.claimConfirmed).toBe(false);
    await event(()=>pending.resolve(own('session-1','診間 1')));
    expect(latest.roomId).toBe('診間 1');expect(latest.isOwned).toBe(true);expect(latest.claimConfirmed).toBe(true);
    expect(remote.claim).toHaveBeenCalledWith('session-1','診間 1');
  });

  it.each([
    {preferred:'room_3',expected:'診間 3'},
    {preferred:'診間5',expected:'診間 1'},
  ])('首選 $preferred 只可在本場次有效診間中認領',async({preferred,expected})=>{
    await render('session-1',3,preferred);expect(remote.claim).toHaveBeenCalledWith('session-1',expected);expect(latest.roomId).toBe(expected);
    expect(latest.claims.every(room=>['診間 1','診間 2','診間 3'].includes(room.roomId))).toBe(true);
  });

  it('重新整理讀到本人仍有效的租約時還原本人診間並重新由伺服器確認',async()=>{
    snapshot[2]=leased('session-1','診間 3');
    await render('session-1',4,'診間 1');
    expect(remote.claim).toHaveBeenCalledWith('session-1','診間 3');expect(latest.roomId).toBe('診間 3');expect(latest.isOwned).toBe(true);
  });

  it('預設診間被占用時不得自行換另一診間或奪取他人租約',async()=>{
    snapshot[0]=leased('session-1','診間 1',false);remote.claim.mockRejectedValue(new Error('room_claimed'));
    await render();expect(latest.isOwned).toBe(false);expect(latest.claimConfirmed).toBe(false);expect(latest.allOccupied).toBe(false);
    expect(remote.claim.mock.calls.every(([,roomId])=>roomId==='診間 1')).toBe(true);expect(remote.switch).not.toHaveBeenCalled();
  });

  it('所有有效診間均由他人認領時顯示全滿，不計入超出數量的歷史房號',async()=>{
    snapshot=[leased('session-1','診間 1',false),leased('session-1','診間 2',false),empty('session-1','診間 3')];
    remote.claim.mockRejectedValue(new Error('room_claimed'));
    await render('session-1',2);expect(latest.allOccupied).toBe(true);expect(latest.isOwned).toBe(false);
  });

  it('換房以原子 switch 成功後才改房號，不能先釋放旧房間',async()=>{
    await render();const releases=remote.release.mock.calls.length;
    await act(async()=>{expect(await latest.selectRoom('room_2')).toBe(true);});
    expect(remote.switch).toHaveBeenCalledWith('session-1','診間 1','診間 2');expect(remote.release).toHaveBeenCalledTimes(releases);
    expect(latest.roomId).toBe('診間 2');expect(latest.isOwned).toBe(true);expect(latest.claimConfirmed).toBe(true);
  });

  it('目標被占用或原診間檢查中時換房失敗仍保留本人原房租約',async()=>{
    await render();remote.switch.mockRejectedValueOnce(new Error('room_claimed'));
    await act(async()=>{expect(await latest.selectRoom('診間 2')).toBe(false);});
    expect(latest.roomId).toBe('診間 1');expect(latest.isOwned).toBe(true);expect(latest.error).toContain('其他');
    remote.switch.mockRejectedValueOnce(new Error('room_claim_in_progress'));
    await act(async()=>{expect(await latest.selectRoom('診間 3')).toBe(false);});
    expect(latest.roomId).toBe('診間 1');expect(latest.isOwned).toBe(true);expect(remote.release).not.toHaveBeenCalled();
  });

  it('不得以 UI 選擇超出 room_count 的診間',async()=>{
    await render('session-1',2);
    await act(async()=>{expect(await latest.selectRoom('room_3')).toBe(false);});
    expect(remote.switch).not.toHaveBeenCalled();expect(latest.roomId).toBe('診間 1');
  });

  it('每 30 秒續租並定期讀取，輪詢不再次自動認領',async()=>{
    await render();const claims=remote.claim.mock.calls.length;
    await advance(30_000);
    expect(remote.heartbeat).toHaveBeenCalledWith('session-1','診間 1');expect(remote.list.mock.calls.length).toBeGreaterThan(1);
    expect(remote.claim).toHaveBeenCalledTimes(claims);expect(latest.isOwned).toBe(true);
  });

  it('暫時網路失敗保留未過期租約並警示，續租成功會恢復',async()=>{
    await render();remote.heartbeat.mockRejectedValueOnce(new Error('network unavailable'));remote.list.mockRejectedValueOnce(new Error('network unavailable'));
    await advance(30_000);expect(latest.isOwned).toBe(true);expect(latest.warning).not.toBe('');
    await advance(30_000);expect(latest.isOwned).toBe(true);expect(latest.warning).toBe('');
  });

  it('超過伺服器已確認的 180 秒租約而無法續租即取消操作權',async()=>{
    await render();remote.heartbeat.mockRejectedValue(new Error('network unavailable'));remote.list.mockRejectedValue(new Error('network unavailable'));
    await advance(180_001);expect(latest.isOwned).toBe(false);expect(latest.claimConfirmed).toBe(false);
  });

  it('裝置時間與伺服器不一致時，租約倒數仍依 serverNow 計算',async()=>{
    const serverNow='2026-10-07T02:00:00Z';
    vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
    const owned={...leased(),serverNow,claimedAt:serverNow,claimExpiresAt:'2026-10-07T02:03:00Z'};
    snapshot[0]=owned;remote.claim.mockResolvedValueOnce(owned);
    await render();expect(latest.isOwned).toBe(true);expect(latest.claimConfirmed).toBe(true);
    remote.heartbeat.mockRejectedValue(new Error('network unavailable'));remote.list.mockRejectedValue(new Error('network unavailable'));
    await advance(180_001);expect(latest.isOwned).toBe(false);
  });

  it('伺服器明確回報租約失效時立即取消操作權，不等待 TTL',async()=>{
    await render();remote.heartbeat.mockRejectedValueOnce(new Error('room_claim_lost'));
    snapshot[0]=leased('session-1','診間 1',false);
    await advance(30_000);expect(latest.isOwned).toBe(false);expect(latest.claimConfirmed).toBe(false);
  });

  it('focus、online 與同場次 Realtime 会重新確認，切到背景不釋放',async()=>{
    await render();const reads=remote.list.mock.calls.length;
    await event(()=>window.dispatchEvent(new Event('focus')));
    expect(remote.list.mock.calls.length).toBeGreaterThan(reads);
    await event(()=>window.dispatchEvent(new Event('online')));
    expect(remote.heartbeat).toHaveBeenCalledWith('session-1','診間 1');
    const refreshed=remote.list.mock.calls.length;
    await event(()=>channels[0].change?.());expect(remote.list.mock.calls.length).toBeGreaterThan(refreshed);
    const releases=remote.release.mock.calls.length;
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
    await event(()=>document.dispatchEvent(new Event('visibilitychange')));
    expect(remote.release).toHaveBeenCalledTimes(releases);
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
  });

  it('場次切換後延遲舊查詢不得認領舊場次或覆蓋新場次',async()=>{
    const pending=deferred<RoomClaim[]>();remote.list.mockReturnValueOnce(pending.promise);
    await render('session-1');
    snapshot=[empty('session-2','診間 1'),empty('session-2','診間 2')];await render('session-2',2);
    await event(()=>pending.resolve([leased('session-1','診間 3')]));
    expect(latest.roomId).toBe('診間 1');expect(latest.isOwned).toBe(true);expect(latest.claims.every(room=>room.sessionId==='session-2')).toBe(true);
    expect(remote.claim).not.toHaveBeenCalledWith('session-1','診間 3');expect(remote.removeChannel).toHaveBeenCalledWith(channels[0]);
  });

  it('撤銷使用權後較早的 refresh 回覆不得恢復操作權',async()=>{
    await render();const pending=deferred<RoomClaim[]>();remote.list.mockReturnValueOnce(pending.promise);
    let first!:Promise<void>;
    await event(()=>{first=latest.refresh();});
    await event(()=>latest.revoke());
    await act(async()=>{pending.resolve([leased()]);await first;});
    expect(latest.isOwned).toBe(false);expect(latest.claimConfirmed).toBe(false);
  });

  it('卸載取消訂閱及計時，盡力釋放本人診間，不釋放他人的房',async()=>{
    await render();const heartbeatCalls=remote.heartbeat.mock.calls.length;
    await event(()=>root.unmount());root=createRoot(container);
    expect(remote.removeChannel).toHaveBeenCalledWith(channels[0]);expect(remote.release).toHaveBeenCalledWith('session-1','診間 1','2026-10-07T02:00:00.000Z');
    await advance(60_000);expect(remote.heartbeat).toHaveBeenCalledTimes(heartbeatCalls);
  });

  it('已卸載的初始認領若延後成功，必須補釋放避免幽靈占用',async()=>{
    const pending=deferred<RoomClaim>();remote.claim.mockReturnValueOnce(pending.promise);
    await render();await event(()=>root.unmount());root=createRoot(container);
    await event(()=>pending.resolve(leased()));
    expect(remote.release).toHaveBeenCalledWith('session-1','診間 1','2026-10-07T02:00:00.000Z');
  });
  it('舊元件認領延後成功後，不得釋放同場次新元件已確認的租約',async()=>{
    const pending=deferred<RoomClaim>();remote.claim.mockReturnValueOnce(pending.promise);
    await render();await event(()=>root.unmount());root=createRoot(container);
    await render('session-1',4,'診間 2');
    expect(latest.isOwned).toBe(false);expect(remote.claim).toHaveBeenCalledTimes(1);
    await event(()=>pending.resolve(own('session-1','診間 1')));
    expect(latest.isOwned).toBe(true);
    await act(async()=>{expect(await latest.selectRoom('診間 2')).toBe(true);});
    await advance(1);
    expect(latest.roomId).toBe('診間 2');expect(latest.isOwned).toBe(true);expect(remote.release).not.toHaveBeenCalled();
  });

  it('舊元件釋放 RPC 尚未完成時，新元件同場次認領必须等候，不會遭晚到釋放清除',async()=>{
    await render();const pending=deferred<RoomClaim>();remote.release.mockReturnValueOnce(pending.promise);
    await event(()=>root.unmount());root=createRoot(container);
    expect(remote.release).toHaveBeenCalledWith('session-1','診間 1','2026-10-07T02:00:00.000Z');
    const claims=remote.claim.mock.calls.length;
    await render('session-1',4,'診間 2');
    expect(remote.claim).toHaveBeenCalledTimes(claims);expect(latest.isOwned).toBe(false);
    snapshot=snapshot.map(room=>empty(room.sessionId,room.roomId));
    await event(()=>pending.resolve(empty()));
    expect(remote.claim).toHaveBeenLastCalledWith('session-1','診間 2');expect(latest.roomId).toBe('診間 2');expect(latest.isOwned).toBe(true);
    expect(remote.release).toHaveBeenCalledTimes(1);
  });

  it.each(['permission_denied','session_not_found','session_read_only'])('續租遇到 %s 必須立即取消診間權限',async code=>{
    await render();remote.heartbeat.mockRejectedValue(new Error(code));remote.list.mockRejectedValue(new Error(code));
    await advance(30_000);expect(latest.isOwned).toBe(false);expect(latest.claimConfirmed).toBe(false);
  });

  it('釋放等待最多 2 秒，逾時後新的認領仍等待原 RPC 完成以免晚到釋放覆蓋',async()=>{
    await render();const pending=deferred<RoomClaim>();remote.release.mockReturnValueOnce(pending.promise);
    let result:boolean|undefined;let releasePromise!:Promise<boolean>;
    await event(()=>{releasePromise=latest.release();void releasePromise.then(value=>{result=value;});});
    await advance(1_999);expect(result).toBeUndefined();
    await advance(1);expect(result).toBe(false);expect(latest.busy).toBe(false);expect(latest.warning).not.toBe('');
    const claims=remote.claim.mock.calls.length;let next!:Promise<boolean>;
    await event(()=>{next=latest.selectRoom('診間 2');});
    expect(remote.claim).toHaveBeenCalledTimes(claims);expect(remote.switch).not.toHaveBeenCalled();
    snapshot=snapshot.map(room=>empty(room.sessionId,room.roomId));
    await act(async()=>{pending.resolve(empty());expect(await next).toBe(true);});
    expect(remote.claim).toHaveBeenLastCalledWith('session-1','診間 2');expect(latest.roomId).toBe('診間 2');expect(latest.isOwned).toBe(true);
  });

  it('撤銷期間正在換房的延遲成功回應不得恢復權限',async()=>{
    await render();const pending=deferred<RoomClaim>();remote.switch.mockReturnValueOnce(pending.promise);
    let selected!:Promise<boolean>;
    await event(()=>{selected=latest.selectRoom('診間 2');});
    await event(()=>latest.revoke());
    await advance(1_000);
    await act(async()=>{pending.resolve(own('session-1','診間 2'));expect(await selected).toBe(false);});
    expect(latest.isOwned).toBe(false);expect(latest.claimConfirmed).toBe(false);
    expect(remote.release).toHaveBeenCalledWith('session-1','診間 2','2026-10-07T02:00:01.000Z');
  });

  it('首次認領在等待伺服器期間撤銷，延遲成功回應不能恢復權限',async()=>{
    const pending=deferred<RoomClaim>();remote.claim.mockReturnValueOnce(pending.promise);
    await render();await event(()=>latest.revoke());
    await event(()=>pending.resolve(own('session-1','診間 1')));
    expect(latest.isOwned).toBe(false);expect(latest.claimConfirmed).toBe(false);
    expect(remote.release).toHaveBeenCalledWith('session-1','診間 1','2026-10-07T02:00:00.000Z');
  });

  it('主動撤銷後即使稍後輪詢讀到本人舊租約也不恢復，必須重新選擇並由伺服器確認',async()=>{
    await render();await event(()=>latest.revoke());
    await advance(30_000);expect(latest.isOwned).toBe(false);expect(latest.claimConfirmed).toBe(false);
    await act(async()=>{expect(await latest.selectRoom('診間 1')).toBe(true);});
    expect(latest.isOwned).toBe(true);expect(latest.claimConfirmed).toBe(true);
  });

});
