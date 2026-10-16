import {describe,expect,it} from 'vitest';
import {buildWaitingQueue,compareWaitingParticipants} from '../features/workflow/waitingQueue';
import type {Participant,WorkStatus} from '../types';

const standard={workflowMode:'standard' as const};
const simple={workflowMode:'simple' as const};
const person=(id:string,patch:Partial<Participant>={}):Participant=>({
  id,sessionId:'session',sequence:1,employeeNo:`employee-${id}`,name:`姓名${id}`,gender:'男',
  slot:'07:30-08:00',groupCode:'A',plannedItems:['腹部超音波'],checkinNo:'A1',
  status:'等候中',checkedInAt:'2026-10-16T00:00:00Z',calledAt:null,note:'',
  updatedAt:'2026-10-16T00:00:00Z',...patch,
});
const ranks=(ids:readonly string[])=>new Map(ids.map((id,index)=>[id,index+1]));
const ids=(rows:readonly Participant[]|undefined)=>rows?.map(row=>row.id);
const waitingEmployees=(rows:readonly Participant[]|undefined)=>rows?.filter(row=>row.status==='等候中').map(row=>row.employeeNo);

/** The public RPC returns these safe people in the canonical SQL queue order.
 * Keep that order as a fixture, rather than rebuilding the queue in this test.
 */
function serverSnapshot(ordered:readonly Participant[]){
  return {
    ranks:ranks(ordered.map(row=>row.id)),
    publicPeople:ordered.map(row=>({employeeNo:row.employeeNo,maskedName:'姓○名'})),
  };
}

