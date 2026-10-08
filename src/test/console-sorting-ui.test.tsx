import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {UltrasoundConsole} from '../features/console/Console';
import {callParticipant,updateWaitingStatus} from '../features/console/service';
import {enqueueAdditionalExamination,listExaminations} from '../features/examination/service';
import {useRoomStates} from '../features/room/useRoomStates';
import {getRoomIds} from '../features/room/status';
import type {Examination,Participant,Session,WorkStatus} from '../types';

type CloudPayload={eventType:string;new:Record<string,unknown>;old:Record<string,unknown>};
const realtime=vi.hoisted(()=>({handlers:[] as Array<(payload:CloudPayload)=>void>,rpc:vi.fn()}));
vi.mock('../lib/supabase',()=>({requireSupabase:()=>({
  channel:()=>{const channel={on:(_event:string,_filter:unknown,handler:(payload:CloudPayload)=>void)=>{realtime.handlers.push(handler);return channel;},subscribe:()=>channel};return channel;},
  removeChannel:vi.fn(),rpc:realtime.rpc,
})}));
vi.mock('../features/console/service',()=>({callParticipant:vi.fn(),updateWaitingStatus:vi.fn()}));
vi.mock('../features/examination/service',async importOriginal=>({...await importOriginal<typeof import('../features/examination/service')>(),listExaminations:vi.fn(),enqueueAdditionalExamination:vi.fn()}));
vi.mock('../features/room/useRoomStates',()=>({useRoomStates:vi.fn()}));

const session:Session={id:'sort-session',companyName:'ITRI',sessionDate:'2026-10-08',status:'active',roomCount:4,workflowMode:'standard'};
const simpleSession:Session={...session,workflowMode:'simple'};
const person=(id:string,checkinNo:string,status:WorkStatus='等候中',patch:Partial<Participant>={}):Participant=>({id,sessionId:session.id,sequence:1,employeeNo:id,name:id,gender:'男',slot:'07:30~08:00',groupCode:'A',plannedItems:['腹部超音波'],checkinNo,status,checkedInAt:status==='未報到'?null:'2026-10-08T00:00:00Z',calledAt:null,note:'',updatedAt:'2026-10-08T00:00:00Z',...patch});
const examination=(participantId:string,roomId:string|null,patch:Partial<Examination>={}):Examination=>({id:`exam-${participantId}`,participantId,roundNo:1,roomId,startedAt:'2026-10-08T00:01:00Z',completedAt:null,durationSeconds:null,selectedItems:['腹部超音波'],actualItems:[],itemCount:0,status:'in_progress',...patch});
const list=vi.mocked(listExaminations);
const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
let root:Root;
let container:HTMLDivElement;
let changed:ReturnType<typeof vi.fn>;
let errors:ReturnType<typeof vi.fn>;

function setRooms(roomCount=4,syncedRoomCount?:number){
  vi.mocked(useRoomStates).mockReturnValue({rooms:getRoomIds(roomCount).map(roomId=>({sessionId:session.id,roomId,status:'idle',updatedAt:null})),loading:false,error:'',refresh:vi.fn(async()=>{}),acceptRoom:vi.fn(),...(syncedRoomCount===undefined?{}:{roomCount:syncedRoomCount})});
}
async function render(participants:Participant[],current:Session|null=session){
  await act(async()=>{root.render(<UltrasoundConsole current={current} participants={participants} onChanged={changed} onError={errors} canRoom/>);});
}
function names(){return Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody tr')).flatMap(row=>{const name=row.querySelector('b')?.textContent;return name?[name]:[];});}
function queueNumbers(simple=false){return Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody tr')).filter(row=>row.querySelector('b')).map(row=>row.cells[simple?0:1].textContent);}
function sortSelect(){
  const select=container.querySelector<HTMLSelectElement>('select[aria-label="排序"]');
  if(!select)throw new Error('找不到排序選擇器。');
  return select;
}
async function selectSort(mode:'priority'|'queue'|'room'){
  await act(async()=>{const select=sortSelect();select.value=mode;select.dispatchEvent(new Event('change',{bubbles:true}));});
}
function header(label:string){
  const element=Array.from(container.querySelectorAll<HTMLTableCellElement>('thead th')).find(cell=>cell.querySelector('button')?.getAttribute('aria-label')===label);
  if(!element)throw new Error(`找不到排序表頭：${label}`);
  return element;
}
async function clickHeader(label:string){await act(async()=>{header(label).querySelector<HTMLButtonElement>('button')!.click();});}
async function selectGroup(label:string){
  const button=Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(element=>element.textContent===label);
  if(!button)throw new Error(`找不到分組：${label}`);
  await act(async()=>{button.click();});
}
async function emitExamination(participantId:string){
  await act(async()=>{for(const handler of realtime.handlers)handler({eventType:'UPDATE',new:{id:`exam-${participantId}`,participant_id:participantId},old:{}});});
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,125));});
}
function assertSort(mode:'priority'|'queue'|'room',direction:'ascending'|'descending',simple=false){
  expect(sortSelect().value).toBe(mode);
  const labels={priority:'狀態',queue:simple?'號碼':'報到編號',room:'診間'};
  for(const [value,label] of Object.entries(labels))expect(header(label).getAttribute('aria-sort')).toBe(value===mode?direction:'none');
}

