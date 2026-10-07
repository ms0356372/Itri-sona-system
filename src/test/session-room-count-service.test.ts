import {beforeEach,describe,expect,it,vi} from 'vitest';

const remote=vi.hoisted(()=>({from:vi.fn(),select:vi.fn(),insert:vi.fn(),single:vi.fn(),neq:vi.fn(),order:vi.fn(),rpc:vi.fn()}));
vi.mock('../lib/supabase',()=>({requireSupabase:()=>({from:remote.from,rpc:remote.rpc})}));

import {createSession,listSessions,updateSessionRoomCount} from '../features/sessions/service';
import {DEFAULT_ROOM_COUNT,MAX_ROOM_COUNT} from '../features/room/status';
import {formatRoomCountError} from '../lib/errors';

const sessionRow={id:'session-1',session_date:'2026-10-07',company_name:'測試公司',status:'active' as const,room_count:DEFAULT_ROOM_COUNT};

describe('場次診間數量資料與更新',()=>{
  beforeEach(()=>{
    for(const mock of Object.values(remote))mock.mockReset();
    remote.from.mockReturnValue({insert:remote.insert,select:remote.select});
    remote.insert.mockReturnValue({select:remote.select});
    remote.select.mockReturnValue({single:remote.single,neq:remote.neq});
    remote.neq.mockReturnValue({order:remote.order});
    remote.single.mockResolvedValue({data:sessionRow,error:null});
    remote.rpc.mockResolvedValue({data:sessionRow,error:null});
  });

  it('新增場次預設4間，寫入同一health_sessions且不由前端重設rooms',async()=>{
    expect(await createSession('  測試公司  ','2026-10-07','worker-1')).toMatchObject({id:'session-1',roomCount:DEFAULT_ROOM_COUNT});
    expect(remote.from).toHaveBeenCalledTimes(1);expect(remote.from).toHaveBeenCalledWith('health_sessions');
    expect(remote.insert).toHaveBeenCalledWith({company_name:'測試公司',session_date:'2026-10-07',created_by:'worker-1',room_count:DEFAULT_ROOM_COUNT,workflow_mode:'standard'});
    expect(remote.select).toHaveBeenCalledWith('id,session_date,company_name,status,room_count,workflow_mode');
    expect(remote.rpc).not.toHaveBeenCalled();
  });

  it.each([2,MAX_ROOM_COUNT])('新增場次可選%s間並保持雲端返回數量',async roomCount=>{
    remote.single.mockResolvedValue({data:{...sessionRow,room_count:roomCount},error:null});
    expect((await createSession('測試公司','2026-10-07','worker-1',roomCount)).roomCount).toBe(roomCount);
    expect(remote.insert).toHaveBeenCalledWith(expect.objectContaining({room_count:roomCount}));
  });

  it.each([0,MAX_ROOM_COUNT+1,1.5,NaN,Infinity])('非法數量%s無法新增或修改，驗證失敗不發出資料庫操作',async roomCount=>{
    await expect(createSession('測試公司','2026-10-07','worker-1',roomCount)).rejects.toThrow('1～8');
    await expect(updateSessionRoomCount('session-1',roomCount)).rejects.toThrow('1～8');
    expect(remote.from).not.toHaveBeenCalled();expect(remote.rpc).not.toHaveBeenCalled();
  });

  it('查詢包含room_count，null及missing舊場次用4，已設定歷史數量保留',async()=>{
    remote.order.mockReturnValueOnce({order:remote.order}).mockResolvedValueOnce({data:[{...sessionRow,room_count:null},{...sessionRow,room_count:undefined},{...sessionRow,id:'historical',session_date:'2025-10-07',room_count:7}],error:null});
    const sessions=await listSessions();
    expect(sessions.map(session=>session.roomCount)).toEqual([DEFAULT_ROOM_COUNT,DEFAULT_ROOM_COUNT,7]);
    expect(remote.select).toHaveBeenCalledWith('id,session_date,company_name,status,room_count,workflow_mode');
  });

  it.each([6,4])('增加或安全減少至%s間透過單一原子RPC並使用返回的場次資料',async roomCount=>{
    remote.rpc.mockResolvedValue({data:{...sessionRow,room_count:roomCount},error:null});
    expect(await updateSessionRoomCount('session-1',roomCount)).toMatchObject({id:'session-1',roomCount});
    expect(remote.rpc).toHaveBeenCalledWith('update_session_room_count',{p_session_id:'session-1',p_room_count:roomCount});
    expect(remote.from).not.toHaveBeenCalled();
  });

  it.each([
    ['room_count_in_progress:診間 5','無法減少診間數量：診間5目前檢查中。'],
    ['room_count_away:診間 6','無法減少診間數量：診間6目前暫時離開。'],
    ['room_count_unfinished:room_5','無法減少診間數量：診間5有尚未完成的受檢者資料。'],
    ['session_read_only','歷史場次為唯讀，無法修改超音波診間數量。'],
  ])('雲端安全檢查%s失敗時回傳清楚訊息且不執行替代寫入',async(message,expected)=>{
    remote.rpc.mockResolvedValue({data:null,error:{code:'P0001',message}});
    await expect(updateSessionRoomCount('session-1',4)).rejects.toThrow(expected);
    expect(remote.from).not.toHaveBeenCalled();
  });

  it('錯誤formatter處理Supabase structured error，未知訊息仍保留',()=>{
    expect(formatRoomCountError({message:'invalid_room_count'})).toContain('1～8');
    expect(formatRoomCountError({message:'connection failed'})).toBe('connection failed');
    expect(formatRoomCountError(new Error('not_authorized'))).toBe('此帳號沒有執行此功能的權限。');
  });
});
