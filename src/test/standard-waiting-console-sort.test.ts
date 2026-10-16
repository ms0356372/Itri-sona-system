import {describe,expect,it} from 'vitest';
import {sortConsoleRows,type ConsoleSortDirection,type ConsoleSortMode} from '../features/console/sorting';
import type {Participant,WorkStatus} from '../types';

const person=(id:string,patch:Partial<Participant>={}):Participant=>({id,sessionId:'session',sequence:1,employeeNo:id,name:id,gender:'男',slot:null,groupCode:'A',plannedItems:['腹部超音波'],checkinNo:'A1',status:'等候中',checkedInAt:null,calledAt:null,note:'',updatedAt:'2026-10-16T00:00:00Z',...patch});
function sorted(rows:Participant[],{simple=false,mode='priority',direction='asc',ranks,rooms=new Map<string,string|null|undefined>()}:{simple?:boolean;mode?:ConsoleSortMode;direction?:ConsoleSortDirection;ranks?:ReadonlyMap<string,number>;rooms?:ReadonlyMap<string,string|null|undefined>}={}){
  return sortConsoleRows(rows,{simple,mode,direction,assignedRooms:rooms,roomCount:4,standardWaitingRanks:ranks}).map(row=>row.id);
}

describe('標準工作優先採用伺服器候檢順位',()=>{
  const rows=[person('A1',{checkinNo:'A1'}),person('A2',{checkinNo:'A2'}),person('B1',{checkinNo:'B1'})];
  const ranks=new Map([['B1',1],['A2',2],['A1',3]]);

  it.each(['asc','desc'] as const)('工作優先%s保留伺服器完整候檢順序，不由報到號碼重排',direction=>{
    expect(sorted(rows,{ranks,direction})).toEqual(['B1','A2','A1']);
  });

  it('候檢順位只改等候中人員，其他狀態維持原優先及報到號碼順序',()=>{
    const statuses:WorkStatus[]=['檢查中','已叫號','上廁所','心電圖','先做其他','未報到','已完成'];
    const others=statuses.flatMap(status=>[person(`${status}-A2`,{status,checkinNo:'A2'}),person(`${status}-A1`,{status,checkinNo:'A1'})]);
    const allRanks=new Map([...ranks,...others.map((row,index)=>[row.id,100-index] as const)]);
    expect(sorted([...others,...rows],{ranks:allRanks})).toEqual([
      '檢查中-A1','檢查中-A2','已叫號-A1','已叫號-A2','B1','A2','A1',
      '上廁所-A1','上廁所-A2','心電圖-A1','心電圖-A2','先做其他-A1','先做其他-A2','未報到-A1','未報到-A2','已完成-A1','已完成-A2',
    ]);
  });

  it.each(['asc','desc'] as const)('手動號碼%s忽略候檢順位',direction=>{
    expect(sorted(rows,{mode:'queue',direction,ranks})).toEqual(direction==='asc'?['A1','A2','B1']:['B1','A2','A1']);
  });

  it.each(['asc','desc'] as const)('手動診間%s及同診間優先仍沿用原本報到號碼',direction=>{
    const assigned=[...rows,person('called',{status:'已叫號',checkinNo:'A9'}),person('room2',{checkinNo:'A1'})];
    const rooms=new Map(assigned.map(row=>[row.id,row.id==='room2'?'room_2':'room_1']));
    expect(sorted(assigned,{mode:'room',direction,rooms,ranks})).toEqual(direction==='asc'?['called','A1','A2','B1','room2']:['room2','called','A1','A2','B1']);
  });

  it('手動診間中未分配的人員也不受候檢順位影響',()=>{
    expect(sorted(rows,{mode:'room',ranks})).toEqual(['A1','A2','B1']);
  });

  it.each(['priority','queue','room'] as const)('簡易模式%s忽略標準候檢順位',mode=>{
    const simpleRows=[1,2,10].map(number=>person(String(number),{checkinNo:String(number),queueNumber:number}));
    const reversedRanks=new Map([['10',1],['2',2],['1',3]]);
    expect(sorted(simpleRows,{simple:true,mode,ranks:reversedRanks})).toEqual(['1','2','10']);
  });

  it('篩選後子名單使用全場順位，無需把非連續順位重新編號',()=>{
    const filtered=[person('same-group-late',{checkinNo:'A2'}),person('same-group-early',{checkinNo:'A1'})];
    const globalRanks=new Map([['other-group',1],['same-group-late',4],['same-group-early',8]]);
    expect(sorted(filtered,{ranks:globalRanks})).toEqual(['same-group-late','same-group-early']);
  });

  it('暫缺順位的等候者固定排在有順位者之後，缺漏者沿用原本號碼排序',()=>{
    const partialRows=[...rows,person('A10',{checkinNo:'A10'})];
    expect(sorted(partialRows,{ranks:new Map([['B1',5]])})).toEqual(['B1','A1','A2','A10']);
  });

  it('相同順位以既有報到號碼穩定排序',()=>{
    expect(sorted([...rows].reverse(),{ranks:new Map(rows.map(row=>[row.id,1]))})).toEqual(['A1','A2','B1']);
  });

  it('缺少或尚無順位資料時，維持既有工作優先排序',()=>{
    expect(sorted([...rows].reverse())).toEqual(['A1','A2','B1']);
    expect(sorted([...rows].reverse(),{ranks:new Map()})).toEqual(['A1','A2','B1']);
  });

  it('排序不修改原始人員、陣列與伺服器順位',()=>{
    const frozenRows=Object.freeze(rows.map(row=>Object.freeze({...row})));
    const snapshot=JSON.stringify(frozenRows);
    const rankSnapshot=[...ranks];
    const result=sortConsoleRows(frozenRows as unknown as Participant[],{simple:false,mode:'priority',direction:'asc',assignedRooms:new Map(),roomCount:4,standardWaitingRanks:ranks});
    expect(result).not.toBe(frozenRows);
    expect(result.map(row=>row.id)).toEqual(['B1','A2','A1']);
    expect(JSON.stringify(frozenRows)).toBe(snapshot);
    expect([...ranks]).toEqual(rankSnapshot);
  });
});
