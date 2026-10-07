import {beforeEach,describe,expect,it,vi} from 'vitest';

const remote=vi.hoisted(()=>({from:vi.fn(),select:vi.fn(),eq:vi.fn(),order:vi.fn(),single:vi.fn(),rpc:vi.fn()}));
vi.mock('../lib/supabase',()=>({requireSupabase:()=>({from:remote.from,rpc:remote.rpc})}));
vi.mock('../features/room/device',()=>({getDeviceIdentity:()=>({deviceId:'device-1',claimSecret:'device-secret'})}));

import {getSessionRoomCount,listRooms,setRoomAway} from '../features/room/service';
import {canReceivePatient,DEFAULT_ROOM_COUNT,getRoomCount,getRoomIds,isRoomEnabled,isValidRoomCount,MAX_ROOM_COUNT,MIN_ROOM_COUNT,normalizeRoomId,roomStatusLabels} from '../features/room/status';

const row={session_id:'session-1',room_id:'診間 2',status:'away',updated_at:'2026-10-07T02:00:00Z'};

describe('診間雲端狀態',()=>{
  beforeEach(()=>{
    for(const mock of Object.values(remote))mock.mockReset();
    remote.from.mockReturnValue({select:remote.select});
    remote.select.mockReturnValue({eq:remote.eq});
    remote.eq.mockReturnValue({order:remote.order,single:remote.single});
    remote.single.mockResolvedValue({data:{room_count:DEFAULT_ROOM_COUNT},error:null});
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
    expect(remote.rpc).toHaveBeenCalledWith('set_room_away',{p_session_id:'session-1',p_room_id:'診間 2',p_away:away,p_device_id:'device-1',p_device_secret:'device-secret'});
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

  it('所有有效範圍及舊場次預設皆來自共用設定',()=>{
    expect([MIN_ROOM_COUNT,DEFAULT_ROOM_COUNT,MAX_ROOM_COUNT]).toEqual([1,4,8]);
    expect(getRoomCount(null)).toBe(DEFAULT_ROOM_COUNT);expect(getRoomCount()).toBe(DEFAULT_ROOM_COUNT);
    expect(getRoomIds(3)).toEqual(['診間 1','診間 2','診間 3']);
    for(const value of [0,MAX_ROOM_COUNT+1,1.5,NaN,Infinity,'4',null])expect(isValidRoomCount(value)).toBe(false);
    expect(isRoomEnabled('room_3',3)).toBe(true);expect(isRoomEnabled('診間4',3)).toBe(false);
    expect(isRoomEnabled(null,3)).toBe(false);expect(isRoomEnabled('其他',3)).toBe(false);
  });

  it.each([2,3,MAX_ROOM_COUNT])('雲端設定%s間時只回有效房號，舊診間資料不擴大場次',async roomCount=>{
    remote.single.mockResolvedValue({data:{room_count:roomCount},error:null});
    remote.order.mockResolvedValue({data:[row,{...row,room_id:'room_8',status:'in_progress'}],error:null});
    const rooms=await listRooms('session-1');
    expect(rooms.map(room=>room.roomId)).toEqual(getRoomIds(roomCount));
    expect(rooms[1].status).toBe('away');
    expect(remote.select).toHaveBeenCalledWith('room_count');
    expect(remote.eq).toHaveBeenCalledWith('id','session-1');
    if(roomCount===MAX_ROOM_COUNT)expect(rooms.at(-1)?.status).toBe('in_progress');
  });

  it('舊場次null診間數量可正常讀取，場次讀取失敗不得猜測空閒狀態',async()=>{
    remote.single.mockResolvedValueOnce({data:{room_count:null},error:null});
    expect(await getSessionRoomCount('session-1')).toBe(DEFAULT_ROOM_COUNT);
    remote.single.mockResolvedValueOnce({data:null,error:{message:'cannot read session'}});
    await expect(listRooms('session-1')).rejects.toEqual({message:'cannot read session'});
    expect(remote.order).not.toHaveBeenCalled();
  });

  it('已知數量仍排除多餘房間，舊別名的away/in_progress不被idle覆蓋',async()=>{
    remote.order.mockResolvedValue({data:[row,{...row,room_id:'room_2',status:'idle'},{...row,room_id:'診間2',status:'in_progress'},{...row,room_id:'診間 3',status:'in_progress'},{...row,room_id:'room_3',status:'idle'},{...row,room_id:'診間 5'}],error:null});
    const rooms=await listRooms('session-1',3);
    expect(rooms.map(room=>[room.roomId,room.status])).toEqual([['診間 1','idle'],['診間 2','away'],['診間 3','in_progress']]);
    expect(remote.single).not.toHaveBeenCalled();
  });
});