describe('控制台排序只調整現場顯示',()=>{
  beforeEach(()=>{
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;
    realtime.handlers=[];realtime.rpc.mockReset();
    list.mockReset();list.mockResolvedValue([]);
    vi.mocked(callParticipant).mockReset();vi.mocked(updateWaitingStatus).mockReset();vi.mocked(enqueueAdditionalExamination).mockReset();
    changed=vi.fn(async()=>{});errors=vi.fn();
    setRooms();container=document.createElement('div');document.body.append(container);root=createRoot(container);
  });
  afterEach(async()=>{
    expect(callParticipant).not.toHaveBeenCalled();expect(updateWaitingStatus).not.toHaveBeenCalled();expect(enqueueAdditionalExamination).not.toHaveBeenCalled();expect(realtime.rpc).not.toHaveBeenCalled();expect(changed).not.toHaveBeenCalled();
    await act(async()=>{root.unmount();});container.remove();vi.restoreAllMocks();actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;
  });

  it.each([['standard',session],['simple',simpleSession]] as const)('%s 首次進入預設現場優先，八種狀態與同狀態號碼排序正確',async(mode,current)=>{
    const statuses:WorkStatus[]=['已完成','未報到','先做其他','心電圖','上廁所','等候中','已叫號','檢查中'];
    const rows=statuses.map((status,index)=>person(status,mode==='simple'?String(index+1):`A${index+1}`,status));
    rows.push(person('檢查中較小號',mode==='simple'?'3':'A3','檢查中'));
    await render(rows,current);
    expect(names()).toEqual(['檢查中較小號','檢查中','已叫號','等候中','上廁所','心電圖','先做其他','未報到','已完成']);
    assertSort('priority','ascending',mode==='simple');
    expect(Array.from(sortSelect().options).map(option=>option.text)).toEqual(['現場優先','報到號碼','診間']);
  });

  it('標準模式全部 + 報到號碼使用自然號碼順序與組別順序',async()=>{
    const rows=[person('B2','B2','檢查中',{groupCode:'B'}),person('A10','A10'),person('B1','B1','已完成',{groupCode:'B'}),person('A2','A2'),person('A1','A1','已完成')];
    await render(rows);await selectSort('queue');
    expect(queueNumbers()).toEqual(['A1','A2','A10','B1','B2']);assertSort('queue','ascending');
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('簡易模式可恢復 1、2、3、10 順序，沒有 A～G 篩選與組別／時段欄位',async()=>{
    await render([person('十號','10','檢查中',{queueNumber:10,groupCode:null,slot:null}),person('三號','3','已叫號',{queueNumber:3,groupCode:null,slot:null}),person('一號','1','已完成',{groupCode:null,slot:null}),person('二號','2','等候中',{queueNumber:2,groupCode:null,slot:null})],simpleSession);
    expect(queueNumbers(true)).toEqual(['10','3','2','1']);await selectSort('queue');
    expect(queueNumbers(true)).toEqual(['1','2','3','10']);assertSort('queue','ascending',true);
    for(const label of ['全部','A','B','C','D','E','F','G'])expect(Array.from(container.querySelectorAll('button')).some(button=>button.textContent===label)).toBe(false);
    expect(container.querySelector('thead')?.textContent).not.toContain('組別');expect(container.querySelector('thead')?.textContent).not.toContain('時段');
  });

  it.each([['standard',session,'報到編號'],['simple',simpleSession,'號碼']] as const)('%s 號碼表頭切換升／降冪，選擇器同步並可回復升冪',async(mode,current,label)=>{
    const simple=mode==='simple';
    await render([person('十號',simple?'10':'A10'),person('二號',simple?'2':'A2'),person('一號',simple?'1':'A1')],current);
    await clickHeader(label);expect(names()).toEqual(['一號','二號','十號']);assertSort('queue','ascending',simple);
    await clickHeader(label);expect(names()).toEqual(['十號','二號','一號']);assertSort('queue','descending',simple);
    await selectSort('queue');expect(names()).toEqual(['一號','二號','十號']);assertSort('queue','ascending',simple);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it.each([['standard',session],['simple',simpleSession]] as const)('%s 診間排序按有效房號，房內現場優先，無診間在升／降冪都置末',async(mode,current)=>{
    const simple=mode==='simple';const queue=(value:number)=>simple?String(value):`A${value}`;
    const rows=[person('無診間',queue(1)),person('診間3',queue(2),'檢查中'),person('診間1完成',queue(3),'已完成'),person('診間2',queue(4),'檢查中'),person('診間1叫號',queue(5),'已叫號'),person('診間1檢查',queue(6),'檢查中')];
    list.mockResolvedValue([examination('診間3','room_3'),examination('診間1完成','room_1',{status:'completed'}),examination('診間2','診間 2'),examination('診間1叫號','room_1',{status:'waiting'}),examination('診間1檢查','room_1')]);
    await render(rows,current);await selectSort('room');
    expect(names()).toEqual(['診間1檢查','診間1叫號','診間1完成','診間2','診間3','無診間']);assertSort('room','ascending',simple);
    await clickHeader('診間');expect(names()).toEqual(['診間3','診間2','診間1檢查','診間1叫號','診間1完成','無診間']);assertSort('room','descending',simple);
    await clickHeader('診間');expect(names()).toEqual(['診間1檢查','診間1叫號','診間1完成','診間2','診間3','無診間']);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('從其他排序點診間表頭先升冪，狀態表頭回到固定現場優先且不反轉',async()=>{
    const rows=[person('已完成','A1','已完成'),person('已叫號','A2','已叫號'),person('檢查中','A3','檢查中')];
    list.mockResolvedValue([examination('已完成','room_1',{status:'completed'}),examination('已叫號','room_2',{status:'waiting'}),examination('檢查中','room_3')]);
    await render(rows);await clickHeader('報到編號');await clickHeader('報到編號');assertSort('queue','descending');
    await clickHeader('診間');expect(names()).toEqual(['已完成','已叫號','檢查中']);assertSort('room','ascending');
    await clickHeader('狀態');expect(names()).toEqual(['檢查中','已叫號','已完成']);assertSort('priority','ascending');
    await clickHeader('狀態');expect(names()).toEqual(['檢查中','已叫號','已完成']);assertSort('priority','ascending');
  });

  it('A～G 先篩選再排序：全部現場優先、A現場優先、B報到號碼、C診間',async()=>{
    const rows=[person('A完成','A1','已完成'),person('B二號','B2','等候中',{groupCode:'B'}),person('C診間2','C1','檢查中',{groupCode:'C'}),person('A檢查','A2','檢查中'),person('C診間1','C2','已叫號',{groupCode:'C'}),person('B一號','B1','已叫號',{groupCode:'B'})];
    list.mockResolvedValue([examination('C診間2','room_2'),examination('C診間1','room_1',{status:'waiting'})]);
    await render(rows);expect(names()).toEqual(['A檢查','C診間2','B一號','C診間1','B二號','A完成']);
    await selectGroup('A');expect(names()).toEqual(['A檢查','A完成']);assertSort('priority','ascending');
    await selectSort('queue');await selectGroup('B');expect(names()).toEqual(['B一號','B二號']);assertSort('queue','ascending');
    await selectSort('room');await selectGroup('C');expect(names()).toEqual(['C診間1','C診間2']);assertSort('room','ascending');
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('切換分組保留排序方式與降冪方向，不重新取得 examinations',async()=>{
    const rows=[person('A1','A1'),person('A2','A2'),person('B1','B1','等候中',{groupCode:'B'}),person('B2','B2','等候中',{groupCode:'B'})];
    await render(rows);await clickHeader('報到編號');await clickHeader('報到編號');await selectGroup('A');
    expect(names()).toEqual(['A2','A1']);assertSort('queue','descending');
    await selectGroup('B');expect(names()).toEqual(['B2','B1']);assertSort('queue','descending');
    await selectGroup('全部');expect(names()).toEqual(['B2','B1','A2','A1']);assertSort('queue','descending');expect(list).toHaveBeenCalledTimes(1);
  });

  it.each([['standard',session],['simple',simpleSession]] as const)('%s 上層 Realtime 回傳同 ID 人員後立刻移至檢查中、完成後沉底，無新增查詢',async(mode,current)=>{
    const first=person('先報到',mode==='simple'?'1':'A1','等候中');const second=person('後報到',mode==='simple'?'8':'A8','等候中');
    await render([first,second],current);expect(names()).toEqual(['先報到','後報到']);const subscriptions=realtime.handlers.length;
    await render([first,{...second,status:'檢查中'}],current);expect(names()).toEqual(['後報到','先報到']);
    await render([first,{...second,status:'已完成'}],current);expect(names()).toEqual(['先報到','後報到']);
    expect(list).toHaveBeenCalledTimes(1);expect(realtime.handlers).toHaveLength(subscriptions);expect(errors).not.toHaveBeenCalled();
  });

  it('既有 examination Realtime 刷新會即時重新排列診間，保持原 subscription',async()=>{
    const rows=[person('第一人','A1','檢查中'),person('第二人','A2','檢查中')];
    list.mockResolvedValue([examination('第一人','room_1'),examination('第二人','room_2')]);
    await render(rows);await selectSort('room');expect(names()).toEqual(['第一人','第二人']);const subscriptions=realtime.handlers.length;
    list.mockResolvedValue([examination('第一人','room_3'),examination('第二人','room_2')]);await emitExamination('第一人');
    expect(names()).toEqual(['第二人','第一人']);expect(list).toHaveBeenCalledTimes(2);expect(realtime.handlers).toHaveLength(subscriptions);expect(errors).not.toHaveBeenCalled();
  });

  it('檢查中按本輪 in_progress 診間排序，不採用更早 completed 或 waiting 診間',async()=>{
    const rows=[person('本輪4','A1','檢查中'),person('本輪3','A2','檢查中'),person('本輪未配房','A3','檢查中')];
    list.mockResolvedValue([
      examination('本輪4','room_1',{id:'old-completed',status:'completed'}),examination('本輪4','room_2',{id:'future-waiting',roundNo:3,status:'waiting'}),examination('本輪4','room_4',{roundNo:2}),
      examination('本輪3','room_3'),examination('本輪未配房','room_1',{id:'unassigned-old',status:'completed'}),examination('本輪未配房',null,{roundNo:2}),
    ]);
    await render(rows);await selectSort('room');expect(names()).toEqual(['本輪3','本輪4','本輪未配房']);
    const displayed=Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody tr')).map(row=>row.cells[5].textContent);expect(displayed).toEqual(['診間3','診間4','—']);
  });

  it.each([false,true])('超出場次有效診間的歷史房號視為無診間而置末（即時房數=%s）',async synced=>{
    setRooms(8,synced?2:undefined);
    list.mockResolvedValue([examination('停用房','room_6',{status:'completed'}),examination('有效房','room_2')]);
    await render([person('停用房','A1','已完成'),person('有效房','A2','檢查中')],{...session,roomCount:synced?8:2});await selectSort('room');await clickHeader('診間');
    expect(names()).toEqual(['有效房','停用房']);expect(Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody tr')).map(row=>row.cells[5].textContent)).toEqual(['診間2','—']);
  });

  it('切換場次重設現場優先與升冪，重新進入也不讀取本機排序偏好',async()=>{
    const rows=[person('一號','A1','已完成'),person('二號','A2','檢查中')];await render(rows);await clickHeader('報到編號');await clickHeader('報到編號');assertSort('queue','descending');
    const next={...session,id:'next-session'};await render(rows.map(row=>({...row,sessionId:next.id})),next);expect(names()).toEqual(['二號','一號']);assertSort('priority','ascending');
    await clickHeader('診間');await clickHeader('診間');assertSort('room','descending');
    await act(async()=>{root.unmount();});root=createRoot(container);await render(rows);expect(names()).toEqual(['二號','一號']);assertSort('priority','ascending');
  });

  it('排序不修改原 participants 陣列或其欄位，並保留正常可用的現場操作',async()=>{
    const rows=[person('二號','A2'),person('一號','A1','已完成')];const original=JSON.stringify(rows);rows.forEach(row=>Object.freeze(row));Object.freeze(rows);
    await render(rows);await clickHeader('報到編號');expect(names()).toEqual(['一號','二號']);await clickHeader('報到編號');await selectSort('room');await selectSort('priority');
    expect(JSON.stringify(rows)).toBe(original);expect(rows.map(row=>row.id)).toEqual(['二號','一號']);
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>('tbody button')).filter(button=>button.textContent==='叫號').every(button=>!button.disabled)).toBe(true);
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>('tbody button')).some(button=>button.textContent==='追加檢查')).toBe(true);expect(list).toHaveBeenCalledTimes(1);
  });

  it('尚未選擇場次保持原提示，空場次仍可選擇排序',async()=>{
    await render([],null);expect(container.textContent).toContain('請先選擇場次。');expect(container.querySelector('select[aria-label="排序"]')).toBeNull();
    await render([]);await selectSort('room');assertSort('room','ascending');expect(container.textContent).toContain('此分組尚無今日受檢者。');
  });
});
