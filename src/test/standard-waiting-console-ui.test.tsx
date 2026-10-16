import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {UltrasoundConsole} from '../features/console/Console';
import {callParticipant,cancelPromotedParticipant,promoteWaitingParticipant} from '../features/console/service';
import {getStandardWaitingQueue} from '../features/workflow/service';
import type {Participant,Session} from '../types';

vi.mock('../features/workflow/service',()=>({getStandardWaitingQueue:vi.fn()}));
vi.mock('../features/console/service',()=>({callParticipant:vi.fn(),updateWaitingStatus:vi.fn(),promoteWaitingParticipant:vi.fn(),cancelPromotedParticipant:vi.fn()}));
vi.mock('../features/examination/service',async original=>({...await original<typeof import('../features/examination/service')>(),listExaminations:vi.fn(async()=>[])}));
vi.mock('../features/room/useRoomStates',()=>({useRoomStates:()=>({rooms:[],loading:false,error:'',refresh:vi.fn(async()=>{})})}));
vi.mock('../features/sync/realtime',()=>({subscribeExaminations:()=>()=>{}}));

const session:Session={id:'standard',companyName:'ITRI',sessionDate:'2026-10-16',status:'active',roomCount:4,workflowMode:'standard'};
const person=(id:string,patch:Partial<Participant>={}):Participant=>({id,sessionId:session.id,sequence:1,employeeNo:id,name:id,gender:'男',slot:'07:30~08:00',groupCode:'A',plannedItems:['腹部超音波'],checkinNo:`A${id}`,status:'等候中',checkedInAt:'2026-10-15T23:30:00Z',checkinSequence:Number(id),promotedAt:null,calledAt:null,note:'',updatedAt:'2026-10-16T00:00:00Z',...patch});
const queue=vi.mocked(getStandardWaitingQueue);
const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
let root:Root;let container:HTMLDivElement;let changed:ReturnType<typeof vi.fn>;let errors:ReturnType<typeof vi.fn>;
const defaultRows=()=>[1,2,3,4,5].map(id=>person(String(id)));
const defaultRanks=()=>new Map([['1',1],['2',2],['3',3],['4',4],['5',5]]);
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((accept,deny)=>{resolve=accept;reject=deny;});return{promise,resolve,reject};}
async function render(rows=defaultRows(),current:Session|null=session){await act(async()=>{root.render(<UltrasoundConsole current={current} participants={rows} onChanged={changed} onError={errors}/>);});}
function names(){return Array.from(container.querySelectorAll('tbody tr b')).map(node=>node.textContent);}
function row(id:string){const result=Array.from(container.querySelectorAll('tbody tr')).find(element=>element.querySelector('b')?.textContent===id);if(!result)throw new Error(`missing row ${id}`);return result;}
function button(label:string,scope:ParentNode=container){return Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(element=>element.textContent===label);}
async function click(label:string,scope:ParentNode=container){const target=button(label,scope);if(!target)throw new Error(`missing button ${label}`);await act(async()=>{target.click();});}
async function settle(){await act(async()=>{await vi.advanceTimersByTimeAsync(125);});}

