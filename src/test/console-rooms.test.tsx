import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {UltrasoundConsole} from '../features/console/Console';
import {callParticipant,updateWaitingStatus} from '../features/console/service';
import {listExaminations} from '../features/examination/service';
import type {Examination,Participant,Session} from '../types';

vi.mock('../features/console/service',()=>({callParticipant:vi.fn(),updateWaitingStatus:vi.fn()}));
vi.mock('../features/examination/service',async importOriginal=>({...await importOriginal<typeof import('../features/examination/service')>(),listExaminations:vi.fn(),enqueueAdditionalExamination:vi.fn()}));

const session:Session={id:'console-session',companyName:'ITRI',sessionDate:'2026-10-07',status:'active'};
const person=(patch:Partial<Participant>={}):Participant=>({id:'person-1',sessionId:session.id,sequence:1,employeeNo:'00125',name:'王小明',gender:'男',slot:'07:30~08:00',groupCode:'A',plannedItems:['腹部超音波'],checkinNo:'A1',status:'檢查中',checkedInAt:'2026-10-07T00:00:00Z',calledAt:'2026-10-07T00:01:00Z',note:'',updatedAt:'2026-10-07T00:02:00Z',...patch});
const examination=(patch:Partial<Examination>={}):Examination=>({id:'exam-1',participantId:'person-1',roundNo:1,roomId:'診間 1',startedAt:'2026-10-07T00:02:00Z',completedAt:null,durationSeconds:null,selectedItems:['腹部超音波'],actualItems:[],itemCount:0,status:'in_progress',...patch});
const list=vi.mocked(listExaminations);
const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
let root:Root;
let container:HTMLDivElement;
let changed:ReturnType<typeof vi.fn>;
let errors:ReturnType<typeof vi.fn>;

async function until(condition:()=>boolean){
  for(let attempt=0;attempt<100;attempt++){
    if(condition())return;
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
  }
  throw new Error('診間狀態未在預期時間更新。');
}
async function render(participants:Participant[]=[],current:Session=session){
  await act(async()=>{root.render(<UltrasoundConsole current={current} participants={participants} onChanged={changed} onError={errors}/>);});
}
function roomGroup(){
  const element=container.querySelector<HTMLElement>('[role="group"][aria-label="診間狀態"]');
  if(!element)throw new Error('找不到診間狀態群組。');
  return element;
}
function indicator(room:number){
  const element=Array.from(roomGroup().querySelectorAll<HTMLElement>('[role="img"]')).find(value=>value.getAttribute('aria-label')?.startsWith(`診間${room}：`));
  if(!element)throw new Error(`找不到診間${room}狀態。`);
  return element;
}
function expectRooms(occupied:readonly number[]=[]){
  expect(roomGroup().querySelectorAll('[role="img"]')).toHaveLength(4);
  for(const room of [1,2,3,4]){
    const busy=occupied.includes(room);
    const light=indicator(room);
    expect(light.getAttribute('aria-label')).toBe(`診間${room}：${busy?'檢查中':'空閒'}`);
    expect(light.textContent).toBe(`診間${room}`);
    const dot=light.querySelector<HTMLElement>('[aria-hidden="true"]');
    expect(dot?.classList.contains(busy?'bg-red-400':'bg-emerald-400')).toBe(true);
    expect(dot?.classList.contains(busy?'bg-emerald-400':'bg-red-400')).toBe(false);
  }
}
function rowFor(name:string){
  const row=Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody tr')).find(element=>element.querySelector('b')?.textContent===name);
  if(!row)throw new Error(`找不到受檢者：${name}`);
  return row;
}
const roomCell=(name='王小明')=>rowFor(name).cells[5].textContent;
async function selectGroup(group:string){
  const button=Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(element=>element.textContent===group);
  if(!button)throw new Error(`找不到分組：${group}`);
  await act(async()=>{button.click();});
}

