import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {SimpleCheckin} from '../features/checkin/SimpleCheckin';
import * as database from '../features/roster/db';
import * as lookup from '../features/roster/lookup';
import type {MasterPerson} from '../features/roster/types';
import type {Participant,Session} from '../types';

const remote=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('../lib/supabase',()=>({requireSupabase:()=>remote}));

const session:Session={id:'simple-session',companyName:'ITRI',sessionDate:'2026-10-07',status:'active',workflowMode:'simple'};
const master=(patch:Partial<MasterPerson>={}):MasterPerson=>({companyName:'ITRI',companyKey:'ITRI',employeeNo:'00125',name:'王小明',nationalId:'A123456789',gender:'男',originalActivity:'一般健檢',item:'一般',extension:'1234',updatedAt:'2026-10-01T00:00:00Z',...patch});
const row=(patch:Record<string,unknown>={})=>({id:'simple-person',session_id:session.id,sequence_no:1,employee_no:'00125',full_name:'王小明',gender:'男',schedule_slot:null,group_code:null,queue_number:1,planned_items:['一般'],checkin_no:'1',status:'等候中',checked_in_at:'2026-10-07T00:01:00Z',called_at:null,note:'院內分機：1234',updated_at:'2026-10-07T00:01:00Z',...patch});
const participant=(patch:Partial<Participant>={}):Participant=>({id:'simple-person',sessionId:session.id,sequence:1,employeeNo:'00125',name:'王小明',gender:'男',slot:null,groupCode:null,queueNumber:1,plannedItems:['一般'],checkinNo:'1',status:'等候中',checkedInAt:'2026-10-07T00:01:00Z',calledAt:null,note:'院內分機：1234',updatedAt:'2026-10-07T00:01:00Z',...patch});
const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
let root:Root;let container:HTMLDivElement;
let notices:ReturnType<typeof vi.fn>;let refresh:ReturnType<typeof vi.fn>;
let unmounted:boolean;

async function until(condition:()=>boolean){
  for(let attempt=0;attempt<100;attempt++){
    if(condition())return;
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
  }
  throw new Error('簡易報到畫面未更新。');
}
function button(label:string){
  const found=Array.from(container.querySelectorAll('button')).find(element=>element.textContent===label);
  if(!found)throw new Error(`找不到按鈕：${label}`);
  return found;
}
function field(label:string){
  const found=container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if(!found)throw new Error(`找不到輸入欄位：${label}`);
  return found;
}
const detail=(label:string)=>Array.from(container.querySelectorAll('dt')).find(element=>element.textContent===label)?.nextElementSibling?.textContent;
const manual=()=>container.querySelector<HTMLFormElement>('form[aria-label="簡易模式新增受檢者"]');
async function click(element:HTMLElement){await act(async()=>{element.click();});}
async function input(element:HTMLInputElement,value:string){
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;
  await act(async()=>{setter.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));});
}
async function submit(form:HTMLFormElement){await act(async()=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});}
async function render(current:Session|null=session,participants:Participant[]=[]){
  await act(async()=>{root.render(<SimpleCheckin current={current} participants={participants} onSuccess={refresh} setNotice={notices}/>);});
}
async function scan(id='A123456789'){
  await input(field('簡易報到身分證'),id);
  await submit(field('簡易報到身分證').form!);
}
async function fillNew(){
  for(const [label,value] of [['新增身分證','A123456789'],['新增姓名','王小明'],['新增工號','00125'],['新增性別','男'],['新增項目','一般']])await input(field(label),value);
}

