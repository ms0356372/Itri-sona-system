import {getStandardWaitingQueue} from '../features/workflow/service';
import {beforeEach,describe,expect,it,vi} from 'vitest';

const remote=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('../lib/supabase',()=>({requireSupabase:()=>({rpc:remote.rpc})}));

import {cancelPromotedParticipant,promoteWaitingParticipant} from '../features/console/service';

const first={participant_id:'participant-1',queue_position:1};
const second={participant_id:'participant-2',queue_position:2};

describe('標準模式候檢 queue RPC 邊界',()=>{
  beforeEach(()=>{remote.rpc.mockReset();});

  it.each([
    {name:'提早安排',run:()=>promoteWaitingParticipant('participant-1'),rpc:'promote_waiting_participant'},
    {name:'取消提早安排',run:()=>cancelPromotedParticipant('participant-1'),rpc:'cancel_promoted_participant'},
  ])('$name 僅傳 participant id，由伺服器決定時間與順位',async({run,rpc})=>{
    remote.rpc.mockResolvedValue({data:{promoted_at:'2026-10-16T00:30:00Z'},error:null});
    await expect(run()).resolves.toBeUndefined();
    expect(remote.rpc).toHaveBeenCalledExactlyOnceWith(rpc,{p_participant_id:'participant-1'});
  });

  it('查詢僅傳場次 id，使用伺服器順位而不依陣列順序重新編號',async()=>{
    remote.rpc.mockResolvedValue({data:[second,first],error:null});
    const queue=await getStandardWaitingQueue('session-1');
    expect(queue).toEqual(new Map([['participant-2',2],['participant-1',1]]));
    expect(queue.get('participant-1')).toBe(1);
    expect(queue.get('participant-2')).toBe(2);
    expect(remote.rpc).toHaveBeenCalledExactlyOnceWith('get_standard_waiting_queue',{p_session_id:'session-1'});
  });

  it('沒有等候者時接受空陣列，不捏造順位',async()=>{
    remote.rpc.mockResolvedValue({data:[],error:null});
    expect(await getStandardWaitingQueue('session-1')).toEqual(new Map());
  });

  it.each([
    {name:'提早安排',run:()=>promoteWaitingParticipant('participant-1')},
    {name:'取消提早安排',run:()=>cancelPromotedParticipant('participant-1')},
    {name:'查詢',run:()=>getStandardWaitingQueue('session-1')},
  ])('$name 保留 RPC 權限／業務錯誤，不偽造成功',async({run})=>{
    const error={code:'42501',message:'permission_denied'};
    remote.rpc.mockResolvedValue({data:[first],error});
    await expect(run()).rejects.toBe(error);
  });

  it.each([
    {name:'提早安排',run:()=>promoteWaitingParticipant('participant-1')},
    {name:'取消提早安排',run:()=>cancelPromotedParticipant('participant-1')},
    {name:'查詢',run:()=>getStandardWaitingQueue('session-1')},
  ])('$name 網路失敗直接回報，不以本機 queue fallback',async({run})=>{
    const error=new Error('network unavailable');
    remote.rpc.mockRejectedValue(error);
    await expect(run()).rejects.toBe(error);
  });

  it.each([
    {name:'null 回應',data:null},
    {name:'缺少回應',data:undefined},
    {name:'單列物件',data:first},
    {name:'null 列',data:[null]},
    {name:'陣列列',data:[[first]]},
    {name:'缺少 participant id',data:[{queue_position:1}]},
    {name:'非字串 participant id',data:[{participant_id:42,queue_position:1}]},
    {name:'空 participant id',data:[{participant_id:'',queue_position:1}]},
    {name:'空白 participant id',data:[{participant_id:' ',queue_position:1}]},
    {name:'前後空白 participant id',data:[{participant_id:' participant-1',queue_position:1}]},
    {name:'缺少順位',data:[{participant_id:'participant-1'}]},
    {name:'字串順位',data:[{...first,queue_position:'1'}]},
    {name:'零順位',data:[{...first,queue_position:0}]},
    {name:'負順位',data:[{...first,queue_position:-1}]},
    {name:'小數順位',data:[{...first,queue_position:1.5}]},
    {name:'NaN 順位',data:[{...first,queue_position:NaN}]},
    {name:'無限大順位',data:[{...first,queue_position:Infinity}]},
    {name:'不安全整數順位',data:[{...first,queue_position:Number.MAX_SAFE_INTEGER+1}]},
    {name:'重複 participant id',data:[first,{...first,queue_position:2}]},
    {name:'重複順位',data:[first,{...second,queue_position:1}]},
    {name:'缺少第一順位',data:[second]},
    {name:'順位有缺口',data:[first,{...second,queue_position:3}]},
    {name:'有效列後含無效列',data:[first,{}]},
  ])('拒絕$name，整批失敗避免產生另一套排序',async({data})=>{
    remote.rpc.mockResolvedValue({data,error:null});
    await expect(getStandardWaitingQueue('session-1')).rejects.toThrow(/^invalid_standard_waiting_queue$/);
  });

  it('回應中的額外資料不傳入 queue map',async()=>{
    remote.rpc.mockResolvedValue({data:[{...first,checked_in_at:'2026-10-16T00:30:00Z',promoted_at:'2026-10-16T01:00:00Z',full_name:'private-name'}],error:null});
    const queue=await getStandardWaitingQueue('session-1');
    expect([...queue]).toEqual([['participant-1',1]]);
  });
});
