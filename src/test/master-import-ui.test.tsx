import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {RosterManager} from '../features/roster/RosterManager';
import * as database from '../features/roster/db';
import {readMasterFile} from '../features/roster/excel';
import type {MasterPerson} from '../features/roster/types';
import type {Session} from '../types';

vi.mock('../features/roster/excel',async importOriginal=>({...await importOriginal<typeof import('../features/roster/excel')>(),readMasterFile:vi.fn()}));

const session:Session={id:'master-import-session',companyName:'ITRI',sessionDate:'2026-10-06',status:'active'};
const person=(employeeNo:string,patch:Partial<MasterPerson>={}):MasterPerson=>({companyName:'ITRI',companyKey:'ITRI',employeeNo,name:`人員 ${employeeNo}`,nationalId:'A123456789',gender:'男',item:'一般',originalActivity:'一般健檢',extension:'1234',updatedAt:'2026-10-01T00:00:00Z',...patch});
const oldMaster=[person('A001'),person('A002'),person('A003')];
const upload=vi.mocked(readMasterFile);
let root:Root;
let container:HTMLDivElement;
let notices:ReturnType<typeof vi.fn>;
const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};

async function until(condition:()=>boolean){
  for(let attempt=0;attempt<100;attempt++){
    if(condition())return;
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
  }
  throw new Error('畫面未在預期時間更新。');
}
const button=(label:string)=>{const result=Array.from(container.querySelectorAll('button')).find(element=>element.textContent===label);if(!result)throw new Error(`找不到按鈕：${label}`);return result;};
async function click(element:HTMLElement){await act(async()=>{element.click();});}
async function render(existing:MasterPerson[]=[],locked=false){
  if(existing.length){await database.replaceCompanyMaster(session.companyName,existing);await database.setCompanyMasterLocked(session.companyName,locked);}
  const loaded=vi.spyOn(database,'getCompanyMasterLockState');
  await act(async()=>{root.render(<RosterManager current={session} participants={[]} onUploaded={async()=>{}} setNotice={notices}/>);});
  await until(()=>loaded.mock.results[0]?.type==='return');
  await act(async()=>{await loaded.mock.results[0].value;await database.getCompanyMaster(session.companyName);});
  if(existing.length)await until(()=>container.textContent?.includes(`已匯入 ${existing.length} 筆`)??false);
}
async function selectFile(rows:MasterPerson[]){
  upload.mockResolvedValueOnce(rows);
  const input=container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input,'files',{value:[new File(['excel'],'master.xlsx')],configurable:true});
  await act(async()=>{input.dispatchEvent(new Event('change',{bubbles:true}));});
  await until(()=>upload.mock.calls.length>0&&(container.querySelector('[role="dialog"]')!==null||input.disabled));
}
const modal=()=>container.querySelector<HTMLElement>('[role="dialog"]');
const summary=(label:string)=>Array.from(modal()!.querySelectorAll('dt')).find(term=>term.textContent===label)?.nextElementSibling?.textContent;

