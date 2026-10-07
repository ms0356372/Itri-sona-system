import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {StaffPermissions} from '../types';

const remote=vi.hoisted(()=>({getUser:vi.fn(),permissions:vi.fn(),rpc:vi.fn()}));
vi.mock('../lib/supabase',()=>({requireSupabase:()=>({auth:{getUser:remote.getUser},rpc:remote.rpc})}));
vi.mock('../features/auth/permissions',async importOriginal=>({...await importOriginal<typeof import('../features/auth/permissions')>(),getStaffPermissions:remote.permissions}));

import {acknowledgeLocalClear,closeSession} from '../features/cleanup/service';
import {db} from '../features/history/db';
import {friendlyError} from '../lib/errors';

const permissions:StaffPermissions={userId:'registration-user',loginEmail:'checkin01@itri.example.com',displayName:'',canRegistration:true,canConsole:false,canRoom:false,isActive:true};
const draft={participantId:'participant-1',roomId:'診間 1',startedAt:null,items:['腹部超音波']};

describe('裝置clearance權限與本機完成順序',()=>{
  beforeEach(async()=>{
    vi.restoreAllMocks();
    remote.getUser.mockReset();remote.permissions.mockReset();remote.rpc.mockReset();
    remote.getUser.mockResolvedValue({data:{user:{id:'registration-user'}},error:null});
    remote.permissions.mockResolvedValue(permissions);
    remote.rpc.mockResolvedValue({data:null,error:null});
    await db.drafts.clear();await db.history.clear();
    await db.drafts.put(draft);
    await db.history.add({fingerprint:'local-history-1',nationalId:'A123456789',employeeNo:'EMP1',name:'本機歷年資料',year:2025,date:'2025-01-01',type:'腹部超音波',values:{結果:'正常'},sourceFile:'history.xlsx'});
  });
  afterEach(async()=>{vi.restoreAllMocks();await db.drafts.clear();await db.history.clear();});

  it.each([
    null,
    {...permissions,isActive:false},
    {...permissions,canRegistration:false,canConsole:true},
    {...permissions,canRegistration:false,canRoom:true},
    {...permissions,canRegistration:false},
  ])('無報到站權限不清本機draft且不呼叫RPC %s',async value=>{
    remote.permissions.mockResolvedValue(value);
    await expect(acknowledgeLocalClear('session-1','tablet-1')).rejects.toThrow('permission_denied');
    expect(remote.getUser).toHaveBeenCalledTimes(1);expect(remote.permissions).toHaveBeenCalledWith('registration-user');
    expect(await db.drafts.toArray()).toEqual([draft]);expect(await db.history.count()).toBe(1);
    expect(remote.rpc).not.toHaveBeenCalled();
  });

  it('身份驗證失敗或無Auth user不查權限不清draft也不ack',async()=>{
    const error={message:'invalid JWT',code:'bad_jwt'};
    remote.getUser.mockResolvedValueOnce({data:{user:null},error});
    await expect(acknowledgeLocalClear('session-1','tablet-1')).rejects.toEqual(error);
    remote.getUser.mockResolvedValueOnce({data:{user:null},error:null});
    await expect(acknowledgeLocalClear('session-1','tablet-1')).rejects.toThrow('not_authorized');
    expect(await db.drafts.toArray()).toEqual([draft]);expect(remote.permissions).not.toHaveBeenCalled();expect(remote.rpc).not.toHaveBeenCalled();
  });

  it('權限查詢失敗不能當成授權或先清本機資料',async()=>{
    const error={message:'permission denied for table staff_permissions',code:'42501'};
    remote.permissions.mockRejectedValue(error);
    await expect(acknowledgeLocalClear('session-1','tablet-1')).rejects.toEqual(error);
    expect(await db.drafts.toArray()).toEqual([draft]);expect(remote.rpc).not.toHaveBeenCalled();
  });

  it('本機draft clear失敗不寫雲端ack，原draft與歷年資料保留',async()=>{
    vi.spyOn(db.drafts,'clear').mockRejectedValueOnce(new Error('IndexedDB write failed'));
    await expect(acknowledgeLocalClear('session-1','tablet-1')).rejects.toThrow('IndexedDB write failed');
    expect(remote.rpc).not.toHaveBeenCalled();expect(await db.drafts.toArray()).toEqual([draft]);expect(await db.history.count()).toBe(1);
  });

  it('server身份與本人權限確認後先完成本機clear，再送ack且不清歷年資料',async()=>{
    const order:string[]=[];
    remote.getUser.mockImplementation(async()=>{order.push('auth');return{data:{user:{id:'registration-user'}},error:null};});
    remote.permissions.mockImplementation(async(userId:string)=>{expect(userId).toBe('registration-user');order.push('permission');return permissions;});
    const originalClear=db.drafts.clear.bind(db.drafts);
    vi.spyOn(db.drafts,'clear').mockImplementation(()=>originalClear().then(()=>{order.push('local-clear');}));
    remote.rpc.mockImplementation(async()=>{expect(await db.drafts.count()).toBe(0);order.push('cloud-ack');return{data:null,error:null};});
    await acknowledgeLocalClear('session-1','tablet-1');
    expect(order).toEqual(['auth','permission','local-clear','cloud-ack']);
    expect(remote.rpc).toHaveBeenCalledWith('acknowledge_device_clear',{p_session_id:'session-1',p_device_id:'tablet-1'});
    expect(await db.history.count()).toBe(1);
  });

  it('clear後DB拒絕ack保留可翻譯權限錯誤，無虛假成功；重新確認權限後可重試',async()=>{
    const error={message:'permission_denied',code:'42501'};
    remote.rpc.mockResolvedValueOnce({data:null,error});
    await expect(acknowledgeLocalClear('session-1','tablet-1')).rejects.toEqual(error);
    expect(friendlyError(error)).toBe('此帳號沒有執行此功能的權限。');
    expect(await db.drafts.count()).toBe(0);expect(await db.history.count()).toBe(1);
    await acknowledgeLocalClear('session-1','tablet-1');
    expect(remote.getUser).toHaveBeenCalledTimes(2);expect(remote.permissions).toHaveBeenCalledTimes(2);expect(remote.rpc).toHaveBeenCalledTimes(2);
  });

  it('關閉場次沿用有DB權限guard的RPC，拒絕時不改本機資料',async()=>{
    const error={message:'not_authorized',code:'P0001'};
    remote.rpc.mockResolvedValueOnce({data:null,error});
    await expect(closeSession('session-1')).rejects.toEqual(error);
    expect(remote.rpc).toHaveBeenCalledWith('close_health_session',{p_session_id:'session-1'});
    expect(await db.drafts.toArray()).toEqual([draft]);expect(await db.history.count()).toBe(1);
    remote.rpc.mockResolvedValueOnce({data:{status:'closed'},error:null});
    expect(await closeSession('session-1')).toEqual({status:'closed'});
  });
});