describe('超音波控制台診間狀態',()=>{
  beforeEach(()=>{
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;
    list.mockReset();
    list.mockResolvedValue([]);
    vi.mocked(callParticipant).mockReset();
    vi.mocked(updateWaitingStatus).mockReset();
    changed=vi.fn(async()=>{});
    errors=vi.fn();
    container=document.createElement('div');
    document.body.append(container);
    root=createRoot(container);
  });
  afterEach(async()=>{
    await act(async()=>{root.unmount();});
    container.remove();
    vi.restoreAllMocks();
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;
  });

  it('目前沒有受檢者時固定顯示診間1～4，全部為綠色空閒',async()=>{
    await render();
    expectRooms();
    expect(container.textContent).toContain('此分組尚無今日受檢者。');
    expect(list).toHaveBeenCalledWith([]);
    expect(vi.mocked(callParticipant)).not.toHaveBeenCalled();
    expect(vi.mocked(updateWaitingStatus)).not.toHaveBeenCalled();
  });

  it.each([1,2,3,4])('受檢者及本輪皆檢查中時診間%s亮紅燈，表格使用無空白的診間名稱',async room=>{
    list.mockResolvedValue([examination({roomId:`診間 ${room}`})]);
    await render([person()]);
    expectRooms([room]);
    expect(roomCell()).toBe(`診間${room}`);
    expect(rowFor('王小明').cells[6].textContent).toBe('檢查中');
    expect(list).toHaveBeenCalledWith(['person-1']);
    expect(errors).not.toHaveBeenCalled();
  });

  it.each(['等候中','已叫號','已完成'] as const)('%s 人員不佔用診間，即使舊 examination 仍顯示 in_progress',async status=>{
    list.mockResolvedValue([examination({roomId:'診間 2'})]);
    await render([person({status})]);
    expectRooms();
    // The existing table room display for other workflow states stays intact.
    expect(roomCell()).toBe('診間 2');
    expect(rowFor('王小明').cells[6].textContent).toBe(status);
  });

  it.each(['waiting','completed'] as const)('人員標記檢查中但本輪為 %s 時不亮紅燈，表格不沿用舊診間',async status=>{
    list.mockResolvedValue([examination({status,roomId:'診間 3',completedAt:status==='completed'?'2026-10-07T00:03:00Z':null})]);
    await render([person()]);
    expectRooms();
    expect(roomCell()).toBe('—');
  });

  it('同一診間重複出現檢查中人員時只顯示一盞紅燈',async()=>{
    list.mockResolvedValue([examination(),examination({id:'exam-2',participantId:'person-2'})]);
    await render([person(),person({id:'person-2',sequence:2,employeeNo:'00126',name:'李小華',checkinNo:'A2'})]);
    expectRooms([1]);
    expect(roomGroup().querySelectorAll('[aria-label="診間1：檢查中"]')).toHaveLength(1);
    expect(roomCell('王小明')).toBe('診間1');
    expect(roomCell('李小華')).toBe('診間1');
  });

  it('A～G 分组只篩選表格，診間燈仍反映整個目前場次',async()=>{
    list.mockResolvedValue([examination(),examination({id:'exam-2',participantId:'person-2',roomId:'診間 4'})]);
    await render([person(),person({id:'person-2',employeeNo:'00200',name:'B組人員',groupCode:'B',checkinNo:'B1'})]);
    expectRooms([1,4]);
    await selectGroup('A');
    expectRooms([1,4]);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(container.querySelector('tbody')?.textContent).toContain('王小明');
    expect(container.querySelector('tbody')?.textContent).not.toContain('B組人員');
    await selectGroup('G');
    expectRooms([1,4]);
    expect(container.querySelector('tbody')?.textContent).toContain('此分組尚無今日受檢者。');
    await selectGroup('全部');
    expectRooms([1,4]);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('其他場次與不在目前人員名單中的 examination 不影響診間燈',async()=>{
    list.mockResolvedValue([examination({participantId:'foreign-person',roomId:'診間 2'}),examination({id:'missing-person-exam',participantId:'missing-person',roomId:'診間 4'})]);
    await render([person({status:'等候中'}),person({id:'foreign-person',sessionId:'another-session',name:'其他場次人員'})]);
    expectRooms();
  });

  it('檢查中診間僅取 in_progress 輪次，不取舊 completed 或較早列出的 waiting 輪次',async()=>{
    list.mockResolvedValue([
      examination({id:'old-round',roundNo:1,status:'completed',roomId:'診間 1',completedAt:'2026-10-07T00:03:00Z',actualItems:['腹部超音波'],itemCount:1}),
      examination({id:'waiting-round',roundNo:3,status:'waiting',roomId:'診間 2'}),
      examination({id:'current-round',roundNo:2,roomId:'診間 4'}),
    ]);
    await render([person()]);
    expectRooms([4]);
    expect(roomCell()).toBe('診間4');
    expect(rowFor('王小明').cells[7].textContent).toBe('1 件');
  });

  it('in_progress 輪次未指定診間時保持空閒並顯示破折號，不採用舊輪次診間',async()=>{
    list.mockResolvedValue([
      examination({id:'old-round',status:'completed',roomId:'診間 3',completedAt:'2026-10-07T00:03:00Z'}),
      examination({id:'current-round',roundNo:2,roomId:null}),
    ]);
    await render([person()]);
    expectRooms();
    expect(roomCell()).toBe('—');
  });

  it('完成檢查後釋放原診間，其他狀態的表格仍保留既有完成輪次診間',async()=>{
    list.mockResolvedValueOnce([examination({roomId:'診間 2'})]);
    await render([person()]);
    expectRooms([2]);
    list.mockResolvedValueOnce([examination({roomId:'診間 2',status:'completed',completedAt:'2026-10-07T00:03:00Z',actualItems:['腹部超音波'],itemCount:1})]);
    await render([person({status:'已完成'})]);
    expectRooms();
    expect(roomCell()).toBe('診間 2');
    expect(rowFor('王小明').cells[7].textContent).toBe('1 件');
    expect(changed).not.toHaveBeenCalled();
  });

  it('叫號後較早的操作重新載入晚回覆時，不覆蓋同場次新名單的檢查中診間',async()=>{
    let resolveAction!:(rounds:Examination[])=>void;
    list.mockResolvedValueOnce([examination({status:'waiting',roomId:null,startedAt:null})]);
    list.mockImplementationOnce(()=>new Promise<Examination[]>(resolve=>{resolveAction=resolve;}));
    list.mockResolvedValueOnce([examination({roomId:'診間 3'})]);
    vi.mocked(callParticipant).mockResolvedValueOnce(undefined);
    await render([person({status:'等候中'})]);
    expectRooms();
    const call=Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(element=>element.textContent==='叫號')!;
    await act(async()=>{call.click();});
    await until(()=>list.mock.calls.length===2);
    expect(callParticipant).toHaveBeenCalledWith('person-1');
    expect(changed).toHaveBeenCalledTimes(1);
    await render([person({status:'檢查中',updatedAt:'2026-10-07T00:03:00Z'})]);
    expectRooms([3]);
    expect(roomCell()).toBe('診間3');
    await act(async()=>{resolveAction([examination({roomId:'診間 1'})]);});
    expectRooms([3]);
    expect(roomCell()).toBe('診間3');
    expect(list).toHaveBeenCalledTimes(3);
    expect(errors).not.toHaveBeenCalled();
  });

  it.each(['resolve','reject'] as const)('切換場次後忽略舊查詢的延遲 %s，保留新場次診間狀態',async outcome=>{
    let resolveOld!:(rounds:Examination[])=>void;
    let rejectOld!:(error:Error)=>void;
    list.mockImplementationOnce(()=>new Promise<Examination[]>((resolve,reject)=>{resolveOld=resolve;rejectOld=reject;}));
    const nextSession:Session={...session,id:'next-session'};
    list.mockResolvedValueOnce([examination({id:'next-exam',participantId:'next-person',roomId:'診間 3'})]);
    await render([person()]);
    await until(()=>list.mock.calls.length===1);
    await render([person({id:'next-person',sessionId:nextSession.id,name:'新場次人員'})],nextSession);
    await until(()=>roomGroup().querySelector('[aria-label="診間3：檢查中"]')!==null);
    expectRooms([3]);
    await act(async()=>{
      if(outcome==='resolve')resolveOld([examination()]);
      else rejectOld(new Error('舊場次查詢失敗'));
    });
    expectRooms([3]);
    expect(roomCell('新場次人員')).toBe('診間3');
    expect(errors).not.toHaveBeenCalled();
    expect(list.mock.calls).toEqual([['person-1'],['next-person']].map(ids=>[ids]));
  });
});