describe('公司大名單更新操作',()=>{
  beforeEach(async()=>{
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;
    await database.rosterDb.open();
    await database.rosterDb.masterPeople.clear();
    await database.rosterDb.companySettings.clear();
    await database.rosterDb.preparedPeople.clear();
    upload.mockReset();
    notices=vi.fn();
    container=document.createElement('div');
    document.body.append(container);
    root=createRoot(container);
  });
  afterEach(async()=>{await act(async()=>{root.unmount();});container.remove();vi.restoreAllMocks();actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;});

  it('第一次匯入直接保存並鎖定，不詢問更新方式',async()=>{
    await render();
    await selectFile([person('A004')]);
    await until(()=>notices.mock.calls.length===1);
    expect(modal()).toBeNull();
    expect((await database.getCompanyMaster(' itri ')).map(row=>row.employeeNo)).toEqual(['A004']);
    expect(await database.isCompanyMasterLocked('ＩＴＲＩ')).toBe(true);
    expect(container.textContent).toContain('大名單已鎖定');
  });

  it('預設增量更新並顯示統計；預覽與取消完整保留原資料',async()=>{
    await render(oldMaster);
    const before=await database.getCompanyMaster('ITRI');
    await selectFile([person('A002',{name:'更新姓名'}),person('A004')]);
    expect(modal()?.textContent).toContain('如何更新公司大名單？');
    expect(modal()?.querySelector<HTMLInputElement>('input[value="merge"]')?.checked).toBe(true);
    expect(summary('目前大名單')).toBe('3 人');
    expect(summary('本次 Excel')).toBe('2 人');
    expect(summary('新增')).toBe('1 人');
    expect(summary('更新')).toBe('1 人');
    expect(summary('保留既有人員')).toBe('2 人');
    expect(summary('更新後預估總數')).toBe('4 人');
    expect(await database.getCompanyMaster('ITRI')).toEqual(before);
    await click(button('取消'));
    expect(modal()).toBeNull();
    expect(await database.getCompanyMaster('ITRI')).toEqual(before);
    expect(await database.isCompanyMasterLocked('ITRI')).toBe(false);
    expect(notices).not.toHaveBeenCalled();
  });

  it('增量更新保留未列入人員，刷新畫面並自動重新鎖定',async()=>{
    await render(oldMaster);
    await selectFile([person('A002',{name:'更新姓名'}),person('A004')]);
    await click(button('確認增量更新'));
    await until(()=>modal()===null);
    const rows=await database.getCompanyMaster('ITRI');
    expect(rows.map(row=>row.employeeNo)).toEqual(['A001','A002','A003','A004']);
    expect(rows.find(row=>row.employeeNo==='A002')?.name).toBe('更新姓名');
    expect(await database.isCompanyMasterLocked('ITRI')).toBe(true);
    expect(container.textContent).toContain('已匯入 4 筆');
    expect(notices).toHaveBeenCalledWith('大名單增量更新完成：新增 1 人、更新 1 人，目前共 4 人。');
  });

  it('整份取代需勾選明確警告確認，才可刪除未列入人員',async()=>{
    await render(oldMaster);
    await selectFile([person('A004')]);
    await click(modal()!.querySelector<HTMLInputElement>('input[value="replace"]')!);
    expect(modal()?.textContent).toContain('整份取代會刪除目前大名單中未出現在新 Excel 的人員。');
    expect(modal()?.textContent).toContain('整份取代後：1 人');
    expect(button('確認整份取代').disabled).toBe(true);
    await click(button('確認整份取代'));
    expect((await database.getCompanyMaster('ITRI'))).toHaveLength(3);
    await click(modal()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await click(button('確認整份取代'));
    await until(()=>modal()===null);
    expect((await database.getCompanyMaster('ITRI')).map(row=>row.employeeNo)).toEqual(['A004']);
    expect(await database.isCompanyMasterLocked('ITRI')).toBe(true);
    expect(notices).toHaveBeenCalledWith('公司大名單已完整取代，目前共 1 人。');
  });

  it('檔案驗證失敗時顯示原因，不開啟預覽或修改資料',async()=>{
    await render(oldMaster);
    const before=await database.getCompanyMaster('ITRI');
    upload.mockRejectedValueOnce(new Error('本次匯入檔案有重複工號：A004，請確認檔案後重新匯入。'));
    const input=container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input,'files',{value:[new File(['excel'],'duplicate.xlsx')]});
    await act(async()=>{input.dispatchEvent(new Event('change',{bubbles:true}));});
    await until(()=>container.querySelector('[role="alert"]')!==null);
    expect(modal()).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('本次匯入檔案有重複工號：A004');
    expect(await database.getCompanyMaster('ITRI')).toEqual(before);
    expect(input.disabled).toBe(false);
  });

  it('寫入失敗保留可重試的預覽並顯示可讀錯誤',async()=>{
    await render(oldMaster);
    await selectFile([person('A004')]);
    vi.spyOn(database,'mergeCompanyMaster').mockRejectedValueOnce({message:'儲存空間不足'});
    await click(button('確認增量更新'));
    await until(()=>modal()?.querySelector('[role="alert"]')!==null);
    expect(modal()?.textContent).toContain('大名單更新失敗：儲存空間不足');
    expect(modal()?.textContent).not.toContain('[object Object]');
    expect(button('確認增量更新').disabled).toBe(false);
    expect(await database.isCompanyMasterLocked('ITRI')).toBe(false);
    expect(await database.getCompanyMaster('ITRI')).toHaveLength(3);
    await click(button('確認增量更新'));
    await until(()=>modal()===null);
    expect(await database.getCompanyMaster('ITRI')).toHaveLength(4);
    expect(await database.isCompanyMasterLocked('ITRI')).toBe(true);
  });

  it('處理中防止連點及取消，僅送出一次更新',async()=>{
    await render(oldMaster);
    await selectFile([person('A004')]);
    const original=database.mergeCompanyMaster;
    let finish!:()=>void;
    const pending=new Promise<void>(resolve=>{finish=resolve;});
    const merge=vi.spyOn(database,'mergeCompanyMaster').mockImplementation(async(...arguments_)=>{await pending;return original(...arguments_);});
    const submit=button('確認增量更新');
    await act(async()=>{submit.click();submit.click();});
    expect(merge).toHaveBeenCalledTimes(1);
    expect(button('處理中……').disabled).toBe(true);
    expect(button('取消').disabled).toBe(true);
    expect(modal()?.querySelector<HTMLButtonElement>('[aria-label="關閉"]')?.disabled).toBe(true);
    expect(await database.getCompanyMaster('ITRI')).toHaveLength(3);
    await act(async()=>{finish();});
    await until(()=>modal()===null);
    expect(await database.getCompanyMaster('ITRI')).toHaveLength(4);
    expect(notices).toHaveBeenCalledTimes(1);
  });
});
