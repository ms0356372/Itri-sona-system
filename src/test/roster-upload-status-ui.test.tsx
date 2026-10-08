import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {RosterManager} from '../features/roster/RosterManager';
import * as database from '../features/roster/db';
import {readDailyFile} from '../features/roster/excel';
import {preparedScheduleSignature} from '../features/roster/uploadStatus';
import {uploadPreparedSchedule} from '../features/schedule/service';
import type {DailySchedulePerson,MasterPerson,PreparedPerson} from '../features/roster/types';
import type {ImportResult,Session} from '../types';

vi.mock('../features/roster/excel',async importOriginal=>({...await importOriginal<typeof import('../features/roster/excel')>(),readDailyFile:vi.fn()}));
vi.mock('../features/schedule/service',()=>({uploadPreparedSchedule:vi.fn()}));

const session:Session={id:'upload-status-session',companyName:'ITRI',sessionDate:'2026-10-08',status:'active',workflowMode:'standard'};
const person:MasterPerson={companyName:'ITRI',companyKey:'ITRI',employeeNo:'00125',name:'王小明',nationalId:'A123456789',gender:'男',originalActivity:'一般健檢',item:'一般',extension:'1234',updatedAt:'2026-10-01T00:00:00Z'};
const otherPerson:MasterPerson={...person,employeeNo:'00126',name:'陳小華',nationalId:'B123456789'};
const prepared:PreparedPerson={localId:'upload-status-row',sequence:1,employeeNo:person.employeeNo,name:person.name,gender:person.gender,scheduleDate:session.sessionDate,slot:'07:30~08:00',item:person.item,extension:person.extension,nationalId:person.nationalId,originalActivity:person.originalActivity,dailyActivity:person.originalActivity,issues:[],confirmed:true};
const daily:DailySchedulePerson={sourceRow:2,employeeNo:person.employeeNo,name:person.name,scheduleDate:session.sessionDate,slot:prepared.slot,activity:person.originalActivity,extension:person.extension};
const otherDaily:DailySchedulePerson={...daily,sourceRow:3,employeeNo:otherPerson.employeeNo,name:otherPerson.name};
const upload=vi.mocked(uploadPreparedSchedule);
const dailyReader=vi.mocked(readDailyFile);
const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
let container:HTMLDivElement;
let root:Root;
let notices:ReturnType<typeof vi.fn>;
let onUploaded:ReturnType<typeof vi.fn>;

async function until(condition:()=>boolean){
  for(let attempt=0;attempt<100;attempt++){
    if(condition())return;
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
  }
  throw new Error(`畫面未在預期時間更新：${container.textContent}`);
}
const card=()=>Array.from(container.querySelectorAll('h3')).find(element=>element.textContent==='2. 廠商提供資料（每日排程）')?.closest('section');
const status=()=>card()?.querySelector('[role="status"]');
const button=(label:string)=>{const found=Array.from(container.querySelectorAll('button')).find(element=>element.textContent===label);if(!found)throw new Error(`找不到按鈕：${label}`);return found;};
async function click(element:HTMLElement){await act(async()=>{element.click();});}
async function input(element:HTMLInputElement,value:string){
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;
  await act(async()=>{setter.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));});
}
async function mount(current:Session=session){
  await act(async()=>{root.render(<RosterManager current={current} participants={[]} onUploaded={onUploaded} setNotice={notices}/>);});
  await until(()=>container.querySelector('[aria-label="解鎖公司大名單"]')!==null);
}
async function seed(rows:PreparedPerson[]=[prepared],current:Session=session){
  await database.replacePreparedSchedule(current.id,rows);
  await mount(current);
  if(current.workflowMode!=='simple')await until(()=>container.querySelectorAll('tbody tr').length===rows.length);
}
async function successfulUpload(result:ImportResult={inserted:1,skipped:0}){
  const calls=onUploaded.mock.calls.length;
  upload.mockResolvedValueOnce(result);
  await click(button(await database.getPreparedUpload(session.id)?'重新上傳今日排程':'確認並上傳今日排程'));
  await until(()=>onUploaded.mock.calls.length===calls+1);
  await until(()=>!button('重新上傳今日排程').disabled);
}
async function importDaily(rows:DailySchedulePerson[]){
  dailyReader.mockResolvedValueOnce(rows);
  const calls=notices.mock.calls.length;
  const file=card()!.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(file,'files',{value:[new File(['excel'],'daily.xlsx')],configurable:true});
  await act(async()=>{file.dispatchEvent(new Event('change',{bubbles:true}));});
  await until(()=>notices.mock.calls.length===calls+1);
}
async function remount(current:Session=session){
  await act(async()=>{root.unmount();});
  database.rosterDb.close();
  await database.rosterDb.open();
  root=createRoot(container);
  await mount(current);
}