describe('共用候檢 builder：標準模式沿用公開看板的伺服器最終順位',()=>{
  it('等候者依 server rank 完整集中在最前方，未報到及已叫號者依原相對順序接在後方',()=>{
    const b1=person('B1');const x=person('X',{status:'未報到'});
    const a1=person('A1');const y=person('Y',{status:'已叫號'});const a2=person('A2');
    const snapshot=serverSnapshot([a1,a2,b1]);
    const result=buildWaitingQueue(standard,[b1,x,a1,y,a2],snapshot.ranks);
    expect(ids(result)).toEqual(['A1','A2','B1','X','Y']);
    expect(result?.slice(0,3).every(row=>row.status==='等候中')).toBe(true);
    expect(result?.slice(3).every(row=>row.status!=='等候中')).toBe(true);
    expect(waitingEmployees(result)).toEqual(snapshot.publicPeople.map(row=>row.employeeNo));
    expect(result?.[3]).toBe(x);expect(result?.[4]).toBe(y);
  });

  it('A、B、C、G promoted、D 的公開順位不受原始陣列、姓名、工號或 Excel sequence 影響',()=>{
    const a=person('A',{sequence:100,name:'林',employeeNo:'999'});
    const b=person('B',{sequence:90,name:'陳',employeeNo:'888'});
    const c=person('C',{sequence:80,name:'王',employeeNo:'777'});
    const g=person('G',{sequence:1,groupCode:'G',checkinNo:'G1',promotedAt:'2026-10-16T00:20:00Z'});
    const d=person('D',{sequence:2,name:'丁',employeeNo:'000'});
    const snapshot=serverSnapshot([a,b,c,g,d]);
    const result=buildWaitingQueue(standard,[d,g,c,a,b],snapshot.ranks);
    expect(ids(result)).toEqual(['A','B','C','G','D']);
    expect(waitingEmployees(result)).toEqual(snapshot.publicPeople.map(row=>row.employeeNo));
  });

  it('遲到者的 effective group 已在伺服器順位中反映，診間不再以 A1 或早期 Excel 順序搶先',()=>{
    const late=person('late-A',{groupCode:'A',checkinNo:'A1',sequence:1,checkedInAt:'2026-10-16T02:05:00Z'});
    const onTime=person('on-time-E',{groupCode:'E',checkinNo:'E8',sequence:100,checkedInAt:'2026-10-16T01:40:00Z'});
    const snapshot=serverSnapshot([onTime,late]);
    const result=buildWaitingQueue(standard,[late,onTime],snapshot.ranks);
    expect(ids(result)).toEqual(['on-time-E','late-A']);
    expect(waitingEmployees(result)).toEqual(snapshot.publicPeople.map(row=>row.employeeNo));
  });

  it('前三有人被叫走後，採用新 server rank，提早安排者自然遞補進第三',()=>{
    const a=person('A');const b=person('B');const c=person('C');
    const g=person('G',{groupCode:'G',promotedAt:'2026-10-16T00:20:00Z'});const d=person('D');
    const original=[d,g,a,c,b];
    expect(ids(buildWaitingQueue(standard,original,ranks(['A','B','C','G','D'])))).toEqual(['A','B','C','G','D']);
    const calledA={...a,status:'已叫號' as const};
    const next=[d,g,calledA,c,b];
    const snapshot=serverSnapshot([b,c,g,d]);
    const result=buildWaitingQueue(standard,next,snapshot.ranks);
    expect(ids(result)).toEqual(['B','C','G','D','A']);
    expect(result?.[4]).toBe(calledA);
    expect(waitingEmployees(result)).toEqual(snapshot.publicPeople.map(row=>row.employeeNo));
  });

  it('回到等候中後重新採用完整 queue，不沿用前一次診間位置',()=>{
    const a=person('A');const b=person('B');const c=person('C');
    const g=person('G',{groupCode:'G',promotedAt:'2026-10-16T00:20:00Z'});const d=person('D');
    const calledA={...a,status:'已叫號' as const};
    expect(ids(buildWaitingQueue(standard,[b,c,calledA,g,d],ranks(['B','C','G','D'])))).toEqual(['B','C','G','D','A']);
    const snapshot=serverSnapshot([a,b,c,g,d]);
    const result=buildWaitingQueue(standard,[b,c,a,g,d],snapshot.ranks);
    expect(ids(result)).toEqual(['A','B','C','G','D']);
    expect(waitingEmployees(result)).toEqual(snapshot.publicPeople.map(row=>row.employeeNo));
  });

  it('取消提早安排時，立即依新的 Base Queue rank 恢復與公開看板相同順序',()=>{
    const a=person('A');const b=person('B');const c=person('C');const d=person('D');
    const g=person('G',{groupCode:'G',promotedAt:'2026-10-16T00:20:00Z'});
    const unreported=person('unreported',{status:'未報到'});const called=person('called',{status:'已叫號'});
    const rows=[unreported,g,d,called,c,b,a];
    expect(ids(buildWaitingQueue(standard,rows,ranks(['A','B','C','G','D'])))).toEqual(['A','B','C','G','D','unreported','called']);
    const cancelled={...g,promotedAt:null};
    const snapshot=serverSnapshot([a,b,c,d,cancelled]);
    const result=buildWaitingQueue(standard,[unreported,cancelled,d,called,c,b,a],snapshot.ranks);
    expect(ids(result)).toEqual(['A','B','C','D','G','unreported','called']);
    expect(waitingEmployees(result)).toEqual(snapshot.publicPeople.map(row=>row.employeeNo));
  });

  it('新人由未報到變成等候中後插入正式 queue，而非保留原本 Excel 位置',()=>{
    const newcomer=person('new',{status:'未報到',sequence:1});const third=person('third');
    const first=person('first');const called=person('called',{status:'已叫號'});
    expect(ids(buildWaitingQueue(standard,[newcomer,third,called,first],ranks(['first','third'])))).toEqual(['first','third','new','called']);
    const arrived={...newcomer,status:'等候中' as const};
    const snapshot=serverSnapshot([first,arrived,third]);
    const result=buildWaitingQueue(standard,[arrived,third,called,first],snapshot.ranks);
    expect(ids(result)).toEqual(['first','new','third','called']);
    expect(waitingEmployees(result)).toEqual(snapshot.publicPeople.map(row=>row.employeeNo));
  });

  it('只選取部分候檢人員時仍沿用全場順位，不要求 rank 從一開始或連續',()=>{
    const rows=[person('rank-12'),person('rank-4'),person('rank-8')];
    const globalRanks=new Map([['elsewhere',1],['rank-4',4],['rank-8',8],['rank-12',12]]);
    expect(ids(buildWaitingQueue(standard,rows,globalRanks))).toEqual(['rank-4','rank-8','rank-12']);
  });

  const otherStatuses:WorkStatus[]=['未報到','已叫號','上廁所','心電圖','先做其他','檢查中','已完成'];
  it.each(otherStatuses)('保留 %s 的可見性及物件，移至全部等候者之後',status=>{
    const other=person('other',{status});const first=person('first');const second=person('second');
    const result=buildWaitingQueue(standard,[second,other,first],ranks(['first','second']));
    expect(ids(result)).toEqual(['first','second','other']);
    expect(result?.[2]).toBe(other);
    expect(result).toHaveLength(3);
  });

  it('所有七種其他狀態混合時完整保留原相對順序，且全部在連續 waiting 區之後',()=>{
    const first=person('first');const second=person('second');
    const other=otherStatuses.map(status=>person(status,{status}));
    const rows=[other[0],second,other[1],first,...other.slice(2)];
    const result=buildWaitingQueue(standard,rows,ranks(['first','second']));
    expect(ids(result)).toEqual(['first','second',...otherStatuses]);
    expect(result).toHaveLength(rows.length);
    expect(result?.slice(2)).toEqual(other);
    expect(result?.slice(2).every((row,index)=>row===other[index])).toBe(true);
  });

  it.each(otherStatuses)('等候者變成 %s 時立即離開上方 waiting 區，依原相對順序進入其他人員區',status=>{
    const first=person('first');const second=person('second');const called=person('called',{status:'已叫號'});
    expect(ids(buildWaitingQueue(standard,[second,called,first],ranks(['first','second'])))).toEqual(['first','second','called']);
    const changed={...first,status};
    const result=buildWaitingQueue(standard,[second,called,changed],ranks(['second']));
    expect(ids(result)).toEqual(['second','called','first']);
    expect(result?.[2]).toBe(changed);
  });

  it('沒有取得 server rank 時不以本機時間、checkinNo 或原陣列冒充正式順位',()=>{
    const rows=[person('B',{checkinNo:'B1'}),person('A',{checkinNo:'A1'})];
    expect(buildWaitingQueue(standard,rows)).toBeUndefined();
  });

  it('任一候檢人員缺少 rank，等待下一次完整 server queue，不回傳局部排序',()=>{
    const rows=[person('new-arrival'),person('existing'),person('called',{status:'已叫號'})];
    expect(buildWaitingQueue(standard,rows,ranks(['existing']))).toBeUndefined();
  });

  it('空名單與完全沒有等候者時回傳原內容的新陣列，不需要 queue request',()=>{
    const rows=[person('called',{status:'已叫號'}),person('done',{status:'已完成'})];
    const result=buildWaitingQueue(standard,rows);
    expect(result).toEqual(rows);expect(result).not.toBe(rows);
    const empty:Participant[]=[];
    expect(buildWaitingQueue(standard,empty)).toEqual([]);
    expect(buildWaitingQueue(standard,empty)).not.toBe(empty);
  });

  it.each([null,{}, {workflowMode:null}])('舊場次 mode=%s 仍走 standard 並要求 server rank',session=>{
    const rows=[person('B'),person('A')];
    expect(buildWaitingQueue(session,rows)).toBeUndefined();
    expect(ids(buildWaitingQueue(session,rows,ranks(['A','B'])))).toEqual(['A','B']);
  });

  it('不改動 frozen participants、物件或共享 server rank map',()=>{
    const a=Object.freeze(person('A'));const b=Object.freeze(person('B'));
    const called=Object.freeze(person('called',{status:'已叫號'}));
    const rows=Object.freeze([b,called,a]);const serverRanks=ranks(['A','B']);
    const originalRanks=[...serverRanks];
    const result=buildWaitingQueue(standard,rows,serverRanks);
    expect(result).not.toBe(rows);expect(ids(rows)).toEqual(['B','called','A']);
    expect(result?.[0]).toBe(a);expect(result?.[1]).toBe(b);expect(result?.[2]).toBe(called);
    expect([...serverRanks]).toEqual(originalRanks);
  });
});

