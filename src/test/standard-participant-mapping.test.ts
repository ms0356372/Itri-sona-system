import {describe,expect,it} from 'vitest';
import {mapParticipant} from '../features/schedule/service';

const row={id:'participant',session_id:'session',sequence_no:120,employee_no:'123456',full_name:'王小明',gender:'男',schedule_slot:'07:30~08:00',group_code:'A' as const,planned_items:['腹部超音波'],checkin_no:'A8',status:'等候中' as const,checked_in_at:'2026-10-15T23:50:00.123456Z',called_at:null,note:'',updated_at:'2026-10-15T23:50:00.123456Z'};

describe('標準候檢所需的共用 Participant mapping',()=>{
  it('checkin_sequence 精確映射，與 sequence_no 排程序號分開',()=>{
    const mapped=mapParticipant({...row,checkin_sequence:8,promoted_at:null});
    expect(mapped).toMatchObject({sequence:120,checkinSequence:8,checkinNo:'A8',checkedInAt:row.checked_in_at,promotedAt:null});
  });

  it('promoted_at 原樣保留 server timestamp，不在 frontend 產生時間',()=>{
    const promotedAt='2026-10-16T00:01:02.123456+00:00';
    expect(mapParticipant({...row,checkin_sequence:8,promoted_at:promotedAt})).toHaveProperty('promotedAt',promotedAt);
  });

  it('null checkin_sequence 仍為 null，不能以 sequence_no 冒充',()=>{
    const mapped=mapParticipant({...row,checkin_sequence:null,promoted_at:null});
    expect(mapped.checkinSequence).toBeNull();expect(mapped.sequence).toBe(120);
  });

  it('缺少新欄位的舊 fixtures 保持相容，不加入偽造的序號或提早安排',()=>{
    const mapped=mapParticipant(row);
    expect(mapped).not.toHaveProperty('checkinSequence');expect(mapped).not.toHaveProperty('promotedAt');
    expect(mapped).not.toHaveProperty('nationalId');
  });

  it('simple queueNumber mapping 維持原樣，不以 checkinSequence 取代 queueNumber',()=>{
    const mapped=mapParticipant({...row,group_code:null,schedule_slot:null,checkin_no:'5',queue_number:5,checkin_sequence:null,promoted_at:null});
    expect(mapped).toMatchObject({queueNumber:5,checkinNo:'5',groupCode:null,slot:null,checkinSequence:null,promotedAt:null});
  });
});
