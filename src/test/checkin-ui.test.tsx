import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import Dexie from 'dexie';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Checkin} from '../features/checkin/Checkin';
import {WalkInModal} from '../features/checkin/WalkInModal';
import {registerAndCheckIn,WalkInRegistrationError} from '../features/checkin/walkin';
import * as database from '../features/roster/db';
import type {MasterPerson,PreparedPerson} from '../features/roster/types';
import {findParticipant} from '../features/schedule/service';
import type {Participant,Session} from '../types';

const remote=vi.hoisted(()=>({checkIn:vi.fn()}));
vi.mock('../features/checkin/walkin',async importOriginal=>({...await importOriginal<typeof import('../features/checkin/walkin')>(),registerAndCheckIn:vi.fn()}));
vi.mock('../features/schedule/service',async importOriginal=>({...await importOriginal<typeof import('../features/schedule/service')>(),findParticipant:vi.fn()}));
vi.mock('../features/checkin/service',()=>({SupabaseCheckinService:class {checkIn=remote.checkIn;}}));

const session:Session={id:'walkin-session',companyName:'ITRI',sessionDate:'2026-10-06',status:'active'};
const master=(patch:Partial<MasterPerson>={}):MasterPerson=>({companyName:'ITRI',companyKey:'ITRI',employeeNo:'00125',name:'王小明',nationalId:'A123456789',gender:'男',originalActivity:'員工健檢活動',item:'腹部超音波',extension:'1234',updatedAt:'2026-10-01T00:00:00Z',...patch});
const prepared=(patch:Partial<PreparedPerson>={}):PreparedPerson=>({localId:'retained-local-id',sequence:8,employeeNo:'00125',name:'王小明',gender:'男',scheduleDate:session.sessionDate,slot:'08:30~09:00',item:'腹部超音波',extension:'1234',nationalId:'A123456789',originalActivity:'員工健檢活動',dailyActivity:'員工健檢活動',issues:[],confirmed:true,...patch});
const participant=(patch:Partial<Participant>={}):Participant=>({id:'cloud-person',sessionId:session.id,sequence:8,employeeNo:'00125',name:'王小明',gender:'男',slot:'08:30~09:00',groupCode:'C',plannedItems:['腹部超音波','甲狀腺超音波'],checkinNo:'C8',status:'等候中',checkedInAt:'2026-10-06T00:01:00Z',calledAt:null,note:'',updatedAt:'2026-10-06T00:01:00Z',...patch});
const register=vi.mocked(registerAndCheckIn);
const find=vi.mocked(findParticipant);
const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
let root:Root;
let container:HTMLDivElement;
let notices:ReturnType<typeof vi.fn>;
let refresh:ReturnType<typeof vi.fn>;

async function until(condition:()=>boolean){
  for(let attempt=0;attempt<100;attempt++){
    if(condition())return;
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
  }
  throw new Error('報到畫面未在預期時間更新。');
}
function button(label:string){
  const result=Array.from(container.querySelectorAll('button')).find(element=>element.textContent===label);
  if(!result)throw new Error(`找不到按鈕：${label}`);
  return result;
}
const modal=()=>container.querySelector<HTMLElement>('[role="dialog"]');
function field(label:string){
  const wrapper=Array.from(modal()!.querySelectorAll('label')).find(element=>element.querySelector('.label')?.textContent===label);
  const result=wrapper?.querySelector<HTMLInputElement>('input');
  if(!result)throw new Error(`找不到輸入欄位：${label}`);
  return result;
}
const detail=(label:string)=>Array.from(container.querySelectorAll('dt')).find(element=>element.textContent===label)?.nextElementSibling?.textContent;
async function click(element:HTMLElement){await act(async()=>{element.click();});}
async function input(element:HTMLInputElement,value:string){
  const setValue=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;
  await act(async()=>{setValue.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));});
}
async function render(current:Session=session,participants:Participant[]=[]){
  await act(async()=>{root.render(<Checkin current={current} participants={participants} onSuccess={refresh} setNotice={notices}/>);});
}
async function scan(nationalId='A123456789'){
  const query=container.querySelector<HTMLInputElement>('#national-id-query')!;
  await input(query,nationalId);
  await act(async()=>{query.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));});
}
async function openNew(){await render();await scan();await until(()=>modal()!==null);}
async function fillNew(){
  await input(field('姓名'),'王小明');
  await input(field('工號'),'00125');
  await input(field('性別（選填）'),'男');
  await input(field('項目'),'腹部超音波');
}
async function snapshot(){
  return {master:await database.getCompanyMaster('ITRI'),schedule:await database.getPreparedSchedule(session.id),settings:await database.rosterDb.companySettings.toArray()};
}