describe('標準每日排程的持續上傳狀態',()=>{
  beforeEach(async()=>{
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;
    vi.useFakeTimers({toFake:['Date']});
    vi.setSystemTime(new Date('2026-10-08T03:36:00Z'));
    await database.rosterDb.open();
    await database.rosterDb.masterPeople.clear();
    await database.rosterDb.companySettings.clear();
    await database.rosterDb.preparedPeople.clear();
    await database.rosterDb.preparedUploads.clear();
    await database.replaceCompanyMaster(session.companyName,[person,otherPerson]);
    dailyReader.mockReset();upload.mockReset();
    notices=vi.fn();onUploaded=vi.fn().mockResolvedValue(undefined);
    vi.spyOn(window,'confirm').mockReturnValue(true);
    container=document.createElement('div');document.body.append(container);root=createRoot(container);
  });
  afterEach(async()=>{
    await act(async()=>{root.unmount();});
    container.remove();vi.restoreAllMocks();vi.useRealTimers();actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;
  });

  it('從未上傳時在每日卡片中顯示中性的尚未上傳狀態',async()=>{
    await seed();
    expect(status()?.textContent).toBe('尚未上傳');
    expect(status()?.className).toContain('slate');
    expect(card()?.textContent).toContain('已匯入 1 筆');
    expect(button('確認並上傳今日排程').disabled).toBe(false);
    expect(await database.getPreparedUpload(session.id)).toBeNull();
    expect(upload).not.toHaveBeenCalled();
  });

  it('151 筆真正上傳成功後顯示綠色筆數與台灣時間，並保留可重新上傳的按鈕',async()=>{
    const rows=Array.from({length:151},(_,index)=>({...prepared,localId:`upload-status-${index}`,employeeNo:String(index).padStart(5,'0'),sequence:index+1}));
    await seed(rows);
    await successfulUpload({inserted:151,skipped:0});
    expect(status()?.textContent).toBe('✓ 已上傳 151 筆・11:36');
    expect(status()?.className).toMatch(/emerald|green/);
    expect(button('重新上傳今日排程').disabled).toBe(false);
    expect(upload).toHaveBeenCalledWith(session.id,rows);
    expect(await database.getPreparedUpload(session.id)).toMatchObject({sessionId:session.id,lastUploadedAt:'2026-10-08T03:36:00.000Z',lastUploadedCount:151});
  });

  it('重新建立 RosterManager 並重新開啟 IndexedDB 後仍保留最後成功的狀態',async()=>{
    await seed();await successfulUpload();
    await remount();
    expect(status()?.textContent).toBe('✓ 已上傳 1 筆・11:36');
    expect(button('重新上傳今日排程').disabled).toBe(false);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('重新匯入不同內容後顯示待重新上傳警告，保留最後成功 metadata',async()=>{
    await seed();await successfulUpload();
    const saved=await database.getPreparedUpload(session.id);
    await importDaily([{...daily,slot:'08:00~08:30'}]);
    expect(status()?.textContent).toBe('⚠ 排程內容已變更，請重新上傳');
    expect(button('重新上傳今日排程').disabled).toBe(false);
    expect(await database.getPreparedUpload(session.id)).toMatchObject(saved!);
    await remount();
    expect(status()?.textContent).toBe('⚠ 排程內容已變更，請重新上傳');
  });

  it('內容相同的重新匯入即使 UUID 與確認旗標改變也不誤判需要重新上傳',async()=>{
    await seed();await successfulUpload();
    await importDaily([daily]);
    const imported=(await database.getPreparedSchedule(session.id))[0];
    expect(imported.localId).not.toBe(prepared.localId);
    expect(imported.confirmed).toBe(false);
    expect(status()?.textContent).toBe('✓ 已上傳 1 筆・11:36');
    expect(card()?.textContent).not.toContain('排程內容已變更');
  });

  it('重新上傳成功會清除警告並更新筆數與時間，略過既有資料仍計入本次排程筆數',async()=>{
    await seed();await successfulUpload();
    await importDaily([daily,otherDaily]);
    expect(status()?.textContent).toBe('⚠ 排程內容已變更，請重新上傳');
    vi.setSystemTime(new Date('2026-10-08T04:07:00Z'));
    await successfulUpload({inserted:0,skipped:2});
    expect(status()?.textContent).toBe('✓ 已上傳 2 筆・12:07');
    expect(card()?.textContent).not.toContain('排程內容已變更');
    expect(await database.getPreparedUpload(session.id)).toMatchObject({lastUploadedCount:2,lastUploadedAt:'2026-10-08T04:07:00.000Z'});
    await remount();
    expect(status()?.textContent).toBe('✓ 已上傳 2 筆・12:07');
  });

  it('首次上傳失敗不能建立成功狀態，原錯誤與重試行為仍保留',async()=>{
    await seed();upload.mockRejectedValueOnce({message:'雲端連線失敗'});
    await click(button('確認並上傳今日排程'));
    await until(()=>container.querySelector('[role="alert"]')!==null);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('上傳失敗：雲端連線失敗');
    expect(status()?.textContent).toBe('尚未上傳');
    expect(await database.getPreparedUpload(session.id)).toBeNull();
    expect(button('確認並上傳今日排程').disabled).toBe(false);
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('未變更內容的重新上傳失敗時保留上次成功資訊與 metadata',async()=>{
    await seed();await successfulUpload();
    const saved=await database.getPreparedUpload(session.id);
    vi.setSystemTime(new Date('2026-10-08T04:07:00Z'));
    upload.mockRejectedValueOnce(new Error('第二次上傳失敗'));
    await click(button('重新上傳今日排程'));
    await until(()=>container.querySelector('[role="alert"]')!==null);
    expect(status()?.textContent).toBe('✓ 已上傳 1 筆・11:36');
    expect(await database.getPreparedUpload(session.id)).toEqual(saved);
    expect(button('重新上傳今日排程').disabled).toBe(false);
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  it('有變更的重新上傳失敗時仍顯示警告且不覆寫成功 metadata',async()=>{
    await seed();await successfulUpload();
    await importDaily([{...daily,slot:'08:00~08:30'}]);
    const saved=await database.getPreparedUpload(session.id);
    upload.mockRejectedValueOnce(new Error('第二次上傳失敗'));
    await click(button('重新上傳今日排程'));
    await until(()=>container.querySelector('[role="alert"]')!==null);
    expect(status()?.textContent).toBe('⚠ 排程內容已變更，請重新上傳');
    expect(await database.getPreparedUpload(session.id)).toEqual(saved);
  });

  it('雲端已成功但 onUploaded 重新載入失敗時，仍保留真正完成的上傳狀態',async()=>{
    await seed();
    onUploaded.mockRejectedValueOnce(new Error('重新載入資料失敗'));
    upload.mockResolvedValueOnce({inserted:1,skipped:0});
    await click(button('確認並上傳今日排程'));
    await until(()=>container.querySelector('[role="alert"]')!==null);
    expect(status()?.textContent).toBe('✓ 已上傳 1 筆・11:36');
    expect(await database.getPreparedUpload(session.id)).toMatchObject({lastUploadedCount:1,lastUploadedAt:'2026-10-08T03:36:00.000Z'});
    expect(button('重新上傳今日排程').disabled).toBe(false);
  });

  it('雲端成功但本機 metadata 儲存失敗時，仍呈現真正成功與明確的本機儲存錯誤',async()=>{
    await seed();
    vi.spyOn(database,'savePreparedUpload').mockRejectedValueOnce(new Error('本機空間不足'));
    upload.mockResolvedValueOnce({inserted:1,skipped:0});
    await click(button('確認並上傳今日排程'));
    await until(()=>onUploaded.mock.calls.length===1);
    expect(status()?.textContent).toBe('✓ 已上傳 1 筆・11:36');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('排程已上傳，但上傳狀態無法保存在本機：本機空間不足');
    expect(await database.getPreparedUpload(session.id)).toBeNull();
    expect(button('重新上傳今日排程').disabled).toBe(false);
  });

  it('simple 即使已有上傳 metadata 也不顯示每日上傳狀態或載入該資料',async()=>{
    await database.savePreparedUpload({sessionId:session.id,lastUploadedAt:'2026-10-08T03:36:00.000Z',lastUploadedCount:1,uploadedPreparedSignature:preparedScheduleSignature([prepared])});
    const getUpload=vi.spyOn(database,'getPreparedUpload');
    await seed([prepared],{...session,workflowMode:'simple'});
    expect(card()).toBeUndefined();
    expect(container.querySelector('[role="status"]')).toBeNull();
    for(const label of ['尚未上傳','已上傳','排程內容已變更','重新上傳今日排程'])expect(container.textContent).not.toContain(label);
    expect(getUpload).not.toHaveBeenCalled();expect(upload).not.toHaveBeenCalled();
  });

  it('切換場次只顯示對應場次的成功筆數與時間，未上傳場次不沿用先前狀態',async()=>{
    await seed();await successfulUpload();
    const second={...session,id:'upload-status-second'};
    await database.replacePreparedSchedule(second.id,[{...prepared,localId:'upload-status-second-row'}]);
    await mount(second);
    await until(()=>status()?.textContent==='尚未上傳');
    expect(button('確認並上傳今日排程').disabled).toBe(false);
    await mount(session);
    await until(()=>status()?.textContent==='✓ 已上傳 1 筆・11:36');
    expect(button('重新上傳今日排程').disabled).toBe(false);
  });

  it('直接修改整理後排程會標示需要重新上傳，且重新整理後仍能判斷變更',async()=>{
    await seed();await successfulUpload();
    await input(container.querySelector<HTMLInputElement>('input[aria-label="王小明 時段"]')!,'08:00~08:30');
    expect(status()?.textContent).toBe('⚠ 排程內容已變更，請重新上傳');
    await until(()=>container.querySelector<HTMLInputElement>('input[aria-label="王小明 時段"]')?.value==='08:00~08:30');
    expect((await database.getPreparedSchedule(session.id))[0].slot).toBe('08:00~08:30');
    await remount();
    expect(status()?.textContent).toBe('⚠ 排程內容已變更，請重新上傳');
  });

  it('移除整理後人員會標示需要重新上傳，即使排程已經清空',async()=>{
    await seed();await successfulUpload();
    await click(button('移除'));
    expect(status()?.textContent).toBe('⚠ 排程內容已變更，請重新上傳');
    expect(button('重新上傳今日排程').disabled).toBe(true);
    expect(await database.getPreparedUpload(session.id)).not.toBeNull();
  });

  it('從大名單新增整理後人員會標示需要重新上傳',async()=>{
    await seed();await successfulUpload();
    await click(button('從大名單新增'));
    const choice=Array.from(container.querySelectorAll('button')).find(element=>element.textContent?.includes('陳小華・00126'))!;
    await click(choice);
    await click(button('加入今日整理後排程'));
    await until(()=>container.querySelectorAll('tbody tr').length===2);
    expect(status()?.textContent).toBe('⚠ 排程內容已變更，請重新上傳');
    expect(button('重新上傳今日排程').disabled).toBe(false);
  });

  it('新增待確認資料即使可用排程相同也要顯示警告，修改待確認欄位仍保留警告',async()=>{
    await seed();await successfulUpload();
    await importDaily([daily,{...daily,sourceRow:3,employeeNo:'00999',name:'未比對人員'}]);
    expect(container.textContent).toContain('待確認資料');
    expect(status()?.textContent).toBe('⚠ 排程內容已變更，請重新上傳');
    const issueSection=Array.from(container.querySelectorAll('h3')).find(element=>element.textContent==='待確認資料')!.closest('section')!;
    const nameInput=Array.from(issueSection.querySelectorAll('label')).find(label=>label.textContent==='姓名')!.querySelector('input')!;
    await input(nameInput,'修正人員');
    expect(status()?.textContent).toBe('⚠ 排程內容已變更，請重新上傳');
    expect(button('重新上傳今日排程').disabled).toBe(true);
    expect(preparedScheduleSignature(await database.getPreparedSchedule(session.id))).toBe(preparedScheduleSignature([prepared]));
    expect((await database.getPreparedUpload(session.id))?.hasPendingChanges).toBe(true);
    await remount();
    expect(status()?.textContent).toBe('⚠ 排程內容已變更，請重新上傳');
    expect(container.textContent).not.toContain('待確認資料');
    await successfulUpload({inserted:0,skipped:1});
    expect(status()?.textContent).toBe('✓ 已上傳 1 筆・11:36');
    expect((await database.getPreparedUpload(session.id))?.hasPendingChanges).toBeUndefined();
  });

  it('有待確認資料後重新匯入乾淨且相同的內容，可清除待確認變更標記',async()=>{
    await seed();await successfulUpload();
    await importDaily([daily,{...daily,sourceRow:3,employeeNo:'00999',name:'未比對人員'}]);
    expect(status()?.textContent).toBe('⚠ 排程內容已變更，請重新上傳');
    await importDaily([daily]);
    expect(status()?.textContent).toBe('✓ 已上傳 1 筆・11:36');
    expect((await database.getPreparedUpload(session.id))?.hasPendingChanges).not.toBe(true);
    await remount();
    expect(status()?.textContent).toBe('✓ 已上傳 1 筆・11:36');
  });

  it('上傳期間修改排程時只保存送出那一版的 signature，完成後仍提示重新上傳',async()=>{
    await seed();
    let finish!:(result:ImportResult)=>void;
    upload.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
    await click(button('確認並上傳今日排程'));
    expect(status()?.textContent).toBe('尚未上傳');
    expect(await database.getPreparedUpload(session.id)).toBeNull();
    await input(container.querySelector<HTMLInputElement>('input[aria-label="王小明 時段"]')!,'08:00~08:30');
    await act(async()=>{finish({inserted:1,skipped:0});});
    await until(()=>onUploaded.mock.calls.length===1);
    expect(upload).toHaveBeenCalledWith(session.id,[prepared]);
    expect((await database.getPreparedUpload(session.id))?.uploadedPreparedSignature).toBe(preparedScheduleSignature([prepared]));
    expect(status()?.textContent).toBe('⚠ 排程內容已變更，請重新上傳');
    expect(button('重新上傳今日排程').disabled).toBe(false);
  });

  it('上傳中切換並重建另一場次時，晚到的成功結果只保存在原場次',async()=>{
    await seed();
    let finish!:(result:ImportResult)=>void;
    upload.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
    await click(button('確認並上傳今日排程'));
    const second={...session,id:'upload-status-inflight-other'};
    await database.replacePreparedSchedule(second.id,[{...prepared,localId:'upload-status-inflight-other-row'}]);
    await remount(second);
    await act(async()=>{finish({inserted:1,skipped:0});});
    await until(()=>upload.mock.calls.length===1&&status()?.textContent==='尚未上傳');
    // Await the persisted fact rather than expecting the unmounted component to notify the new one.
    for(let attempt=0;attempt<100&&!await database.getPreparedUpload(session.id);attempt++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
    expect(await database.getPreparedUpload(session.id)).toMatchObject({lastUploadedCount:1});
    expect(await database.getPreparedUpload(second.id)).toBeNull();
    expect(status()?.textContent).toBe('尚未上傳');
    expect(button('確認並上傳今日排程').disabled).toBe(false);
    expect(onUploaded).not.toHaveBeenCalled();
    await remount();
    expect(status()?.textContent).toBe('✓ 已上傳 1 筆・11:36');
  });
});
