import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {RosterManager} from '../features/roster/RosterManager';
import * as database from '../features/roster/db';
import {exportPreparedRoster,readDailyFile} from '../features/roster/excel';
import {uploadPreparedSchedule} from '../features/schedule/service';
import type {DailySchedulePerson,MasterPerson,PreparedPerson} from '../features/roster/types';
import type {ImportResult,Session} from '../types';

vi.mock('../features/roster/excel',async importOriginal=>({...await importOriginal<typeof import('../features/roster/excel')>(),readDailyFile:vi.fn(),exportPreparedRoster:vi.fn()}));
vi.mock('../features/schedule/service',()=>({uploadPreparedSchedule:vi.fn()}));

const session:Session={id:'roster-actions-session',companyName:'ITRI',sessionDate:'2026-10-08',status:'active',workflowMode:'standard'};
const person:MasterPerson={companyName:'ITRI',companyKey:'ITRI',employeeNo:'00125',name:'王小明',nationalId:'A123456789',gender:'男',originalActivity:'一般健檢',item:'一般',extension:'1234',updatedAt:'2026-10-01T00:00:00Z'};
const prepared:PreparedPerson={localId:'prepared-actions-person',sequence:1,employeeNo:person.employeeNo,name:person.name,gender:person.gender,scheduleDate:session.sessionDate,slot:'07:30~08:00',item:person.item,extension:person.extension,nationalId:person.nationalId,originalActivity:person.originalActivity,dailyActivity:person.originalActivity,issues:[],confirmed:true};
const daily:DailySchedulePerson={sourceRow:2,employeeNo:person.employeeNo,name:person.name,scheduleDate:session.sessionDate,slot:prepared.slot,activity:person.originalActivity,extension:person.extension};
const download=vi.mocked(exportPreparedRoster);
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
  throw new Error('畫面未在預期時間更新。');
}
const buttons=(label:string)=>Array.from(container.querySelectorAll('button')).filter(element=>element.textContent===label);
const button=(label:string)=>{const element=buttons(label)[0];if(!element)throw new Error(`找不到按鈕：${label}`);return element;};
const dailyCard=()=>Array.from(container.querySelectorAll('h3')).find(element=>element.textContent==='2. 廠商提供資料（每日排程）')?.closest('section');
async function click(element:HTMLElement){await act(async()=>{element.click();});}
async function render(rows:PreparedPerson[]=[],current:Session=session){
  await database.replacePreparedSchedule(session.id,rows);
  await act(async()=>{root.render(<RosterManager current={current} participants={[]} onUploaded={onUploaded} setNotice={notices}/>);});
  await until(()=>container.textContent?.includes('已匯入 1 筆')??false);
}
async function importDaily(rows:DailySchedulePerson[]){
  dailyReader.mockResolvedValueOnce(rows);
  const input=dailyCard()!.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input,'files',{value:[new File(['excel'],'daily.xlsx')],configurable:true});
  await act(async()=>{input.dispatchEvent(new Event('change',{bubbles:true}));});
  await until(()=>notices.mock.calls.length>0);
}

