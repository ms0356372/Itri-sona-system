import {describe,expect,it} from 'vitest';
import {getAssignedRoom,sortConsoleRows,statusPriority,type ConsoleSortDirection,type ConsoleSortMode} from '../features/console/sorting';
import type {Examination,Participant,WorkStatus} from '../types';

const person=(id:string,patch:Partial<Participant>={}):Participant=>({id,sessionId:'session',sequence:1,employeeNo:id,name:id,gender:'男',slot:null,groupCode:'A',plannedItems:['腹部超音波'],checkinNo:'A1',status:'等候中',checkedInAt:null,calledAt:null,note:'',updatedAt:'2026-10-08T00:00:00Z',...patch});
const examination=(patch:Partial<Examination>={}):Examination=>({id:'exam',participantId:'person',roundNo:1,roomId:'room_1',startedAt:null,completedAt:null,durationSeconds:null,selectedItems:['腹部超音波'],actualItems:[],itemCount:0,status:'waiting',...patch});
function sorted(rows:Participant[],{simple=false,mode='priority',direction='asc',rooms=new Map<string,string|null|undefined>(),roomCount=4}:{simple?:boolean;mode?:ConsoleSortMode;direction?:ConsoleSortDirection;rooms?:ReadonlyMap<string,string|null|undefined>;roomCount?:number}={}){
  return sortConsoleRows(rows,{simple,mode,direction,assignedRooms:rooms,roomCount}).map(row=>row.id);
}

describe('控制台顯示排序',()=>{
  const statuses:WorkStatus[]=['檢查中','已叫號','等候中','上廁所','心電圖','先做其他','未報到','已完成'];

  it('工作優先的八個狀態順序固定，完成者置後',()=>{
    expect(statuses.map(statusPriority)).toEqual([0,1,2,3,4,5,6,7]);
    const rows=statuses.map((status,index)=>person(status,{status,checkinNo:`A${8-index}`})).reverse();
    expect(sorted(rows)).toEqual(statuses);
    expect(sorted(rows,{direction:'desc'})).toEqual(statuses);
  });

  it.each([false,true])('工作優先同狀態使用%s模式的號碼升序，輸入順序不影響結果',simple=>{
    const rows=[10,3,1,2].map(number=>person(String(number),{checkinNo:simple?String(number):`A${number}`,queueNumber:simple?number:null}));
    expect(sorted(rows,{simple})).toEqual(['1','2','3','10']);
    expect(sorted(rows,{simple,direction:'desc'})).toEqual(['1','2','3','10']);
  });

  it('簡易號碼依數值排序1、2、3、10，queueNumber優先沿用現有規則',()=>{
    const rows=[person('10',{checkinNo:'10'}),person('2',{checkinNo:'99',queueNumber:2}),person('3',{checkinNo:'3'}),person('1',{checkinNo:'1'})];
    expect(sorted(rows,{simple:true,mode:'queue'})).toEqual(['1','2','3','10']);
    expect(sorted(rows,{simple:true,mode:'queue',direction:'desc'})).toEqual(['10','3','2','1']);
  });

  it('標準號碼依組別及數字部分排序，A10不會排在A2前',()=>{
    const rows=['B1','A10','A2','A1'].map(checkinNo=>person(checkinNo,{checkinNo}));
    expect(sorted(rows,{mode:'queue'})).toEqual(['A1','A2','A10','B1']);
    expect(sorted(rows,{mode:'queue',direction:'desc'})).toEqual(['B1','A10','A2','A1']);
  });

  it.each([false,true])('不論%s模式的號碼方向，缺號與無效號碼都在有效號碼後，並依sequence排列',simple=>{
    const rows=[
      person('missing',{checkinNo:null,sequence:6}),
      person('invalid',{checkinNo:simple?'A3':'H3',sequence:4}),
      person('two',{checkinNo:simple?'2':'A2',sequence:8}),
      person('one',{checkinNo:simple?'1':'A1',sequence:9}),
      person('zero',{checkinNo:simple?'0':'A0',sequence:5}),
    ];
    expect(sorted(rows,{simple,mode:'queue'})).toEqual(['one','two','invalid','zero','missing']);
    expect(sorted(rows,{simple,mode:'queue',direction:'desc'})).toEqual(['two','one','invalid','zero','missing']);
  });

  it('有效最大安全整數號碼仍排在缺號之前',()=>{
    const rows=[person('missing',{checkinNo:null,sequence:1}),person('max',{checkinNo:String(Number.MAX_SAFE_INTEGER),sequence:3}),person('unsafe',{checkinNo:String(Number.MAX_SAFE_INTEGER+1),sequence:2})];
    expect(sorted(rows,{simple:true,mode:'queue'})).toEqual(['max','missing','unsafe']);
    expect(sorted(rows,{simple:true,mode:'queue',direction:'desc'})).toEqual(['max','missing','unsafe']);
  });

  it.each([false,true])('相同%s模式號碼固定以sequence及id升序作最後比較，不隨方向顛倒',simple=>{
    const rows=[person('z',{checkinNo:simple?'2':'A2',sequence:3}),person('b',{checkinNo:simple?'2':'A2',sequence:2}),person('a',{checkinNo:simple?'2':'A2',sequence:2})];
    expect(sorted(rows,{simple,mode:'queue'})).toEqual(['a','b','z']);
    expect(sorted(rows,{simple,mode:'queue',direction:'desc'})).toEqual(['a','b','z']);
  });

  it.each(['asc','desc'] as const)('診間%s以數值排列，無診間固定最後',direction=>{
    const rows=['none','3','1','2'].map(id=>person(id));
    const rooms=new Map([['1','room_1'],['2','診間2'],['3','診間 3']]);
    expect(sorted(rows,{mode:'room',direction,rooms})).toEqual(direction==='asc'?['1','2','3','none']:['3','2','1','none']);
  });

  it.each(['asc','desc'] as const)('診間%s只改房號方向，同診間維持工作優先及號碼升序',direction=>{
    const rows=[
      person('room2-completed',{status:'已完成'}),
      person('waiting10',{checkinNo:'A10'}),
      person('calling',{status:'已叫號',checkinNo:'A4'}),
      person('waiting2',{checkinNo:'A2'}),
      person('examining',{status:'檢查中',checkinNo:'A8'}),
      person('completed',{status:'已完成',checkinNo:'A1'}),
    ];
    const rooms=new Map(rows.map(row=>[row.id,row.id==='room2-completed'?'room_2':'room_1']));
    const room1=['examining','calling','waiting2','waiting10','completed'];
    expect(sorted(rows,{mode:'room',direction,rooms})).toEqual(direction==='asc'?[...room1,'room2-completed']:['room2-completed',...room1]);
  });

  it.each(['asc','desc'] as const)('無效及超出場次數量的診間%s視為未分配，同組仍依工作優先',direction=>{
    const rows=[
      person('disabled',{status:'已完成'}),
      person('unknown',{status:'檢查中'}),
      person('missing',{status:'等候中',checkinNo:'A2'}),
      person('alias',{status:'已完成'}),
      person('null',{status:'已叫號'}),
    ];
    const rooms=new Map<string,string|null>([['disabled','room_4'],['unknown','other'],['alias',' 診間 3 '],['null',null]]);
    expect(sorted(rows,{mode:'room',direction,rooms,roomCount:3})).toEqual(['alias','unknown','null','missing','disabled']);
  });

  it('診間別名歸入相同數值診間，並且不因字串格式改變排序',()=>{
    const rows=[person('waiting2',{checkinNo:'A2'}),person('examining',{status:'檢查中'}),person('waiting1',{checkinNo:'A1'})];
    const rooms=new Map([['waiting2','room_2'],['examining','診間 2'],['waiting1','診間2']]);
    expect(sorted(rows,{mode:'room',direction:'desc',rooms})).toEqual(['examining','waiting1','waiting2']);
  });

  it('任何排序只回傳新陣列，不修改participants或examinations資料',()=>{
    const rounds=Object.freeze([Object.freeze(examination({status:'in_progress',roomId:'room_3'}))]);
    const rows=Object.freeze([Object.freeze(person('done',{status:'已完成'})),Object.freeze(person('exam',{status:'檢查中'}))]);
    const snapshot=JSON.stringify({rows,rounds});
    const rooms=new Map(rows.map(row=>[row.id,getAssignedRoom(row,rounds as unknown as Examination[])]));
    for(const mode of ['priority','queue','room'] as const){
      const result=sortConsoleRows(rows as unknown as Participant[],{simple:false,mode,direction:'desc',assignedRooms:rooms,roomCount:4});
      expect(result).not.toBe(rows);
      expect(result.every(row=>rows.includes(row))).toBe(true);
    }
    expect(JSON.stringify({rows,rounds})).toBe(snapshot);
  });
});

