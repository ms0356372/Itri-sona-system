import {beforeEach,describe,expect,it,vi} from 'vitest';

const remote=vi.hoisted(()=>({from:vi.fn(),select:vi.fn(),eq:vi.fn(),order:vi.fn(),rpc:vi.fn()}));
vi.mock('../lib/supabase',()=>({requireSupabase:()=>({from:remote.from,rpc:remote.rpc})}));

import {listRooms,setRoomAway} from '../features/room/service';
import {canReceivePatient,normalizeRoomId,roomStatusLabels} from '../features/room/status';

const row={session_id:'session-1',room_id:'診間 2',status:'away',updated_at:'2026-10-07T02:00:00Z'};

describe('診間雲端狀態',()=>{
  beforeEach(()=>{
    for(const mock of Object.values(remote))mock.mockReset();
    remote.from.mockReturnValue({select:remote.select});
    remote.select.mockReturnValue({eq:remote.eq});
    remote.eq.mockReturnValue({order:remote.order});
  });

  it('查詢限定場次，成功讀取才將從未操作的四間診間補成 idle',async()=>{
    remote.order.mockResolvedValue({data:[row],error:null});
    expect(await listRooms('session-1')).toEqual([
      {sessionId:'session-1',roomId:'診間 1',status:'idle',updatedAt:null},
      {sessionId:'session-1',roomId:'診間 2',status:'away',updatedAt:row.updated_at},
      {sessionId:'session-1',roomId:'診間 3',status:'idle',updatedAt:null},
      {sessionId:'session-1',roomId:'診間 4',status:'idle',updatedAt:null},
    ]);
    expect(remote.from).toHaveBeenCalledWith('rooms');
    expect(remote.eq).toHaveBeenCalledWith('session_id','session-1');
  });

  it('讀取失敗、未知狀態或錯場次列皆拒絕回傳可接人的狀態',async()=>{
    remote.order.mockResolvedValueOnce({data:null,error:{message:'network failure'}});
    await expect(listRooms('session-1')).rejects.toEqual({message:'network failure'});
    remote.order.mockResolvedValueOnce({data:[{...row,status:'closed'}],error:null});
    await expect(listRooms('session-1')).rejects.toThrow('invalid_room_state');
    remote.order.mockResolvedValueOnce({data:[{...row,session_id:'other-session'}],error:null});
    await expect(listRooms('session-1')).rejects.toThrow('invalid_room_state');
    remote.order.mockResolvedValueOnce({data:null,error:null});
    await expect(listRooms('session-1')).rejects.toThrow('invalid_room_state');
  });

  it.each([true,false])('使用正式RPC原子切換away=%s並保留雲端返回狀態',async away=>{
    const response={...row,status:away?'away':'in_progress'};
    remote.rpc.mockResolvedValue({data:response,error:null});
    expect(await setRoomAway('session-1','診間 2',away)).toEqual({sessionId:'session-1',roomId:'診間 2',status:response.status,updatedAt:row.updated_at});
    expect(remote.rpc).toHaveBeenCalledWith('set_room_away',{p_session_id:'session-1',p_room_id:'診間 2',p_away:away});
  });

  it('只有明確 idle 可以接新受檢者，away不是空閒或關閉',()=>{
    expect(canReceivePatient('idle')).toBe(true);
    for(const status of ['away','in_progress',null,undefined] as const)expect(canReceivePatient(status)).toBe(false);
    expect(roomStatusLabels.away).toBe('暫時離開');
  });

  it('舊診間代碼與有空白的新代碼使用同一canonical room id',()=>{
    for(const value of ['診間1','診間 1','  診間   1  '])expect(normalizeRoomId(value)).toBe('診間 1');
    expect(normalizeRoomId(' 診間 4 ')).toBe('診間 4');
    expect(normalizeRoomId(' 其他診间 ')).toBe('其他診间');
  });
});