describe('標準控制台提早安排與共用伺服器順位',()=>{
  beforeEach(()=>{
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;vi.useFakeTimers();
    queue.mockReset().mockResolvedValue(defaultRanks());
    vi.mocked(promoteWaitingParticipant).mockReset().mockResolvedValue(undefined);vi.mocked(cancelPromotedParticipant).mockReset().mockResolvedValue(undefined);vi.mocked(callParticipant).mockReset().mockResolvedValue(undefined);
    changed=vi.fn(async()=>{});errors=vi.fn();container=document.createElement('div');document.body.append(container);root=createRoot(container);
  });
  afterEach(async()=>{await act(async()=>{root.unmount();});container.remove();vi.useRealTimers();vi.restoreAllMocks();actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;});

  it('現場優先採用完整server順序，前三位沒有提早安排按鈕',async()=>{
    queue.mockResolvedValue(new Map([['5',1],['4',2],['3',3],['2',4],['1',5]]));
    await render();expect(names()).toEqual(['5','4','3','2','1']);expect(queue).toHaveBeenCalledExactlyOnceWith(session.id);
    for(const id of ['5','4','3'])expect(button('提早安排',row(id))).toBeUndefined();
    for(const id of ['2','1'])expect(button('提早安排',row(id))).toBeDefined();
  });

  it('分組篩選仍使用全場順位，第A組唯一一人仍可位於全場第4',async()=>{
    const rows=defaultRows().map(item=>({...item,groupCode:item.id==='4'?'A' as const:'B' as const}));
    await render(rows);await click('A');expect(names()).toEqual(['4']);expect(button('提早安排',row('4'))).toBeDefined();expect(queue).toHaveBeenCalledTimes(1);
  });

  it('提早安排僅傳participant ID，成功後更新名單並重新取得伺服器順位',async()=>{
    await render();queue.mockResolvedValue(new Map([['1',1],['2',2],['3',3],['5',4],['4',5]]));
    await click('提早安排',row('5'));
    expect(promoteWaitingParticipant).toHaveBeenCalledExactlyOnceWith('5');expect(changed).toHaveBeenCalledTimes(1);expect(queue).toHaveBeenCalledTimes(2);expect(names()).toEqual(['1','2','3','5','4']);expect(errors).not.toHaveBeenCalled();
  });

  it('等待中的promoted人員顯示小badge及取消，即使已自然遞補至前三位',async()=>{
    const rows=defaultRows().map(item=>item.id==='3'?{...item,promotedAt:'2026-10-16T01:00:00Z'}:item);
    await render(rows);expect(row('3').textContent).toContain('提早安排');expect(button('取消提早安排',row('3'))).toBeDefined();expect(button('提早安排',row('3'))).toBeUndefined();
    await click('取消提早安排',row('3'));expect(cancelPromotedParticipant).toHaveBeenCalledExactlyOnceWith('3');expect(changed).toHaveBeenCalledTimes(1);expect(queue).toHaveBeenCalledTimes(2);
  });

  it('非等候狀態不顯示提早安排操作或badge，原叫號仍正常',async()=>{
    await render([person('1'),person('4',{status:'上廁所',promotedAt:'2026-10-16T01:00:00Z'})]);
    expect(button('提早安排',row('4'))).toBeUndefined();expect(button('取消提早安排',row('4'))).toBeUndefined();expect(row('4').textContent).not.toContain('提早安排');
    await click('叫號',row('1'));expect(callParticipant).toHaveBeenCalledExactlyOnceWith('1');expect(changed).toHaveBeenCalledTimes(1);
  });

  it('RPC失敗顯示中文錯誤，不更新名單或假裝成功',async()=>{
    await render();vi.mocked(promoteWaitingParticipant).mockRejectedValueOnce(new Error('protected_top_three'));
    await click('提早安排',row('4'));expect(errors).toHaveBeenCalledWith('目前候檢前三位已受保護，無法提早安排。');expect(changed).not.toHaveBeenCalled();expect(queue).toHaveBeenCalledTimes(1);
  });

  it('RPC已成功而名單重載失敗時仍刷新queue，並清楚回報操作已完成',async()=>{
    await render();changed.mockRejectedValueOnce(new Error('offline'));
    await click('提早安排',row('4'));expect(promoteWaitingParticipant).toHaveBeenCalledWith('4');expect(queue).toHaveBeenCalledTimes(2);expect(errors).toHaveBeenCalledWith('操作已完成，但名單重新載入失敗：offline');
  });

  it('順位尚未載入時顯示讀取提示，不顯示提早安排',async()=>{
    const pending=deferred<ReadonlyMap<string,number>>();queue.mockReturnValueOnce(pending.promise);
    await render();expect(container.querySelector('[role="status"]')?.textContent).toContain('候檢順位讀取中');expect(button('提早安排')).toBeUndefined();
    expect(names()).toEqual([]);expect(container.querySelector('tbody')?.textContent).toContain('候檢順位尚未確認，請等候載入或重試。');expect(container.querySelector('tbody')?.textContent).not.toContain('此分組尚無今日受檢者');
    await act(async()=>{pending.resolve(defaultRanks());});expect(container.querySelector('[role="status"]')).toBeNull();expect(button('提早安排',row('4'))).toBeDefined();expect(names()).toEqual(['1','2','3','4','5']);
  });

  it('順位更新失敗清除可操作的舊rank，顯示明確錯誤與重試',async()=>{
    await render();queue.mockRejectedValueOnce(new Error('network'));
    await act(async()=>{window.dispatchEvent(new Event('focus'));});await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('目前無法確認候檢順序，請重試');expect(button('提早安排')).toBeUndefined();
    expect(names()).toEqual([]);expect(container.querySelector('tbody')?.textContent).toContain('候檢順位尚未確認，請等候載入或重試。');
    await click('重試');expect(container.querySelector('[role="alert"]')).toBeNull();expect(button('提早安排',row('4'))).toBeDefined();expect(queue).toHaveBeenCalledTimes(3);expect(names()).toEqual(['1','2','3','4','5']);
  });

  it('順位未確認時保留其他狀態，手動號碼及診間仍可查看等候者並叫號',async()=>{
    queue.mockRejectedValueOnce(new Error('network'));
    const rows=[...defaultRows(),person('examining',{status:'檢查中',checkinNo:'A8'}),person('called',{status:'已叫號',checkinNo:'A9'})];
    await render(rows);expect(names()).toEqual(['examining','called']);expect(container.querySelector('tbody')?.textContent).toContain('候檢順位尚未確認');
    const select=container.querySelector<HTMLSelectElement>('select[aria-label="排序"]')!;
    for(const mode of ['queue','room']){
      await act(async()=>{select.value=mode;select.dispatchEvent(new Event('change',{bubbles:true}));});
      expect(names()).toHaveLength(7);expect(button('叫號',row('1'))).toBeDefined();expect(button('提早安排',row('4'))).toBeUndefined();expect(container.querySelector('tbody')?.textContent).not.toContain('候檢順位尚未確認');
    }
    await click('叫號',row('1'));expect(callParticipant).toHaveBeenCalledExactlyOnceWith('1');
    await act(async()=>{select.value='priority';select.dispatchEvent(new Event('change',{bubbles:true}));});expect(names()).toEqual(['examining','called']);
  });

  it('同ID的人員排序欄位連續變動合併成一次queue刷新',async()=>{
    const rows=defaultRows();await render(rows);
    await render(rows.map(item=>item.id==='1'?{...item,status:'已叫號'}:item));
    await render(rows.map(item=>item.id==='1'?{...item,status:'已完成'}:item));
    await render(rows.map(item=>item.id==='4'?{...item,promotedAt:'2026-10-16T00:00:01Z'}:item));
    expect(queue).toHaveBeenCalledTimes(1);await settle();expect(queue).toHaveBeenCalledTimes(2);
  });

  it.each([
    {checkedInAt:'2026-10-16T00:30:00Z'},
    {checkinSequence:8},
    {promotedAt:'2026-10-16T00:01:00Z'},
    {groupCode:'B' as const},
    {slot:'08:00~08:30'},
    {sequence:9},
    {checkinNo:'A9'},
  ])('排序欄位變更會重新讀取 %j',async patch=>{
    const rows=defaultRows();await render(rows);await render(rows.map(item=>item.id==='4'?{...item,...patch}:item));await settle();expect(queue).toHaveBeenCalledTimes(2);
  });

  it('單純重排array、更換object identity與非排序欄位不重新讀取',async()=>{
    const rows=defaultRows();await render(rows);await render([...rows].reverse().map(item=>({...item,name:`name-${item.id}`,updatedAt:'2026-10-16T02:00:00Z'})));await settle();expect(queue).toHaveBeenCalledTimes(1);
  });

  it('focus、online及回到visible合併刷新，hidden事件不刷新',async()=>{
    await render();vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');
    await act(async()=>{document.dispatchEvent(new Event('visibilitychange'));});await settle();expect(queue).toHaveBeenCalledTimes(1);
    vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
    await act(async()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'));});await settle();expect(queue).toHaveBeenCalledTimes(2);
  });

  it('場次切換後忽略舊請求回應',async()=>{
    const old=deferred<ReadonlyMap<string,number>>();queue.mockReturnValueOnce(old.promise);await render();
    const next={...session,id:'next'};const rows=defaultRows().map(item=>({...item,sessionId:next.id}));queue.mockResolvedValueOnce(new Map([['5',1],['4',2],['3',3],['2',4],['1',5]]));
    await render(rows,next);expect(names()).toEqual(['5','4','3','2','1']);
    await act(async()=>{old.resolve(defaultRanks());});expect(names()).toEqual(['5','4','3','2','1']);expect(button('提早安排',row('1'))).toBeDefined();
  });

  it('同場次signature更新後忽略在途舊回應，完成後讀取最新queue',async()=>{
    const old=deferred<ReadonlyMap<string,number>>();queue.mockReturnValueOnce(old.promise);await render();
    await render(defaultRows().map(item=>item.id==='4'?{...item,promotedAt:'2026-10-16T00:00:01Z'}:item));
    queue.mockResolvedValueOnce(new Map([['1',1],['2',2],['4',3],['3',4],['5',5]]));
    await act(async()=>{old.resolve(new Map([['5',1],['4',2],['3',3],['2',4],['1',5]]));});
    expect(names()).toEqual([]);expect(button('提早安排')).toBeUndefined();await settle();expect(names()).toEqual(['1','2','4','3','5']);expect(queue).toHaveBeenCalledTimes(2);
  });

  it('manual報到號碼排序保持原規則，返回現場優先才採server順序',async()=>{
    queue.mockResolvedValue(new Map([['5',1],['4',2],['3',3],['2',4],['1',5]]));await render();
    const select=container.querySelector<HTMLSelectElement>('select[aria-label="排序"]')!;
    await act(async()=>{select.value='queue';select.dispatchEvent(new Event('change',{bubbles:true}));});expect(names()).toEqual(['1','2','3','4','5']);
    await act(async()=>{select.value='priority';select.dispatchEvent(new Event('change',{bubbles:true}));});expect(names()).toEqual(['5','4','3','2','1']);expect(queue).toHaveBeenCalledTimes(1);
  });

  it('simple及未選場次不讀standard queue或顯示任何提早安排UI',async()=>{
    const simple={...session,workflowMode:'simple' as const};await render(defaultRows().map(item=>({...item,queueNumber:Number(item.id),promotedAt:'2026-10-16T00:00:01Z'})),simple);
    expect(queue).not.toHaveBeenCalled();expect(container.textContent).not.toContain('提早安排');expect(container.textContent).not.toContain('候檢順位');
    await act(async()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));});await settle();expect(queue).not.toHaveBeenCalled();
    await render([],null);expect(queue).not.toHaveBeenCalled();expect(container.textContent).toContain('請先選擇場次');
  });
});