describe('手動報到與現場新增操作',()=>{
  beforeEach(async()=>{
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;
    await database.rosterDb.open();
    await database.rosterDb.masterPeople.clear();
    await database.rosterDb.preparedPeople.clear();
    await database.rosterDb.companySettings.clear();
    register.mockReset();
    register.mockResolvedValue(participant());
    find.mockReset();
    find.mockResolvedValue(null);
    remote.checkIn.mockReset();
    remote.checkIn.mockResolvedValue({checkin_no:'C8',status:'等候中'});
    notices=vi.fn();
    refresh=vi.fn(async()=>{});
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

  it('雲端今日名單為零仍可掃描，從公司大名單自動帶入且只需選擇時段',async()=>{
    await database.replaceCompanyMaster('ITRI',[master()]);
    const before=await snapshot();
    await render();
    const query=container.querySelector<HTMLInputElement>('#national-id-query')!;
    const lookup=vi.spyOn(database,'getPreparedSchedule');
    await input(query,'A123');
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,420));});
    expect(lookup).not.toHaveBeenCalled();
    await input(query,'a123456789');
    await until(()=>modal()!==null);
    expect(modal()?.getAttribute('aria-label')).toBe('加入今日排程');
    for(const value of ['王小明','00125','男','A123456789','腹部超音波','1234'])expect(modal()?.textContent).toContain(value);
    expect(modal()?.querySelectorAll('input')).toHaveLength(0);
    expect(modal()?.querySelector('input[type="date"]')).toBeNull();
    expect(modal()?.textContent).not.toContain('排程日期');
    expect(modal()?.querySelector('input[type="checkbox"]')).toBeNull();
    const slot=modal()!.querySelector<HTMLSelectElement>('select')!;
    expect(slot.disabled).toBe(false);
    await act(async()=>{slot.value='09:00~09:30';slot.dispatchEvent(new Event('change',{bubbles:true}));});
    expect(button('加入今日排程並報到').disabled).toBe(false);
    expect(await snapshot()).toEqual(before);
    expect(find).not.toHaveBeenCalled();
    await click(button('加入今日排程並報到'));
    await until(()=>modal()===null);
    expect(register).toHaveBeenCalledWith(session,expect.objectContaining({employeeNo:'00125',name:'王小明',nationalId:'A123456789',scheduleDate:session.sessionDate,slot:'09:00~09:30',item:'腹部超音波',extension:'1234',originalActivity:'員工健檢活動'}),false);
  });

  it('未知身分證帶入新增視窗，日期不顯示、姓名與工號必填而性別分機可空',async()=>{
    await openNew();
    expect(modal()?.getAttribute('aria-label')).toBe('新增受檢者');
    expect(field('身分證').value).toBe('A123456789');
    expect(field('身分證').readOnly).toBe(true);
    expect(modal()?.querySelector('input[type="date"]')).toBeNull();
    expect(modal()?.textContent).not.toContain('排程日期');
    const checkbox=modal()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(false);
    for(const label of ['姓名','工號'])expect(field(label).required).toBe(true);
    expect(field('性別（選填）').required).toBe(false);expect(field('性別（選填）').value).toBe('');
    expect(field('項目').required).toBe(false);expect(field('項目').value).toBe('一般');
    expect(field('院內分機（選填）').required).toBe(false);
    expect(button('新增並報到').disabled).toBe(true);
    await click(button('新增並報到'));
    expect(register).not.toHaveBeenCalled();
    for(const [label,value] of [['姓名','王小明'],['工號','00125']])await input(field(label),value);
    expect(button('新增並報到').disabled).toBe(false);
    await input(field('項目'),'腹部超音波');
    expect(button('新增並報到').disabled).toBe(false);
    await input(field('姓名'),'   ');
    expect(button('新增並報到').disabled).toBe(true);
    expect(await snapshot()).toEqual({master:[],schedule:[],settings:[]});
  });

  it.each([false,true])('新建人員性別與分機空白可送出，清空項目仍回填一般且保留工號前導零；加入大名單 %s',async addToMaster=>{
    await openNew();await input(field('姓名'),' 王小明 ');await input(field('工號'),' 00125 ');
    await input(field('項目'),'   ');await input(field('性別（選填）'),'   ');
    if(addToMaster)await click(modal()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    expect(button('新增並報到').disabled).toBe(false);
    await click(button('新增並報到'));await until(()=>modal()===null);
    expect(register).toHaveBeenCalledWith(session,expect.objectContaining({
      nationalId:'A123456789',employeeNo:'00125',name:'王小明',gender:'',extension:'',item:'一般',
      originalActivity:'一般',dailyActivity:'一般',scheduleDate:session.sessionDate,slot:'07:30~08:00',
    }),addToMaster);
  });

  it.each([
    {label:'姓名',message:'請輸入姓名。'},
    {label:'工號',message:'請輸入工號。'},
  ])('$label 只有空白時禁止送出並顯示明確錯誤',async({label,message})=>{
    await openNew();await input(field('姓名'),'王小明');await input(field('工號'),'00125');await input(field(label),'   ');
    expect(button('新增並報到').disabled).toBe(true);
    await act(async()=>{modal()!.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    expect(modal()?.querySelector('[role="alert"]')?.textContent).toBe(message);expect(register).not.toHaveBeenCalled();
  });

  it('沒有掃描身分證的新增入口允許輸入，無效格式禁止送出且有效格式才可新增',async()=>{
    const onComplete=vi.fn();
    await act(async()=>{root.render(<WalkInModal session={session} candidate={{nationalId:''}} onClose={vi.fn()} onComplete={onComplete}/>);});
    expect(field('身分證').readOnly).toBe(false);expect(field('身分證').required).toBe(true);
    await input(field('姓名'),'王小明');await input(field('工號'),'00125');await input(field('身分證'),'A123');
    expect(button('新增並報到').disabled).toBe(true);
    await act(async()=>{modal()!.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    expect(modal()?.querySelector('[role="alert"]')?.textContent).toBe('請確認完整且格式正確的身分證。');expect(register).not.toHaveBeenCalled();
    await input(field('身分證'),'a123456789');expect(button('新增並報到').disabled).toBe(false);
    await click(button('新增並報到'));expect(register).toHaveBeenCalledWith(session,expect.objectContaining({nationalId:'A123456789',item:'一般'}),false);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('保留標準模式有效排程時段要求，無效值不可送出',async()=>{
    await openNew();await input(field('姓名'),'王小明');await input(field('工號'),'00125');
    const slot=modal()!.querySelector<HTMLSelectElement>('select')!;expect(slot.required).toBe(true);
    await act(async()=>{slot.value='';slot.dispatchEvent(new Event('change',{bubbles:true}));});
    expect(button('新增並報到').disabled).toBe(true);
    await act(async()=>{modal()!.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    expect(modal()?.querySelector('[role="alert"]')?.textContent).toBe('請選擇有效的排程時段。');expect(register).not.toHaveBeenCalled();
  });

  it.each([false,true])('成功新增顯示完整報到結果並可掃描下一位；加入大名單選擇為 %s',async addToMaster=>{
    await openNew();
    await fillNew();
    if(addToMaster)await click(modal()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await click(button('新增並報到'));
    await until(()=>modal()===null);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(session,expect.objectContaining({nationalId:'A123456789',employeeNo:'00125',name:'王小明',gender:'男',scheduleDate:session.sessionDate,item:'腹部超音波',originalActivity:'腹部超音波',dailyActivity:'腹部超音波',extension:''}),addToMaster);
    expect(container.textContent).toContain('王小明');
    expect(detail('工號')).toBe('00125');
    expect(detail('排程時段')).toBe('08:30~09:00');
    expect(detail('項目')).toBe('腹部超音波、甲狀腺超音波');
    expect(detail('報到編號')).toBe('C8');
    expect(detail('目前狀態')).toBe('等候中');
    expect(button('已報到 C8').disabled).toBe(true);
    expect(notices).toHaveBeenCalledWith('報到完成，編號 C8。');
    expect(refresh).toHaveBeenCalledTimes(1);
    await click(button('掃描下一位'));
    expect(container.querySelector<HTMLInputElement>('#national-id-query')?.value).toBe('');
    expect(container.querySelector('dl')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('#national-id-query'));
  });

  it.each(['取消','關閉新增視窗'])('使用「%s」取消不呼叫新增或改動本機排程與大名單',async action=>{
    await database.replaceCompanyMaster('ITRI',[master({nationalId:'B123456789'})]);
    await database.replacePreparedSchedule(session.id,[prepared({nationalId:'B123456789'})]);
    const before=await snapshot();
    await openNew();
    await fillNew();
    await click(modal()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    const cancel=action==='取消'?button('取消'):modal()!.querySelector<HTMLButtonElement>('[aria-label="關閉新增視窗"]')!;
    await click(cancel);
    expect(modal()).toBeNull();
    expect(register).not.toHaveBeenCalled();
    expect(remote.checkIn).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect(container.querySelector<HTMLInputElement>('#national-id-query')?.value).toBe('');
  });

  it('公司大名單同一身分證對應多筆時提示確認，不開啟新增視窗或任意選人',async()=>{
    await database.replaceCompanyMaster('ITRI',[master(),master({employeeNo:'00999',name:'另一人員'})]);
    const before=await snapshot();
    await render();
    await scan();
    await until(()=>notices.mock.calls.length>0);
    expect(notices).toHaveBeenCalledWith('公司大名單中此身分證對應多筆人員，請至名單管理確認。');
    expect(modal()).toBeNull();
    expect(find).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it('本機已有排程但雲端缺少時提供沿用原排程的重試視窗',async()=>{
    const row=prepared();
    await database.replacePreparedSchedule(session.id,[row]);
    const before=await snapshot();
    await render();
    await scan();
    await until(()=>modal()!==null);
    expect(find).toHaveBeenCalledWith(session.id,'00125');
    expect(modal()?.textContent).toContain('本機排程已保留，請重試雲端同步與報到');
    expect(modal()!.querySelector<HTMLSelectElement>('select')?.value).toBe('08:30~09:00');
    expect(modal()!.querySelector<HTMLSelectElement>('select')?.disabled).toBe(true);
    expect(modal()?.querySelector('input[type="checkbox"]')).toBeNull();
    await click(button('加入今日排程並報到'));
    await until(()=>modal()===null);
    expect(register).toHaveBeenCalledWith(session,row,false);
    expect(await snapshot()).toEqual(before);
  });

  it('處理中連點只送出一次，禁止取消、關閉及編輯',async()=>{
    let finish!:(value:Participant)=>void;
    register.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    await openNew();
    await fillNew();
    const submit=button('新增並報到');
    await act(async()=>{submit.click();submit.click();});
    expect(register).toHaveBeenCalledTimes(1);
    expect(button('處理中……').disabled).toBe(true);
    expect(button('取消').disabled).toBe(true);
    expect(modal()?.querySelector<HTMLButtonElement>('[aria-label="關閉新增視窗"]')?.disabled).toBe(true);
    expect(field('姓名').disabled).toBe(true);
    expect(modal()?.querySelector<HTMLSelectElement>('select')?.disabled).toBe(true);
    expect(modal()?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);
    await click(button('取消'));
    expect(modal()).not.toBeNull();
    await act(async()=>{finish(participant());});
    await until(()=>modal()===null);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('結構化錯誤顯示可讀訊息且可重試，重試沿用相同本機識別碼',async()=>{
    register.mockRejectedValueOnce({message:'雲端暫時無法服務',code:'503'});
    await openNew();
    await fillNew();
    await click(button('新增並報到'));
    await until(()=>Boolean(modal()?.querySelector('[role="alert"]')));
    expect(modal()?.querySelector('[role="alert"]')?.textContent).toBe('雲端暫時無法服務');
    expect(modal()?.textContent).not.toContain('[object Object]');
    expect(button('新增並報到').disabled).toBe(false);
    expect(button('取消').disabled).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    await click(button('新增並報到'));
    await until(()=>modal()===null);
    expect(register).toHaveBeenCalledTimes(2);
    expect(register.mock.calls[1][1].localId).toBe(register.mock.calls[0][1].localId);
    expect(detail('報到編號')).toBe('C8');
  });

  it('新增已寫入本機但雲端失敗時鎖定原人員與時段，明確重試沿用已保存排程',async()=>{
    register.mockImplementationOnce(async(current,row)=>{
      await database.addPreparedPerson(current.id,row);
      throw {message:'本機排程已保留，但雲端新增未完成，請重試'};
    });
    await openNew();
    await fillNew();
    await input(field('院內分機（選填）'),'4321');
    const slot=modal()!.querySelector<HTMLSelectElement>('select')!;
    await act(async()=>{slot.value='09:30~10:00';slot.dispatchEvent(new Event('change',{bubbles:true}));});
    await click(button('新增並報到'));
    await until(()=>Boolean(modal()?.querySelector('[role="alert"]')));
    await until(()=>slot.disabled);
    expect(modal()?.querySelector('[role="alert"]')?.textContent).toContain('本機排程已保留');
    expect(modal()?.textContent).toContain('已保存的人員資料與排程時段會沿用');
    expect(modal()?.querySelector('input:not([readonly]):not([type="checkbox"])')).toBeNull();
    expect(detail('姓名')).toBe('王小明');
    expect(detail('工號')).toBe('00125');
    expect(detail('院內分機')).toBe('4321');
    expect(modal()?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);
    expect(slot.disabled).toBe(true);
    expect(slot.value).toBe('09:30~10:00');
    const stored=(await database.getPreparedSchedule(session.id))[0];
    expect(stored).toMatchObject({employeeNo:'00125',name:'王小明',extension:'4321',slot:'09:30~10:00'});
    const retry=modal()!.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(retry.disabled).toBe(false);
    await click(retry);
    await until(()=>modal()===null);
    expect(register).toHaveBeenCalledTimes(2);
    expect(register.mock.calls[1]).toEqual([session,stored,false]);
    expect(await database.getPreparedSchedule(session.id)).toEqual([stored]);
  });

  it('服務錯誤攜帶已保存排程時立即鎖定重試，不依賴可能失敗的第二次本機查詢',async()=>{
    let stored!:PreparedPerson;
    register.mockImplementationOnce(async(current,row)=>{
      stored=await database.addPreparedPerson(current.id,row);
      throw new WalkInRegistrationError('本機排程已保留，雲端新增未完成',stored);
    });
    await openNew();
    await fillNew();
    const secondaryLookup=vi.spyOn(database,'getPreparedSchedule').mockRejectedValue(new Error('第二次本機讀取失敗'));
    await click(button('新增並報到'));
    await until(()=>Boolean(modal()?.querySelector('[role="alert"]')));
    expect(modal()?.querySelector('[role="alert"]')?.textContent).toBe('本機排程已保留，雲端新增未完成');
    expect(secondaryLookup).not.toHaveBeenCalled();
    expect(modal()?.querySelector('input:not([readonly]):not([type="checkbox"])')).toBeNull();
    expect(modal()?.querySelector<HTMLSelectElement>('select')?.disabled).toBe(true);
    expect(detail('姓名')).toBe(stored.name);
    expect(detail('工號')).toBe(stored.employeeNo);
    const retry=modal()!.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(retry.disabled).toBe(false);
    await click(retry);
    await until(()=>modal()===null);
    expect(register.mock.calls[1]).toEqual([session,stored,false]);
    expect(secondaryLookup).not.toHaveBeenCalled();
  });

  it.each([{name:'不同姓名'},{gender:'女'}])('本機排程與雲端人員資料不一致時阻止報到，重新掃描仍不可繞過：%j',async conflict=>{
    await database.replacePreparedSchedule(session.id,[prepared()]);
    const before=await snapshot();
    find.mockResolvedValue(participant({checkinNo:null,checkedInAt:null,status:'未報到',...conflict}));
    await render();
    await scan();
    await until(()=>notices.mock.calls.length>0);
    expect(notices).toHaveBeenCalledWith(expect.stringMatching(/不一致|不同/));
    expect(modal()).toBeNull();
    expect(container.querySelector('dl')).toBeNull();
    expect(Array.from(container.querySelectorAll('button')).some(element=>element.textContent==='確認報到')).toBe(false);
    await scan();
    await until(()=>find.mock.calls.length===2&&notices.mock.calls.length===2);
    expect(container.querySelector('dl')).toBeNull();
    expect(remote.checkIn).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it('舊本機排程同一工號對應不同身分證時禁止選人，不查詢雲端或報到',async()=>{
    await database.replacePreparedSchedule(session.id,[prepared(),prepared({localId:'duplicate-employee-row',sequence:9,nationalId:'B123456789',name:'第二位人員'})]);
    const before=await snapshot();
    // The cloud result could otherwise match the first row, despite scanning the second person.
    find.mockResolvedValue(participant({checkinNo:null,checkedInAt:null,status:'未報到'}));
    await render();
    await scan('B123456789');
    await until(()=>notices.mock.calls.length>0);
    expect(notices).toHaveBeenCalledWith('此工號在今日排程中對應多筆人員，請至名單管理確認。');
    expect(find).not.toHaveBeenCalled();
    expect(remote.checkIn).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(modal()).toBeNull();
    expect(container.querySelector('dl')).toBeNull();
    expect(Array.from(container.querySelectorAll('button')).some(element=>element.textContent==='確認報到')).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it('已有今日排程走既有確認報到流程，連點只執行一次並顯示伺服器回讀狀態',async()=>{
    await database.replacePreparedSchedule(session.id,[prepared()]);
    find.mockResolvedValueOnce(participant({checkinNo:null,checkedInAt:null,status:'未報到'}));
    find.mockResolvedValueOnce(participant({status:'已叫號'}));
    let finish!:()=>void;
    remote.checkIn.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));
    await render();
    await scan();
    await until(()=>container.textContent?.includes('確認報到')??false);
    expect(modal()).toBeNull();
    const confirm=button('確認報到');
    await act(async()=>{confirm.click();confirm.click();});
    expect(remote.checkIn).toHaveBeenCalledTimes(1);
    expect(remote.checkIn).toHaveBeenCalledWith('cloud-person');
    expect(button('報到中…').disabled).toBe(true);
    await act(async()=>{finish();});
    await until(()=>container.textContent?.includes('掃描下一位')??false);
    expect(detail('報到編號')).toBe('C8');
    expect(detail('目前狀態')).toBe('已叫號');
    expect(find).toHaveBeenCalledTimes(2);
    expect(register).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each(['walkin','scheduled'] as const)('掃描下一位後忽略舊報到的延遲刷新錯誤：%s',async flow=>{
    let rejectRefresh!:(error:Error)=>void;
    refresh.mockImplementationOnce(()=>new Promise<void>((_resolve,reject)=>{rejectRefresh=reject;}));
    if(flow==='scheduled'){
      await database.replacePreparedSchedule(session.id,[prepared()]);
      find.mockResolvedValueOnce(participant({checkinNo:null,checkedInAt:null,status:'未報到'}));
      find.mockResolvedValueOnce(participant());
      await render();
      await scan();
      await until(()=>container.textContent?.includes('確認報到')??false);
      await click(button('確認報到'));
    }else{
      await database.replaceCompanyMaster('ITRI',[master({nationalId:'B123456789'}),master({employeeNo:'00999',nationalId:'B123456789',name:'另一人員'})]);
      await openNew();
      await fillNew();
      await click(button('新增並報到'));
    }
    await until(()=>container.textContent?.includes('掃描下一位')??false);
    expect(refresh).toHaveBeenCalledTimes(1);
    await click(button('掃描下一位'));
    if(flow==='walkin'){
      await scan('B123456789');
      await until(()=>notices.mock.calls.some(([notice])=>notice==='公司大名單中此身分證對應多筆人員，請至名單管理確認。'));
    }
    const previousNotices=notices.mock.calls.map(([notice])=>notice);
    await act(async()=>{rejectRefresh(new Error('舊場次刷新已失敗'));});
    expect(notices.mock.calls.map(([notice])=>notice)).toEqual(previousNotices);
    expect(container.querySelector('dl')).toBeNull();
    expect(modal()).toBeNull();
    if(flow==='walkin')expect(previousNotices.at(-1)).toBe('公司大名單中此身分證對應多筆人員，請至名單管理確認。');
  });

  it('查詢失敗呈現可讀錯誤，重新掃描可繼續新增',async()=>{
    vi.spyOn(database,'getPreparedSchedule').mockRejectedValueOnce({message:'本機資料庫暫時忙碌'});
    await render();
    await scan();
    await until(()=>notices.mock.calls.length>0);
    expect(notices).toHaveBeenCalledWith('查詢失敗：本機資料庫暫時忙碌');
    expect(modal()).toBeNull();
    await scan();
    await until(()=>modal()!==null);
    expect(modal()?.getAttribute('aria-label')).toBe('新增受檢者');
  });

  it('較早查詢晚回覆時不覆蓋重新掃描後的新增人員',async()=>{
    await database.replaceCompanyMaster('ITRI',[master()]);
    const original=database.getCompanyMaster;
    let release!:()=>void;
    const pending=new Promise<void>(resolve=>{release=resolve;});
    const lookup=vi.spyOn(database,'getCompanyMaster').mockImplementationOnce(companyName=>Dexie.Promise.resolve(pending).then(()=>original(companyName)));
    await render();
    await scan();
    await until(()=>lookup.mock.calls.length===1);
    await scan('B123456789');
    await until(()=>modal()!==null);
    expect(field('身分證').value).toBe('B123456789');
    await act(async()=>{release();await lookup.mock.results[0].value;});
    expect(modal()?.getAttribute('aria-label')).toBe('新增受檢者');
    expect(field('身分證').value).toBe('B123456789');
    expect(register).not.toHaveBeenCalled();
  });

  it('切換場次後忽略舊場次仍在進行的查詢，不開啟舊人員視窗',async()=>{
    await database.replaceCompanyMaster('ITRI',[master()]);
    const original=database.getCompanyMaster;
    let release!:()=>void;
    const pending=new Promise<void>(resolve=>{release=resolve;});
    const lookup=vi.spyOn(database,'getCompanyMaster').mockImplementationOnce(companyName=>Dexie.Promise.resolve(pending).then(()=>original(companyName)));
    await render();
    await scan();
    await until(()=>lookup.mock.calls.length===1);
    await render({...session,id:'next-session',companyName:'另一家公司'});
    await act(async()=>{release();await lookup.mock.results[0].value;});
    expect(modal()).toBeNull();
    expect(container.querySelector<HTMLInputElement>('#national-id-query')?.value).toBe('');
    expect(notices).not.toHaveBeenCalled();
    await scan('B123456789');
    await until(()=>modal()!==null);
    expect(field('身分證').value).toBe('B123456789');
  });
});