describe('控制台沿用既有診間取值',()=>{
  it('檢查中只取in_progress，即使較早列出waiting與completed輪次',()=>{
    const rounds=[examination({status:'completed',roomId:'room_1'}),examination({status:'waiting',roomId:'room_2'}),examination({status:'in_progress',roomId:'room_3'})];
    expect(getAssignedRoom({status:'檢查中'},rounds)).toBe('room_3');
  });

  it.each(['waiting','completed'] as const)('檢查中沒有in_progress時不沿用%s房號',status=>{
    expect(getAssignedRoom({status:'檢查中'},[examination({status,roomId:'room_2'})])).toBeUndefined();
  });

  it('檢查中本輪roomId為null時不退回歷史房號',()=>{
    expect(getAssignedRoom({status:'檢查中'},[examination({status:'completed',roomId:'room_1'}),examination({status:'in_progress',roomId:null})])).toBeNull();
  });

  it.each(['未報到','等候中','已叫號','上廁所','心電圖','先做其他','已完成'] as const)('%s保留第一個waiting或in_progress房號',status=>{
    const rounds=[examination({status:'completed',roomId:'room_1'}),examination({status:'waiting',roomId:'room_2'}),examination({status:'in_progress',roomId:'room_3'})];
    expect(getAssignedRoom({status},rounds)).toBe('room_2');
  });

  it('非檢查中沒有可用active房號時沿用最後列出的completed，不另以roundNo重排',()=>{
    const rounds=[examination({status:'completed',roundNo:8,roomId:'room_3'}),examination({status:'in_progress',roomId:null}),examination({status:'completed',roundNo:1,roomId:'room_2'})];
    expect(getAssignedRoom({status:'等候中'},rounds)).toBe('room_2');
    expect(getAssignedRoom({status:'已完成'},[])).toBeUndefined();
  });
});
