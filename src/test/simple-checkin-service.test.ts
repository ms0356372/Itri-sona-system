import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Session} from '../types';
import {simpleCheckIn,simpleCloudArguments,simpleError,type SimplePerson} from '../features/checkin/simpleService';

const remote=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('../lib/supabase',()=>({requireSupabase:()=>remote}));

const session:Session={id:'simple-session',companyName:'ITRI',sessionDate:'2026-10-07',status:'active',workflowMode:'simple'};
const person:SimplePerson={employeeNo:'00125',name:'王小明',gender:'男',item:'一般',extension:'1234'};
const row=(patch:Record<string,unknown>={})=>({
  id:'simple-person',session_id:session.id,sequence_no:3,employee_no:person.employeeNo,full_name:person.name,gender:person.gender,
  schedule_slot:null,group_code:null,queue_number:3,planned_items:['一般'],checkin_no:'3',status:'等候中',
  checked_in_at:'2026-10-07T00:00:00Z',called_at:null,note:'院內分機：1234',updated_at:'2026-10-07T00:00:00Z',...patch,
});

describe('簡易報到雲端邊界',()=>{
  beforeEach(()=>{remote.rpc.mockReset();remote.rpc.mockResolvedValue({data:row(),error:null});});

  it('只上傳實際報到人員的允許欄位，完整本機大名單物件與身分證不會被展開',async()=>{
    const local={...person,nationalId:'A123456789',companyKey:'ITRI',originalActivity:'大名單活動',id:42};
    const result=await simpleCheckIn(session,local);
    expect(remote.rpc).toHaveBeenCalledExactlyOnceWith('simple_check_in_participant',{
      p_session_id:session.id,p_employee_no:'00125',p_full_name:'王小明',p_gender:'男',p_item:'一般',p_extension:'1234',
    });
    expect(JSON.stringify(remote.rpc.mock.calls)).not.toContain('A123456789');
    expect(result).toMatchObject({queueNumber:3,checkinNo:'3',groupCode:null,slot:null,plannedItems:['一般']});
    expect(result).not.toHaveProperty('nationalId');
  });

  it('保留工號前導零，修剪操作欄位，空分機仍可報到',()=>{
    expect(simpleCloudArguments(session,{employeeNo:' 00125 ',name:' 王小明 ',gender:' 男 ',item:' 一般 ',extension:' '}))
      .toEqual({p_session_id:session.id,p_employee_no:'00125',p_full_name:'王小明',p_gender:'男',p_item:'一般',p_extension:''});
  });

  it.each(['standard',null,undefined] as const)('標準／舊場次不會進入簡易取號：%s',async workflowMode=>{
    await expect(simpleCheckIn({...session,workflowMode},person)).rejects.toThrow('簡易模式場次');
    expect(remote.rpc).not.toHaveBeenCalled();
  });
  it.each(['closing','closed'] as const)('非有效場次禁止建立 participant：%s',async status=>{
    await expect(simpleCheckIn({...session,status},person)).rejects.toThrow('可報到');
    expect(remote.rpc).not.toHaveBeenCalled();
  });
  it.each([
    ['employeeNo','請輸入工號。'],['name','請輸入姓名。'],['item','項目不可空白'],
  ] as const)('必填欄位空白不消耗號碼：%s',async(field,message)=>{
    await expect(simpleCheckIn(session,{...person,[field]:' '})).rejects.toThrow(message);
    expect(remote.rpc).not.toHaveBeenCalled();
  });
  it.each(['',' '])('性別可以留白，送出空字串並接受原數字號碼：%j',async gender=>{
    remote.rpc.mockResolvedValue({data:row({gender:''}),error:null});
    expect(await simpleCheckIn(session,{...person,gender})).toMatchObject({gender:'',queueNumber:3,checkinNo:'3'});
    expect(remote.rpc).toHaveBeenCalledWith('simple_check_in_participant',expect.objectContaining({p_employee_no:'00125',p_gender:'',p_item:'一般'}));
  });
  it.each(['employeeNo','name','gender','item','extension'] as const)('操作欄位混入完整身分證時不上傳：%s',async field=>{
    await expect(simpleCheckIn(session,{...person,[field]:'備註：ａ１２３４５６７８９'})).rejects.toThrow('身分證僅保留本機');
    expect(remote.rpc).not.toHaveBeenCalled();
  });

  it('重複報到接受資料庫原號碼、時間與已完成狀態，不在前端重算或重設',async()=>{
    remote.rpc.mockResolvedValue({data:row({status:'已完成',checked_in_at:'2026-10-01T00:00:00Z'}),error:null});
    expect(await simpleCheckIn(session,person)).toMatchObject({checkinNo:'3',queueNumber:3,status:'已完成',checkedInAt:'2026-10-01T00:00:00Z'});
    expect(remote.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    {session_id:'other-session'},{employee_no:'other-person'},{full_name:'另一人'},{gender:'女'},
    {queue_number:null},{queue_number:0},{queue_number:1.5},{checkin_no:'A3'},
    {group_code:'A'},{schedule_slot:'08:00~08:30'},{checked_in_at:null},
  ])('不能將不完整／其他人員的回傳資料顯示為報到成功：%j',async patch=>{
    remote.rpc.mockResolvedValue({data:row(patch),error:null});
    await expect(simpleCheckIn(session,person)).rejects.toThrow('無法確認報到結果');
  });
  it.each([null,[],[row()]])('沒有唯一 participant 回傳時保留重試：%j',async data=>{
    remote.rpc.mockResolvedValue({data,error:null});
    await expect(simpleCheckIn(session,person)).rejects.toThrow('無法確認報到結果');
  });

  it.each([
    [{message:'simple_identity_conflict'},'此工號已有報到紀錄'],
    [{message:'session_not_active'},'此場次目前無法報到'],
    [{message:'invalid_simple_participant'},'資料不完整'],
    [{message:'invalid_workflow_mode'},'場次模式不符'],
    [{message:'session_not_found'},'找不到此場次'],
    [{code:'42501',message:'permission denied'},'此帳號沒有執行此功能的權限'],
    [new Error('Failed to fetch'),'無法連線至雲端'],
  ])('資料庫、權限與連線錯誤轉為可讀訊息',async(error,message)=>{
    remote.rpc.mockResolvedValue({data:null,error});
    await expect(simpleCheckIn(session,person)).rejects.toThrow(message as string);
  });
  it('本機與雲端錯誤訊息隱藏完整身分證',()=>{
    const message=simpleError({message:'人員 A 1-23456789 / ｂ２２３４５６７８９ 查詢失敗'});
    expect(message).toBe('人員 [身分證已隱藏] / [身分證已隱藏] 查詢失敗');
    expect(message).not.toContain('123456789');
  });
});