describe('簡易模式本機查人與確認報到',()=>{
  beforeEach(async()=>{
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;unmounted=false;
    await database.rosterDb.open();
    await database.rosterDb.masterPeople.clear();await database.rosterDb.preparedPeople.clear();await database.rosterDb.companySettings.clear();
    remote.rpc.mockReset();remote.rpc.mockResolvedValue({data:row(),error:null});
    notices=vi.fn();refresh=vi.fn(async()=>{});
    container=document.createElement('div');document.body.append(container);root=createRoot(container);
  });
  afterEach(async()=>{
    if(!unmounted)await act(async()=>{root.unmount();});
    container.remove();vi.restoreAllMocks();actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;
  });

  it('沒有每日排程也可索引查身分證，確認前不呼叫雲端、不取號',async()=>{
    await database.replaceCompanyMaster('ITRI',[master()]);
    const roster=vi.spyOn(database,'getCompanyMaster');const prepared=vi.spyOn(database,'getPreparedSchedule');
    await render();await scan('a123456789');await until(()=>detail('姓名')==='王小明');
    expect(detail('工號')).toBe('00125');expect(detail('項目')).toBe('一般');expect(detail('院內分機')).toBe('1234');
    expect(container.textContent).not.toMatch(/排程時段|每日排程|A～G|A1/);
    expect(remote.rpc).not.toHaveBeenCalled();expect(roster).not.toHaveBeenCalled();expect(prepared).not.toHaveBeenCalled();
    await click(button('確認報到'));await until(()=>detail('號碼')==='1');
    expect(remote.rpc).toHaveBeenCalledExactlyOnceWith('simple_check_in_participant',{
      p_session_id:session.id,p_employee_no:'00125',p_full_name:'王小明',p_gender:'男',p_item:'一般',p_extension:'1234',
    });
    expect(JSON.stringify(remote.rpc.mock.calls)).not.toContain('A123456789');
    expect(notices).toHaveBeenCalledWith('報到完成，王小明，號碼：1。');expect(refresh).toHaveBeenCalledTimes(1);
    await click(button('掃描下一位'));expect(field('簡易報到身分證').value).toBe('');
    expect(container.querySelector('dl')).toBeNull();expect(document.activeElement).toBe(field('簡易報到身分證'));
  });

  it('完整身分證自動查詢，未完成掃描不啟動查詢',async()=>{
    await database.replaceCompanyMaster('ITRI',[master()]);const indexed=vi.spyOn(lookup,'lookupCompanyMaster');
    await render();await input(field('簡易報到身分證'),'A123');
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,150));});expect(indexed).not.toHaveBeenCalled();
    await input(field('簡易報到身分證'),'a123456789');await until(()=>detail('姓名')==='王小明');
    expect(indexed).toHaveBeenCalledExactlyOnceWith('ITRI',{nationalId:'A123456789'});expect(remote.rpc).not.toHaveBeenCalled();
  });

  it('工號精確查詢保留前導零，Enter 等同查詢而非報到',async()=>{
    await database.replaceCompanyMaster('ITRI',[master()]);const indexed=vi.spyOn(lookup,'lookupCompanyMaster');
    await render();await click(button('工號'));await input(field('簡易報到工號'),'00125');await submit(field('簡易報到工號').form!);
    await until(()=>detail('工號')==='00125');expect(indexed).toHaveBeenCalledWith('ITRI',{employeeNo:'00125'});
    expect(remote.rpc).not.toHaveBeenCalled();
  });

  it.each(['檢查中','已完成'] as const)('重複掃描顯示原號碼及原%s狀態，不重新報到',async status=>{
    await database.replaceCompanyMaster('ITRI',[master()]);await render(session,[participant({status,queueNumber:12,checkinNo:'12'})]);
    await scan();await until(()=>detail('報到號碼')==='12');
    expect(container.textContent).toContain('王小明已完成報到');expect(detail('目前狀態')).toBe(status);
    expect(Array.from(container.querySelectorAll('button')).some(element=>element.textContent==='確認報到')).toBe(false);
    expect(remote.rpc).not.toHaveBeenCalled();expect(refresh).not.toHaveBeenCalled();
  });

  it('參與者快取尚未更新時，伺服器重複報到回傳原號碼與完成狀態',async()=>{
    await database.replaceCompanyMaster('ITRI',[master()]);remote.rpc.mockResolvedValue({data:row({queue_number:12,sequence_no:12,checkin_no:'12',status:'已完成',checked_in_at:'2026-10-01T00:00:00Z'}),error:null});
    await render();await scan();await until(()=>detail('姓名')==='王小明');await click(button('確認報到'));
    expect(detail('號碼')).toBe('12');expect(detail('目前狀態')).toBe('已完成');expect(remote.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([{name:'另一人'},{gender:'女'}])('同工號不同人員資料不可沿用既有報到：%j',async patch=>{
    await database.replaceCompanyMaster('ITRI',[master()]);await render(session,[participant(patch)]);await scan();
    await until(()=>Boolean(container.querySelector('[role=alert]')));expect(container.textContent).toContain('人員資料不同');
    expect(container.querySelector('dl')).toBeNull();expect(remote.rpc).not.toHaveBeenCalled();
  });

  it('連點確認只送出一次，雲端失敗後保留人員並可重試',async()=>{
    let finish!:(response:unknown)=>void;remote.rpc.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    await database.replaceCompanyMaster('ITRI',[master()]);await render();await scan();await until(()=>detail('姓名')==='王小明');
    const confirm=button('確認報到');await act(async()=>{confirm.click();confirm.click();});expect(remote.rpc).toHaveBeenCalledTimes(1);
    expect(button('報到中…').disabled).toBe(true);expect(field('簡易報到身分證').disabled).toBe(true);
    await act(async()=>{finish({data:null,error:{message:'Failed to fetch'}});});
    expect(container.textContent).toContain('無法連線至雲端');expect(detail('姓名')).toBe('王小明');expect(button('確認報到').disabled).toBe(false);
    expect(refresh).not.toHaveBeenCalled();await click(button('確認報到'));expect(detail('號碼')).toBe('1');expect(remote.rpc).toHaveBeenCalledTimes(2);
  });

  it('成功後名單更新失敗仍保留已報到結果，不提供再次確認',async()=>{
    await database.replaceCompanyMaster('ITRI',[master()]);refresh.mockRejectedValue(new Error('Network error'));
    await render();await scan();await until(()=>detail('姓名')==='王小明');await click(button('確認報到'));
    expect(detail('號碼')).toBe('1');expect(container.textContent).toContain('報到已完成，但名單重新整理失敗');
    expect(button('掃描下一位')).toBeDefined();expect(remote.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([false,true])('查無時可新增並報到，選擇加入大名單=%s，鎖定與排程不受影響',async addToMaster=>{
    await database.replaceCompanyMaster('ITRI',[master({employeeNo:'00999',name:'既有受檢者',nationalId:'B123456789'})]);
    const before=await database.rosterDb.companySettings.toArray();await render();await scan();
    await until(()=>Boolean(container.textContent?.includes('公司大名單查無此受檢者。')));await click(button('新增受檢者'));
    expect(field('新增身分證').value).toBe('A123456789');await fillNew();
    if(addToMaster)await click(manual()!.querySelector<HTMLInputElement>('input[type=checkbox]')!);
    await submit(manual()!);await until(()=>detail('號碼')==='1');
    expect(manual()).toBeNull();expect(await database.rosterDb.masterPeople.count()).toBe(addToMaster?2:1);
    expect(await database.rosterDb.companySettings.toArray()).toEqual(before);
    expect(await database.rosterDb.preparedPeople.count()).toBe(0);
    expect(remote.rpc.mock.calls[0][1]).not.toHaveProperty('p_national_id');expect(remote.rpc.mock.calls[0][1].p_extension).toBe('');
  });

  it('單筆新增後雲端失敗，保留表單並重試時不重複新增本機大名單',async()=>{
    remote.rpc.mockResolvedValueOnce({data:null,error:{message:'Network error'}});await render();
    await click(button('新增受檢者'));await fillNew();await click(manual()!.querySelector<HTMLInputElement>('input[type=checkbox]')!);
    await submit(manual()!);await until(()=>Boolean(container.querySelector('[role=alert]')));
    expect(field('新增工號').value).toBe('00125');expect(manual()).not.toBeNull();expect(await database.rosterDb.masterPeople.count()).toBe(1);
    await submit(manual()!);await until(()=>detail('號碼')==='1');expect(await database.rosterDb.masterPeople.count()).toBe(1);
    expect(remote.rpc.mock.calls[1]).toEqual(remote.rpc.mock.calls[0]);
  });

  it('新增必填與身分證驗證失敗不寫本機或雲端，取消保留大名單',async()=>{
    await render();await click(button('新增受檢者'));await fillNew();await input(field('新增性別'),' ');
    await submit(manual()!);expect(container.textContent).toContain('必填');expect(remote.rpc).not.toHaveBeenCalled();
    await input(field('新增性別'),'男');await input(field('新增身分證'),'A123');await submit(manual()!);
    expect(container.textContent).toContain('完整且格式正確的身分證');await click(button('取消'));
    expect(manual()).toBeNull();expect(await database.rosterDb.masterPeople.count()).toBe(0);
  });

  it('新增人工表單取消既有查詢，晚到查詢不可覆蓋人工報到成功',async()=>{
    let finish!:(value:MasterPerson)=>void;vi.spyOn(lookup,'lookupCompanyMaster').mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    await render();await scan();await click(button('新增受檢者'));await fillNew();await submit(manual()!);
    expect(detail('號碼')).toBe('1');await act(async()=>{finish(master({employeeNo:'00999',name:'晚到人員'}));});
    expect(detail('姓名')).toBe('王小明');expect(detail('號碼')).toBe('1');expect(container.textContent).not.toContain('晚到人員');
  });

  it.each(['session','company','closing','unmount'] as const)('晚到索引查詢不污染新畫面／不建立 participant：%s',async change=>{
    let finish!:(value:MasterPerson)=>void;vi.spyOn(lookup,'lookupCompanyMaster').mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    await render();await scan();
    if(change==='unmount'){await act(async()=>root.unmount());unmounted=true;}
    else await render(change==='session'?{...session,id:'another-session'}:change==='company'?{...session,companyName:'另一公司'}:{...session,status:'closing'});
    await act(async()=>{finish(master());});
    expect(container.querySelector('dl')).toBeNull();expect(remote.rpc).not.toHaveBeenCalled();expect(notices).not.toHaveBeenCalled();
  });

  it.each(['switch','closing','unmount'] as const)('晚到報到結果不通知、重新整理或覆蓋其他場次：%s',async change=>{
    let finish!:(response:unknown)=>void;remote.rpc.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    await database.replaceCompanyMaster('ITRI',[master()]);await render();await scan();await until(()=>detail('姓名')==='王小明');await click(button('確認報到'));
    if(change==='unmount'){await act(async()=>root.unmount());unmounted=true;}
    else await render(change==='switch'?{...session,id:'another-session'}:{...session,status:'closing'});
    await act(async()=>{finish({data:row(),error:null});});
    expect(container.querySelector('dl')).toBeNull();expect(notices).not.toHaveBeenCalled();expect(refresh).not.toHaveBeenCalled();
  });
});
