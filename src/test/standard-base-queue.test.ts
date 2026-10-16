import {afterEach,describe,expect,it,vi} from 'vitest';
import type {GroupCode,Participant,WorkStatus} from '../types';
import {taiwanMinutesAt} from '../lib/time';
import {actualCheckinGroup,buildStandardBaseQueue,compareServerTimestamps,compareStandardBaseQueue,effectiveQueueGroup,SLOT_GROUP} from '../features/schedule/rules';

const checkedAt=(clock:string)=>`2026-10-16T${clock}:00+08:00`;
function person(id:string,groupCode:GroupCode='A',clock='07:50',overrides:Partial<Participant>={}):Participant{
  return {id,sessionId:'standard-session',sequence:1,employeeNo:id,name:id,gender:'',slot:Object.entries(SLOT_GROUP).find(([,group])=>group===groupCode)![0],groupCode,plannedItems:[],checkinNo:`${groupCode}1`,status:'等候中',checkedInAt:checkedAt(clock),calledAt:null,note:'',updatedAt:checkedAt(clock),...overrides};
}
const ids=(people:Participant[])=>people.map(item=>item.id);

describe('標準模式 server checked_in_at 的候檢 Base Queue',()=>{
  afterEach(()=>vi.useRealTimers());

  it.each([
    ['A','07:50','A'], // CASE 1: on time.
    ['A','08:10','B'], // CASE 2: one slot late.
    ['A','09:10','D'], // CASE 3: several slots late.
    ['C','08:05','C'], // CASE 4: early arrivals keep their scheduled group.
    ['G','07:40','G'], // CASE 5: much earlier arrivals get no priority.
    ['G','07:15','G'], // CASE 6: earlier than the first slot clamps to A.
    ['A','11:15','G'], // CASE 7: later than the final slot clamps to G.
  ] as const)('%s 排程 %s server 報到，effective group 為 %s',(scheduled,clock,expected)=>{
    expect(effectiveQueueGroup(person('person',scheduled,clock))).toBe(expected);
  });

  it.each([
    ['00:00','A'],['07:29','A'],['07:30','A'],['07:59','A'],
    ['08:00','B'],['08:29','B'],['08:30','C'],['08:59','C'],
    ['09:00','D'],['09:29','D'],['09:30','E'],['09:59','E'],
    ['10:00','F'],['10:29','F'],['10:30','G'],['10:59','G'],
    ['11:00','G'],['23:59','G'],
  ] as const)('台灣 %s 屬於 %s，時段採含起點不含終點',(clock,expected)=>{
    expect(actualCheckinGroup(checkedAt(clock))).toBe(expected);
  });

  it('使用 Asia/Taipei 讀取同一個 UTC / offset server timestamp',()=>{
    expect(taiwanMinutesAt('2026-10-16T00:10:00Z')).toBe(8*60+10);
    expect(actualCheckinGroup('2026-10-16T00:10:00Z')).toBe('B');
    expect(actualCheckinGroup('2026-10-16T08:10:00+08:00')).toBe('B');
    expect(actualCheckinGroup('2026-10-15T23:30:00Z')).toBe('A');
  });

  it.each(Object.entries(SLOT_GROUP))('%s 結束前最後一微秒仍屬於 %s',(slot,group)=>{
    const end=slot.split('~')[1];
    const [hour,minute]=end.split(':').map(Number);
    const previousMinute=hour*60+minute-1;
    const clock=`${String(Math.floor(previousMinute/60)).padStart(2,'0')}:${String(previousMinute%60).padStart(2,'0')}:59.999999`;
    expect(actualCheckinGroup(`2026-10-16T${clock}+08:00`)).toBe(group);
  });

  it('CASE 8：同 effective B，依真正完成報到的時間排列，A 遲到者不插到較早者前面',()=>{
    const people=[person('B3','B','08:12',{checkinNo:'B3'}),person('A8','A','08:10',{checkinNo:'A8'}),person('B2','B','08:06',{checkinNo:'B2'}),person('B1','B','08:02',{checkinNo:'B1'})];
    expect(ids(buildStandardBaseQueue(people))).toEqual(['B1','B2','A8','B3']);
  });

  it('CASE 9：effective group 優先，sequence_no 與報到號碼都不是主要排序',()=>{
    const people=[person('A8','A','08:10',{checkinNo:'A8',sequence:1}),person('B1','B','08:02',{checkinNo:'B1',sequence:2}),person('A5','A','07:50',{checkinNo:'A5',sequence:999})];
    expect(ids(buildStandardBaseQueue(people))).toEqual(['A5','B1','A8']);
  });

  it('CASE 10、11：目前時間前進或設備時鐘錯誤，都不會改變 server 報到分類和順位',()=>{
    const people=[person('A8','A','08:10'),person('B1','B','08:02'),person('C1','C','08:05')];
    const expected=ids(buildStandardBaseQueue(people));
    vi.useFakeTimers({toFake:['Date']});
    for(const clock of ['08:25','08:45','23:59']){
      vi.setSystemTime(new Date(checkedAt(clock)));
      expect(effectiveQueueGroup(people[0])).toBe('B');
      expect(ids(buildStandardBaseQueue(people))).toEqual(expected);
    }
  });

  it('報到時間相同才使用真正 checkinSequence，不能偷用 sequence_no',()=>{
    const first=person('first','A','07:50',{checkinSequence:2,checkinNo:'A99',sequence:100});
    const second=person('second','A','07:50',{checkinSequence:3,checkinNo:'A1',sequence:1});
    expect(ids(buildStandardBaseQueue([second,first]))).toEqual(['first','second']);
  });

  it('checkinSequence 相同後才比較 checkinNo 的數字尾碼，最後才看 sequence 與 id',()=>{
    const people=[person('ten','A','07:50',{checkinSequence:1,checkinNo:'A10',sequence:0}),person('two-later','A','07:50',{checkinSequence:1,checkinNo:'A2',sequence:3}),person('two-earlier','A','07:50',{checkinSequence:1,checkinNo:'A2',sequence:2})];
    expect(ids(buildStandardBaseQueue(people))).toEqual(['two-earlier','two-later','ten']);
    const a=person('a');const b=person('b');
    expect(ids(buildStandardBaseQueue([b,a]))).toEqual(['a','b']);
    expect(compareStandardBaseQueue(a,a)).toBe(0);
  });

  it('server 報到的微秒也保留先後，不會被 JavaScript 毫秒精度錯誤折成同時',()=>{
    const first=person('first','B','08:10',{checkedInAt:'2026-10-16T00:10:00.123001Z',checkinSequence:99});
    const second=person('second','B','08:10',{checkedInAt:'2026-10-16T08:10:00.123999+08:00',checkinSequence:1});
    expect(ids(buildStandardBaseQueue([second,first]))).toEqual(['first','second']);
    expect(compareServerTimestamps('2026-10-16T00:10:00.123Z','2026-10-16T08:10:00.123000+08:00')).toBe(0);
  });

  it('既有 groupCode 優先；缺少 groupCode 時才沿用共用 slot helper',()=>{
    const row=person('person','C','08:05');
    expect(effectiveQueueGroup({...row,slot:'07:30~08:00'})).toBe('C');
    expect(effectiveQueueGroup({...row,groupCode:null,slot:'08:30 ～ 09:00'})).toBe('C');
  });

  it.each([null,undefined,'','invalid','2026-10-16T08:10:00'])('不使用缺少或無時區的 %s 取代 server 報到時間',timestamp=>{
    expect(taiwanMinutesAt(timestamp)).toBeNull();
    expect(actualCheckinGroup(timestamp)).toBeNull();
    if(timestamp!==undefined)expect(effectiveQueueGroup(person('person','A','07:50',{checkedInAt:timestamp}))).toBeNull();
  });

  it('舊資料缺漏時穩定排在合法群組後，不自行偽造目前時間',()=>{
    const missingA=person('a','A','07:50',{groupCode:null,slot:null,checkedInAt:null,checkinNo:null,checkinSequence:null,sequence:9});
    const missingB={...missingA,id:'b'};
    const noSequence=person('no-sequence','A','07:50',{checkinSequence:undefined});
    const withSequence=person('with-sequence','A','07:50',{checkinSequence:1,checkinNo:'A99',sequence:99});
    const rows=[missingB,noSequence,missingA,withSequence];
    expect(ids(buildStandardBaseQueue(rows))).toEqual(['with-sequence','no-sequence','a','b']);
    expect(ids(buildStandardBaseQueue([...rows].reverse()))).toEqual(['with-sequence','no-sequence','a','b']);
    expect(effectiveQueueGroup(missingA)).toBeNull();
  });

  it.each(['未報到','已叫號','上廁所','心電圖','先做其他','檢查中','已完成'] as WorkStatus[])('%s 不進正式候檢 queue',status=>{
    expect(ids(buildStandardBaseQueue([person('excluded','A','07:40',{status}),person('waiting')]))).toEqual(['waiting']);
  });

  it('排序不修改傳入陣列或人員，保留泛型欄位',()=>{
    const earlier=Object.freeze({...person('earlier','A','07:45'),extra:'kept'});
    const later=Object.freeze({...person('later','A','07:55'),extra:'kept-too'});
    const input=Object.freeze([later,earlier]);
    const queue=buildStandardBaseQueue(input);
    expect(queue).toEqual([earlier,later]);expect(queue[0].extra).toBe('kept');
    expect(input).toEqual([later,earlier]);expect(queue).not.toBe(input);
  });
});
