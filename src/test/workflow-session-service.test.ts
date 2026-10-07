import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {WorkflowMode} from '../types';
const remote=vi.hoisted(()=>({from:vi.fn(),select:vi.fn(),insert:vi.fn(),single:vi.fn(),neq:vi.fn(),order:vi.fn(),rpc:vi.fn()}));
vi.mock('../lib/supabase',()=>({requireSupabase:()=>({from:remote.from,rpc:remote.rpc})}));
import {createSession,listSessions,updateSessionRoomCount} from '../features/sessions/service';
import {getQueueNumber,getWorkflowMode,isSimpleSession,isStandardSession} from '../features/workflow/mode';
import {mapParticipant} from '../features/schedule/service';
const row={id:'simple-session',session_date:'2026-10-07',company_name:'ITRI',status:'active' as const,room_count:4,workflow_mode:'simple' as const};
describe('場次 workflow 與共用資料相容',()=>{
  beforeEach(()=>{
    for(const fn of Object.values(remote))fn.mockReset();
    remote.from.mockReturnValue({insert:remote.insert,select:remote.select});remote.insert.mockReturnValue({select:remote.select});
    remote.select.mockReturnValue({single:remote.single,neq:remote.neq});remote.neq.mockReturnValue({order:remote.order});
    remote.single.mockResolvedValue({data:row,error:null});remote.rpc.mockResolvedValue({data:row,error:null});
  });
  it('簡易場次模式與診間數一起建立，返回模式持久化',async()=>{
    expect(await createSession('ITRI','2026-10-07','staff',2,'simple')).toMatchObject({workflowMode:'simple'});
    expect(remote.insert).toHaveBeenCalledWith({company_name:'ITRI',session_date:'2026-10-07',created_by:'staff',room_count:2,workflow_mode:'simple'});
  });
  it('非法 mode 儲存前拒絕，沒有寫入或替代建立',async()=>{
    await expect(createSession('ITRI','2026-10-07','staff',4,'unknown' as WorkflowMode)).rejects.toThrow('場次模式');
    expect(remote.from).not.toHaveBeenCalled();
  });
  it('讀取與場次切換保留各自 mode，missing/null 舊場次預設 standard',async()=>{
    remote.order.mockReturnValueOnce({order:remote.order}).mockResolvedValueOnce({data:[row,{...row,id:'legacy',workflow_mode:undefined},{...row,id:'legacy-null',workflow_mode:null}],error:null});
    const result=await listSessions();expect(result.map(value=>getWorkflowMode(value))).toEqual(['simple','standard','standard']);
    expect(isSimpleSession(result[0])).toBe(true);expect(isStandardSession(result[1])).toBe(true);
    expect(getWorkflowMode(null)).toBe('standard');
  });
  it('修改診間數量後仍保留原有簡易模式',async()=>{
    const result=await updateSessionRoomCount('simple-session',6);expect(result.workflowMode).toBe('simple');
    expect(remote.rpc).toHaveBeenCalledWith('update_session_room_count',{p_session_id:'simple-session',p_room_count:6});
  });
  it('simple participant 共用 mapper，真實 null group/slot、純數字 queue，沒有身分證',()=>{
    const person=mapParticipant({id:'person',session_id:row.id,sequence_no:12,employee_no:'B30040',full_name:'王小明',gender:'男',schedule_slot:null,group_code:null,queue_number:12,planned_items:['一般'],checkin_no:'12',status:'等候中',checked_in_at:'2026-10-07T00:00:00Z',called_at:null,note:'院內分機：1234',updated_at:'2026-10-07T00:00:00Z'});
    expect(person).toMatchObject({groupCode:null,slot:null,queueNumber:12,checkinNo:'12',plannedItems:['一般']});
    expect(person).not.toHaveProperty('nationalId');expect(getQueueNumber(person)).toBe(12);
    expect(getQueueNumber({checkinNo:'A12'})).toBeNull();expect(getQueueNumber({checkinNo:'0'})).toBeNull();
  });
});