describe('共用候檢 builder：簡易模式與公開看板一樣以數字 queueNumber 排序',()=>{
  it('1、2、3、10 的 waiting 全部在最前，其他狀態即使號碼較小仍排後且不改原相對順序',()=>{
    const one=person('1',{queueNumber:1});const two=person('2',{queueNumber:2});
    const three=person('3',{queueNumber:3});const ten=person('10',{queueNumber:10});
    const called=person('called',{status:'已叫號',queueNumber:1});
    const unreported=person('unreported',{status:'未報到',queueNumber:null,checkinNo:null});
    const done=person('done',{status:'已完成',queueNumber:2});
    const snapshot=serverSnapshot([one,two,three,ten]);
    const rows=[called,ten,unreported,three,done,two,one];
    const result=buildWaitingQueue(simple,rows);
    expect(ids(result)).toEqual(['1','2','3','10','called','unreported','done']);
    expect(waitingEmployees(result)).toEqual(snapshot.publicPeople.map(row=>row.employeeNo));
    expect(result?.slice(0,4).every(row=>row.status==='等候中')).toBe(true);
    expect(result?.slice(4)).toEqual([called,unreported,done]);
    expect(result).toHaveLength(rows.length);
  });

  it('1、2、3、10 依數值排列，且不使用 standard rank、姓名或 sequence 作主要排序',()=>{
    const rows=[10,3,2,1].map((number,index)=>person(String(number),{queueNumber:number,sequence:index,name:`name-${index}`}));
    const result=buildWaitingQueue(simple,rows,ranks(['10','3','2','1']));
    expect(ids(result)).toEqual(['1','2','3','10']);
  });

  it('新報到者加入後重新依 queueNumber 排序，與公開名單的 1、2、3、10 順序相同',()=>{
    const one=person('1',{queueNumber:1});const three=person('3',{queueNumber:3});const ten=person('10',{queueNumber:10});
    expect(ids(buildWaitingQueue(simple,[ten,three,one]))).toEqual(['1','3','10']);
    const two=person('2',{queueNumber:2});
    const snapshot=serverSnapshot([one,two,three,ten]);
    const result=buildWaitingQueue(simple,[ten,two,three,one]);
    expect(ids(result)).toEqual(['1','2','3','10']);
    expect(waitingEmployees(result)).toEqual(snapshot.publicPeople.map(row=>row.employeeNo));
  });

  it('舊資料可沿用數字 checkinNo，但 queueNumber 明確存在時優先採用',()=>{
    const rows=[person('10',{queueNumber:null,checkinNo:'10'}),person('2',{queueNumber:2,checkinNo:'99'}),person('1',{checkinNo:'1'})];
    expect(ids(buildWaitingQueue(simple,rows))).toEqual(['1','2','10']);
  });

  it('有效最大安全整數仍在缺號之前，不因缺號的 Excel sequence 比較小而錯置',()=>{
    const rows=[person('missing',{checkinNo:null,sequence:1}),person('max',{queueNumber:Number.MAX_SAFE_INTEGER,sequence:9}),person('unsafe',{queueNumber:Number.MAX_SAFE_INTEGER+1,checkinNo:null,sequence:2})];
    expect(ids(buildWaitingQueue(simple,rows))).toEqual(['max','missing','unsafe']);
  });

  it.each([0,-1,1.5,Number.POSITIVE_INFINITY,Number.NaN,Number.MAX_SAFE_INTEGER+1])('無效 queueNumber %s 視為缺號，保留在合法號碼之後',queueNumber=>{
    const rows=[person('invalid',{queueNumber,checkinNo:'A1',sequence:1}),person('valid',{queueNumber:10,sequence:99})];
    expect(ids(buildWaitingQueue(simple,rows))).toEqual(['valid','invalid']);
  });

  it('相同號碼及缺號各自以 sequence、id 作穩定最後排序',()=>{
    const rows=[
      person('null-z',{checkinNo:null,sequence:3}),person('valid-z',{queueNumber:2,sequence:3}),
      person('valid-b',{queueNumber:2,sequence:2}),person('null-b',{checkinNo:null,sequence:2}),
      person('null-a',{checkinNo:null,sequence:2}),person('valid-a',{queueNumber:2,sequence:2}),
    ];
    expect(ids(buildWaitingQueue(simple,rows))).toEqual(['valid-a','valid-b','valid-z','null-a','null-b','null-z']);
  });

  it('所有既有狀態仍保留，其他七種狀態保持原相對順序排在 waiting 後',()=>{
    const statuses:WorkStatus[]=['等候中','未報到','已叫號','上廁所','心電圖','先做其他','檢查中','已完成'];
    const rows=statuses.map((status,index)=>person(status,{status,queueNumber:index+1})).reverse();
    expect(ids(buildWaitingQueue(simple,rows))).toEqual(['等候中',...statuses.slice(1).reverse()]);
  });

  it('沒有 waiting 時不依 queueNumber 重排其他人員，回傳原內容的新陣列',()=>{
    const rows=[person('done',{status:'已完成',queueNumber:10}),person('called',{status:'已叫號',queueNumber:1}),person('unreported',{status:'未報到',queueNumber:null})];
    const result=buildWaitingQueue(simple,rows);
    expect(ids(result)).toEqual(['done','called','unreported']);
    expect(result).not.toBe(rows);expect(result).toEqual(rows);
    expect(result?.every((row,index)=>row===rows[index])).toBe(true);
  });

  it('排序不改動陣列、Participant 或 promoted_at，也不需要 server rank map',()=>{
    const ten=Object.freeze(person('10',{queueNumber:10,promotedAt:'2026-10-16T00:20:00Z'}));
    const one=Object.freeze(person('1',{queueNumber:1}));const rows=Object.freeze([ten,one]);
    const result=buildWaitingQueue(simple,rows);
    expect(ids(rows)).toEqual(['10','1']);expect(ids(result)).toEqual(['1','10']);
    expect(result).not.toBe(rows);expect(result?.[0]).toBe(one);expect(result?.[1]).toBe(ten);
    expect(ten.promotedAt).toBe('2026-10-16T00:20:00Z');
  });
});

describe('控制台與診間使用相同 waiting 比較器',()=>{
  it('標準模式使用相同 SQL rank，比較時不以 checkinNo 再排序',()=>{
    const late=person('late',{checkinNo:'A1'});const promoted=person('promoted',{checkinNo:'G99'});
    const order={simple:false,standardWaitingRanks:ranks(['promoted','late'])};
    expect(compareWaitingParticipants(promoted,late,order)).toBeLessThan(0);
    expect(compareWaitingParticipants(late,promoted,order)).toBeGreaterThan(0);
    expect(compareWaitingParticipants(late,late,order)).toBe(0);
  });

  it('簡易模式仍讓最大合法號碼在缺號之前，同號以 id 穩定決定順序',()=>{
    const order={simple:true};
    expect(compareWaitingParticipants(person('max',{queueNumber:Number.MAX_SAFE_INTEGER}),person('null',{checkinNo:null}),order)).toBeLessThan(0);
    expect(compareWaitingParticipants(person('a',{queueNumber:2}),person('b',{queueNumber:2}),order)).toBeLessThan(0);
  });
});
