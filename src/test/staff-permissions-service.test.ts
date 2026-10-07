import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {StaffPermissions} from '../types';

const remote=vi.hoisted(()=>({from:vi.fn(),select:vi.fn(),eq:vi.fn(),maybeSingle:vi.fn()}));
vi.mock('../lib/supabase',()=>({requireSupabase:()=>({from:remote.from})}));

import {canUsePage,firstAllowedPage,getAllowedPages,getStaffPermissions,permissionAccessMessage} from '../features/auth/permissions';
import {formatAdditionalExaminationError,formatError,formatPermissionError,formatRoomCountError,friendlyError} from '../lib/errors';

const row={user_id:'worker-1',login_email:'room01@itri.example.com',display_name:'診間人員',can_registration:false,can_console:false,can_room:true,is_active:true};
const permissions:StaffPermissions={userId:'worker-1',loginEmail:row.login_email,displayName:row.display_name,canRegistration:false,canConsole:false,canRoom:true,isActive:true};

describe('工作人員權限service與頁面規則',()=>{
  beforeEach(()=>{
    for(const mock of Object.values(remote))mock.mockReset();
    remote.from.mockReturnValue({select:remote.select});
    remote.select.mockReturnValue({eq:remote.eq});
    remote.eq.mockReturnValue({maybeSingle:remote.maybeSingle});
    remote.maybeSingle.mockResolvedValue({data:row,error:null});
  });

  it('只查詢登入者的一列權限且將資料庫snake_case轉成前端type',async()=>{
    expect(await getStaffPermissions('worker-1')).toEqual(permissions);
    expect(remote.from).toHaveBeenCalledWith('staff_permissions');
    expect(remote.select).toHaveBeenCalledWith('user_id,login_email,display_name,can_registration,can_console,can_room,is_active');
    expect(remote.eq).toHaveBeenCalledWith('user_id','worker-1');
    expect(remote.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('權限列不存在或回傳其他帳號列時不給預設授權',async()=>{
    remote.maybeSingle.mockResolvedValue({data:null,error:null});
    expect(await getStaffPermissions('worker-1')).toBeNull();
    remote.maybeSingle.mockResolvedValue({data:{...row,user_id:'someone-else'},error:null});
    expect(await getStaffPermissions('worker-1')).toBeNull();
    expect(permissionAccessMessage(null)).toBe('此帳號尚未設定系統權限，請洽管理員。');
  });

  it('空帳號不發出query，DB錯誤不當成可用或不存在權限',async()=>{
    expect(await getStaffPermissions('')).toBeNull();expect(remote.from).not.toHaveBeenCalled();
    remote.maybeSingle.mockResolvedValue({data:null,error:{code:'42501',message:'permission_denied'}});
    await expect(getStaffPermissions('worker-1')).rejects.toEqual({code:'42501',message:'permission_denied'});
  });

  it('授權欄位只接受明確boolean true，空值或string true皆不給授權',async()=>{
    remote.maybeSingle.mockResolvedValue({data:{...row,can_registration:'true',can_console:1,can_room:null,is_active:undefined},error:null});
    expect(await getStaffPermissions('worker-1')).toMatchObject({canRegistration:false,canConsole:false,canRoom:false,isActive:false});
  });

  it.each(Array.from({length:8},(_,bits)=>[Boolean(bits&4),Boolean(bits&2),Boolean(bits&1)]))('三個獨立boolean %s / %s / %s 依優先順序決定頁面',async(canRegistration,canConsole,canRoom)=>{
    const value={...permissions,canRegistration,canConsole,canRoom};
    const expected=[...(canRegistration?['registration']:[]),...(canConsole?['console']:[]),...(canRoom?['room']:[])];
    expect(getAllowedPages(value)).toEqual(expected);
    expect(firstAllowedPage(value)).toBe(expected[0]??null);
    expect(canUsePage(value,'registration')).toBe(canRegistration);
    expect(canUsePage(value,'console')).toBe(canConsole);
    expect(canUsePage(value,'room')).toBe(canRoom);
  });

  it('停用帳號即使保留三頁true也不可使用，無頁面帳號有指定中文提示',()=>{
    const disabled={...permissions,canRegistration:true,canConsole:true,isActive:false};
    expect(getAllowedPages(disabled)).toEqual([]);expect(firstAllowedPage(disabled)).toBeNull();
    expect(permissionAccessMessage(disabled)).toBe('此帳號目前已停用，請洽管理員。');
    expect(permissionAccessMessage({...permissions,canRoom:false})).toBe('此帳號目前沒有可使用的工作頁面，請洽管理員。');
    expect(permissionAccessMessage(permissions)).toBe('');
  });
});

describe('現場權限錯誤訊息',()=>{
  it.each([
    new Error('permission_denied'),
    {message:'not_authorized'},
    {message:'permission denied for table participants',code:'42501'},
    {message:'new row violates row-level security policy',code:'42501'},
    'not_authorized',
  ])('RPC或RLS拒絕顯示中文，不裸露內部錯誤 %s',error=>{
    const expected='此帳號沒有執行此功能的權限。';
    expect(formatError(error)).toBe(expected);
    expect(formatPermissionError(error)).toBe(expected);
    expect(friendlyError(error)).toBe(expected);
    expect(formatRoomCountError(error)).toBe(expected);
    expect(formatAdditionalExaminationError(error)).toContain(expected);
  });

  it('共用formatter保留既有登入、網路、場次數量錯誤',()=>{
    expect(friendlyError(new Error('Invalid login credentials'))).toBe('Email 或密碼不正確。');
    expect(friendlyError(new Error('failed to fetch'))).toContain('無法連線至雲端');
    expect(friendlyError({message:'room_count_away:room_5'})).toBe('無法減少診間數量：診間5目前暫時離開。');
    expect(formatError(new Error('custom error'))).toBe('custom error');
  });
});
