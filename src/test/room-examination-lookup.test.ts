import {beforeEach,describe,expect,it,vi} from 'vitest';
import {getExamination,getRoomExamination} from '../features/examination/service';

type ExaminationRow={id:string;participant_id:string;round_no:number;room_id:string|null;started_at:string|null;completed_at:string|null;duration_seconds:number|null;selected_items:string[];actual_items:string[];item_count:number;status:'waiting'|'in_progress'|'completed';participants:{session_id:string}};
type Query={table:string;selection:string;equals:[string,unknown][];inFilters:[string,unknown[]][];order:{column:string;ascending:boolean}|null;limit:number|null};
const remote=vi.hoisted(()=>({from:vi.fn(),rows:[] as ExaminationRow[],queries:[] as Query[]}));
vi.mock('../lib/supabase',()=>({requireSupabase:()=>({from:remote.from})}));

const startedAt='2026-10-07T01:02:03.456789+00:00';
const row=(patch:Partial<ExaminationRow>={}):ExaminationRow=>({id:'current-round',participant_id:'person-1',round_no:2,room_id:'診間1',started_at:startedAt,completed_at:null,duration_seconds:null,selected_items:['腹部超音波','甲狀腺超音波'],actual_items:[],item_count:0,status:'in_progress',participants:{session_id:'current-session'},...patch});
const field=(value:ExaminationRow,column:string)=>column==='participants.session_id'?value.participants.session_id:value[column as keyof ExaminationRow];

beforeEach(()=>{
  remote.from.mockReset();remote.rows=[];remote.queries=[];
  remote.from.mockImplementation((table:string)=>{
    const query:Query={table,selection:'',equals:[],inFilters:[],order:null,limit:null};
    remote.queries.push(query);
    const chain={select:vi.fn(),eq:vi.fn(),in:vi.fn(),order:vi.fn(),limit:vi.fn(),maybeSingle:vi.fn()};
    chain.select.mockImplementation((selection:string)=>{query.selection=selection;return chain;});
    chain.eq.mockImplementation((column:string,value:unknown)=>{query.equals.push([column,value]);return chain;});
    chain.in.mockImplementation((column:string,values:unknown[])=>{query.inFilters.push([column,values]);return chain;});
    chain.order.mockImplementation((column:string,options:{ascending:boolean})=>{query.order={column,ascending:options.ascending};return chain;});
    chain.limit.mockImplementation((limit:number)=>{query.limit=limit;return chain;});
    chain.maybeSingle.mockImplementation(async()=>{
      let found=remote.rows.filter(value=>query.equals.every(([column,expected])=>field(value,column)===expected)&&query.inFilters.every(([column,values])=>values.includes(field(value,column))));
      if(query.order){const{column,ascending}=query.order;found=[...found].sort((a,b)=>String(field(a,column)).localeCompare(String(field(b,column)),undefined,{numeric:true})*(ascending?1:-1));}
      if(query.limit!==null)found=found.slice(0,query.limit);
      return found.length>1?{data:null,error:new Error('multiple_examinations')}:{data:found[0]??null,error:null};
    });
    return chain;
  });
});

describe('診間檢查查詢的舊名稱相容性',()=>{
  it.each(['診間1','診間 1'])('以 %s 查詢能恢復舊資料列的正規診間、原輪次與原始雲端開始時間',async requestedRoom=>{
    remote.rows=[
      row({id:'other-session',participants:{session_id:'other-session'}}),
      row({id:'other-room',room_id:'診間 2'}),
      row({id:'completed-round',round_no:1,status:'completed',completed_at:'2026-10-06T02:00:00Z'}),
      row(),
    ];
    const restored=await getRoomExamination('current-session',requestedRoom);
    expect(restored).toEqual({id:'current-round',participantId:'person-1',roundNo:2,roomId:'診間 1',startedAt,completedAt:null,durationSeconds:null,selectedItems:['腹部超音波','甲狀腺超音波'],actualItems:[],itemCount:0,status:'in_progress'});
    expect(remote.queries[0]).toMatchObject({table:'examinations',selection:'*,participants!inner(session_id)'});
    expect(remote.queries[0].equals).toContainEqual(['participants.session_id','current-session']);
    expect(remote.queries[0].inFilters).toContainEqual(['room_id',['診間 1','診間1','room_1']]);
    expect(remote.rows[3].room_id).toBe('診間1');expect(remote.rows[3].started_at).toBe(startedAt);
  });

  it('正規診間資料列亦能恢復，不選到同診間的 waiting 或其他場次受檢者',async()=>{
    remote.rows=[row({id:'next-waiting',status:'waiting',started_at:null}),row({id:'foreign-session',room_id:'診間 1',participants:{session_id:'another-session'}}),row({room_id:'診間 1'})];
    expect(await getRoomExamination('current-session','診間1')).toMatchObject({id:'current-round',roomId:'診間 1',startedAt,status:'in_progress'});
  });

  it('只有其他場次、其他診間或已完成檢查時回傳 null，不復用無關受檢者',async()=>{
    remote.rows=[row({participants:{session_id:'another-session'}}),row({room_id:'診間 3'}),row({status:'completed',completed_at:'2026-10-07T01:03:03Z',duration_seconds:60})];
    expect(await getRoomExamination('current-session','診間 1')).toBeNull();
  });

  it('依受檢者恢復最新進行中輪次時也正規化舊診間名稱，保留毫秒以下開始時間與項目',async()=>{
    remote.rows=[row({id:'old-completed',round_no:1,status:'completed'}),row({id:'foreign-person',participant_id:'another-person',round_no:5}),row({room_id:'診間4',round_no:3})];
    const restored=await getExamination('person-1');
    expect(restored).toMatchObject({id:'current-round',participantId:'person-1',roundNo:3,roomId:'診間 4',startedAt,selectedItems:['腹部超音波','甲狀腺超音波'],status:'in_progress'});
    expect(remote.rows[2].room_id).toBe('診間4');expect(remote.rows[2].started_at).toBe(startedAt);
  });

  it('等待追加且尚未指定診間的輪次保留 null 與原項目，不產生偽造診間或開始時間',async()=>{
    remote.rows=[row({room_id:null,status:'waiting',started_at:null})];
    expect(await getExamination('person-1')).toMatchObject({roomId:null,startedAt:null,status:'waiting',selectedItems:['腹部超音波','甲狀腺超音波']});
  });

  it.each(['診間8','診間 8','room_8'])('擴增診間後以%s查詢保留舊別名並恢復原檢查資料',async roomId=>{
    remote.rows=[row({room_id:'room_8'})];
    expect(await getRoomExamination('current-session',roomId)).toMatchObject({roomId:'診間 8',startedAt,status:'in_progress'});
    expect(remote.queries[0].inFilters).toContainEqual(['room_id',['診間 8','診間8','room_8']]);
  });
});
