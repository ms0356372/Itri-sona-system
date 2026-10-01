import {beforeEach,describe,expect,it,vi} from 'vitest';

const {rpc}=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('../lib/supabase',()=>({requireSupabase:()=>({rpc})}));

import {enqueueAdditionalExamination} from '../features/examination/service';
import {formatAdditionalExaminationError} from '../lib/errors';

const response={id:'e2',participant_id:'p1',round_no:2,room_id:null,started_at:null,completed_at:null,duration_seconds:null,selected_items:['甲狀腺超音波'],actual_items:[],item_count:0,status:'waiting'};

describe('追加檢查送出',()=>{
  beforeEach(()=>rpc.mockReset());
  it('只用 participant id 與合法超音波項目呼叫 RPC',async()=>{rpc.mockResolvedValue({data:response,error:null});await enqueueAdditionalExamination('p1',['甲狀腺超音波']);expect(rpc).toHaveBeenCalledWith('enqueue_additional_examination',{p_participant_id:'p1',p_selected_items:['甲狀腺超音波']});});
  it('在 RPC 前阻止混入方案文字',async()=>{await expect(enqueueAdditionalExamination('p1',['一般','甲狀腺超音波'] as never)).rejects.toThrow('追加檢查項目資料異常，請重新選擇。');expect(rpc).not.toHaveBeenCalled();});
  it('將 Supabase 物件錯誤轉成友善訊息',()=>{const message=formatAdditionalExaminationError({message:'invalid_examination',code:'P0001'});expect(message).toBe('追加檢查項目不正確，請重新選擇。');expect(message).not.toContain('[object Object]');});
});