describe('標準模式每日排程卡片操作',()=>{
  beforeEach(async()=>{
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;
    await database.rosterDb.open();
    await database.rosterDb.masterPeople.clear();
    await database.rosterDb.companySettings.clear();
    await database.rosterDb.preparedPeople.clear();
    await database.replaceCompanyMaster(session.companyName,[person]);
    dailyReader.mockReset();download.mockReset();upload.mockReset();
    notices=vi.fn();onUploaded=vi.fn().mockResolvedValue(undefined);
    vi.spyOn(window,'confirm').mockReturnValue(true);
    container=document.createElement('div');document.body.append(container);root=createRoot(container);
  });
  afterEach(async()=>{await act(async()=>{root.unmount();});container.remove();vi.restoreAllMocks();actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;});

  it('僅有一組匯出與上傳操作，放在每日匯入卡片底部並保留響應式排列及個資提示',async()=>{
    await render();
    const card=dailyCard()!;
    const exportButton=button('匯出整理後 Excel');
    const uploadButton=button('確認並上傳今日排程');
    expect(buttons('匯出整理後 Excel')).toHaveLength(1);
    expect(buttons('確認並上傳今日排程')).toHaveLength(1);
    expect(exportButton.closest('section')).toBe(card);
    expect(uploadButton.closest('section')).toBe(card);
    expect(exportButton.parentElement).toBe(uploadButton.parentElement);
    const actionGrid=exportButton.parentElement!;
    for(const className of ['grid','grid-cols-1','sm:grid-cols-2','gap-3'])expect(actionGrid.classList.contains(className)).toBe(true);
    expect(Array.from(actionGrid.children)).toEqual([exportButton,uploadButton]);
    expect(exportButton.classList.contains('secondary')).toBe(true);
    expect(uploadButton.classList.contains('primary')).toBe(true);
    const fileInput=card.querySelector('input[type="file"]')!;
    expect(fileInput.compareDocumentPosition(exportButton)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.textContent).toContain('包含完整身分證');
    expect(card.textContent).toContain('不包含身分證');
    expect(card.textContent).toContain('完整大名單也不會上傳');
    expect(container.textContent).not.toContain('預覽完成，下載 Excel');
    expect(container.textContent).not.toContain('確認並上傳（不含身分證）');
  });

  it('尚無整理後排程時兩鍵皆禁用，不產生檔案或送出雲端上傳',async()=>{
    await render();
    expect(button('匯出整理後 Excel').disabled).toBe(true);
    expect(button('確認並上傳今日排程').disabled).toBe(true);
    await click(button('匯出整理後 Excel'));
    await click(button('確認並上傳今日排程'));
    expect(download).not.toHaveBeenCalled();expect(upload).not.toHaveBeenCalled();expect(window.confirm).not.toHaveBeenCalled();
  });

  it('即使已有可用排程，只要匯入後還有待確認資料，兩鍵仍沿用未完成禁用條件',async()=>{
    await render([prepared]);
    expect(button('確認並上傳今日排程').disabled).toBe(false);
    await importDaily([daily,{...daily,sourceRow:3,employeeNo:'00999',name:'未比對人員'}]);
    expect(container.textContent).toContain('待確認資料');
    expect(container.textContent).toContain('已匯入 2 筆');
    expect(await database.getPreparedSchedule(session.id)).toHaveLength(1);
    expect(button('匯出整理後 Excel').disabled).toBe(true);
    expect(button('確認並上傳今日排程').disabled).toBe(true);
    await click(button('確認並上傳今日排程'));
    expect(upload).not.toHaveBeenCalled();
    expect(notices).toHaveBeenCalledWith('每日排程已整理並保存在本機：可用 1 筆，待確認 1 筆。');
  });

  it('整理完成後啟用兩鍵，只有主動匯出才把原完整排程傳給既有 Excel function',async()=>{
    await render([prepared]);
    expect(button('匯出整理後 Excel').disabled).toBe(false);
    expect(button('確認並上傳今日排程').disabled).toBe(false);
    expect(download).not.toHaveBeenCalled();
    await click(button('匯出整理後 Excel'));
    await until(()=>download.mock.calls.length===1);
    expect(download).toHaveBeenCalledWith([prepared],session.companyName,session.sessionDate);
    expect(download.mock.calls[0][0][0].nationalId).toBe(person.nationalId);
    expect(upload).not.toHaveBeenCalled();
  });

  it('上傳沿用既有確認與 service，取消不送出，處理中禁止重複上傳且完成後顯示原通知',async()=>{
    await render([prepared]);
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await click(button('確認並上傳今日排程'));
    expect(upload).not.toHaveBeenCalled();
    let finish!:(result:ImportResult)=>void;
    upload.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
    await click(button('確認並上傳今日排程'));
    expect(window.confirm).toHaveBeenCalledWith('此版本將上傳至雲端，但不包含身分證。確定繼續？');
    expect(upload).toHaveBeenCalledWith(session.id,[prepared]);
    expect(button('確認並上傳今日排程').disabled).toBe(true);
    expect(button('匯出整理後 Excel').disabled).toBe(false);
    await click(button('確認並上傳今日排程'));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(onUploaded).not.toHaveBeenCalled();
    await act(async()=>{finish({inserted:1,skipped:2});});
    await until(()=>onUploaded.mock.calls.length===1);
    expect(onUploaded).toHaveBeenCalledWith('上傳成功：新增 1 筆，略過既有資料 2 筆（未上傳身分證）。');
    expect(button('確認並上傳今日排程').disabled).toBe(false);
    expect(await database.getPreparedSchedule(session.id)).toEqual([prepared]);
  });

  it('匯出失敗仍顯示原可讀錯誤，保留排程並允許重試',async()=>{
    await render([prepared]);
    download.mockImplementationOnce(()=>{throw new Error('檔案產生失敗');});
    await click(button('匯出整理後 Excel'));
    await until(()=>container.querySelector('[role="alert"]')!==null);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('檔案產生失敗');
    expect(await database.getPreparedSchedule(session.id)).toEqual([prepared]);
    expect(button('匯出整理後 Excel').disabled).toBe(false);
    await click(button('匯出整理後 Excel'));
    await until(()=>download.mock.calls.length===2);
  });

  it('上傳失敗仍保留原錯誤前綴與排程，解除 busy 後可重試',async()=>{
    await render([prepared]);
    upload.mockRejectedValueOnce({message:'權限驗證失敗'});
    await click(button('確認並上傳今日排程'));
    await until(()=>container.querySelector('[role="alert"]')!==null);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('上傳失敗：權限驗證失敗');
    expect(onUploaded).not.toHaveBeenCalled();
    expect(button('確認並上傳今日排程').disabled).toBe(false);
    expect(await database.getPreparedSchedule(session.id)).toEqual([prepared]);
    upload.mockResolvedValueOnce({inserted:0,skipped:1});
    await click(button('確認並上傳今日排程'));
    expect(upload).toHaveBeenCalledTimes(2);
    expect(onUploaded).toHaveBeenCalledWith('上傳成功：新增 0 筆，略過既有資料 1 筆（未上傳身分證）。');
  });

  it('simple 完全不出現每日匯入卡片或匯出／上傳操作，亦不載入整理後排程',async()=>{
    const getPrepared=vi.spyOn(database,'getPreparedSchedule');
    await render([prepared],{...session,workflowMode:'simple'});
    expect(container.textContent).toContain('公司大名單管理');
    expect(dailyCard()).toBeUndefined();
    expect(buttons('匯出整理後 Excel')).toHaveLength(0);
    expect(buttons('確認並上傳今日排程')).toHaveLength(0);
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(getPrepared).not.toHaveBeenCalled();expect(download).not.toHaveBeenCalled();expect(upload).not.toHaveBeenCalled();
  });
});
