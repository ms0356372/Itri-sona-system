import {beforeEach,describe,expect,it,vi} from 'vitest';

const remote=vi.hoisted(()=>({rpc:vi.fn(),put:vi.fn(),remove:vi.fn(),identity:vi.fn()}));
vi.mock('../lib/supabase',()=>({requireSupabase:()=>({rpc:remote.rpc})}));
vi.mock('../features/history/db',()=>({db:{drafts:{put:remote.put,delete:remote.remove}}}));
vi.mock('../features/room/device',()=>({getDeviceIdentity:remote.identity}));

import {completeExamination,startExamination} from '../features/examination/service';

const row={id:'exam-1',participant_id:'person-1',round_no:1,room_id:'room_1',started_at:'2026-10-07T00:01:00Z',completed_at:null,duration_seconds:null,selected_items:['腹部超音波'],actual_items:[],item_count:0,status:'in_progress'};

describe('診間檢查 RPC 的設備驗證',()=>{
  beforeEach(()=>{for(const mock of Object.values(remote))mock.mockReset();remote.identity.mockReturnValue({deviceId:'device-1',claimSecret:'local-device-secret'});remote.put.mockResolvedValue(undefined);remote.remove.mockResolvedValue(undefined);});

  it('開始檢查使用本機穩定設備憑證並保留既有草稿流程',async()=>{
    remote.rpc.mockResolvedValue({data:row,error:null});
    const result=await startExamination('person-1','診間 1',['腹部超音波']);
    expect(remote.rpc).toHaveBeenCalledWith('start_examination',{p_participant_id:'person-1',p_room_id:'診間 1',p_selected_items:['腹部超音波'],p_device_id:'device-1',p_device_secret:'local-device-secret'});
    expect(result.roomId).toBe('診間 1');
    expect(remote.put).toHaveBeenLastCalledWith({participantId:'person-1',roomId:'診間 1',items:['腹部超音波'],startedAt:row.started_at});
  });

  it('完成檢查帶設備憑證，雲端完成成功後才移除本機草稿',async()=>{
    remote.rpc.mockResolvedValue({data:{...row,status:'completed',completed_at:'2026-10-07T00:02:00Z',actual_items:['腹部超音波'],item_count:1,duration_seconds:60},error:null});
    await completeExamination('exam-1','person-1','診間 1',['腹部超音波']);
    expect(remote.rpc).toHaveBeenCalledWith('complete_examination',{p_examination_id:'exam-1',p_room_id:'診間 1',p_actual_items:['腹部超音波'],p_device_id:'device-1',p_device_secret:'local-device-secret'});
    expect(remote.remove).toHaveBeenCalledWith('person-1');
  });

  it('租約遭拒不刪除草稿，也不以其他憑證重試',async()=>{
    const error={code:'P0001',message:'room_claim_lost'};remote.rpc.mockResolvedValue({data:null,error});
    await expect(completeExamination('exam-1','person-1','診間 1',['腹部超音波'])).rejects.toEqual(error);
    expect(remote.remove).not.toHaveBeenCalled();expect(remote.rpc).toHaveBeenCalledTimes(1);
  });
});
