import {beforeEach,describe,expect,it} from 'vitest';
import * as XLSX from 'xlsx';
import {DEFAULT_MANUAL_ITEM} from '../features/checkin/manual';
import {isCompanyMasterLocked,mergeCompanyMaster,rosterDb,setCompanyMasterLocked} from '../features/roster/db';
import {readMasterFile} from '../features/roster/excel';
import {assertCompleteImportedPeople} from '../features/roster/masterImport';
import {ensureCompanyMasterPerson,lookupCompanyMaster,validateManualMasterPerson} from '../features/roster/lookup';
import type {MasterPerson} from '../features/roster/types';

const person=(patch:Partial<MasterPerson>={}):MasterPerson=>({companyName:'ITRI',companyKey:'ITRI',employeeNo:'00125',name:'王小明',nationalId:'A123456789',gender:'',originalActivity:'',item:'',extension:'',updatedAt:'2026-01-01T00:00:00Z',...patch});
const columns=['工號','姓名','身分證','性別','活動項目(原始)','項目','院內分機'];
const fileFromRows=(row:string[],format:'xlsx'|'csv'):File=>{
  const workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([columns,row]),'公司大名單');
  const bytes=XLSX.write(workbook,{type:'array',bookType:format}) as ArrayBuffer;
  return{arrayBuffer:async()=>bytes} as File;
};

describe('人工新增大名單與正式匯入使用不同驗證',()=>{
  beforeEach(async()=>{await rosterDb.open();await rosterDb.masterPeople.clear();await rosterDb.companySettings.clear();});

  it('性別與分機可留白、空項目自動一般，鎖定大名單仍可單筆加入且不改鎖定資料',async()=>{
    await setCompanyMasterLocked('ITRI',true);
    const settings=await rosterDb.companySettings.get('ITRI');
    const source=person({companyName:' Ｉｔｒｉ ',companyKey:'WRONG',employeeNo:' 00125 ',name:' 王小明 ',nationalId:' a123456789 ',gender:'　 ',item:'　 ',extension:'　 ',originalActivity:'　 '});
    const before=structuredClone(source);
    const added=await ensureCompanyMasterPerson(source);
    expect(added).toMatchObject({companyName:'Ｉｔｒｉ',companyKey:'ITRI',employeeNo:'00125',name:'王小明',nationalId:'A123456789',gender:'',extension:'',item:DEFAULT_MANUAL_ITEM,originalActivity:DEFAULT_MANUAL_ITEM});
    expect(await lookupCompanyMaster(' itri ',{nationalId:'a123456789'})).toEqual(added);
    expect(await lookupCompanyMaster('ITRI',{employeeNo:'00125'})).toEqual(added);
    expect(await lookupCompanyMaster('ITRI',{employeeNo:'125'})).toBeNull();
    expect(await rosterDb.companySettings.get('ITRI')).toEqual(settings);
    expect(await isCompanyMasterLocked('itri')).toBe(true);
    expect(source).toEqual(before);
  });

  it('人工自訂項目與既有原始活動保留，不強制換成一般',()=>{
    expect(validateManualMasterPerson(person({item:' 心血管方案 ',originalActivity:' ' }))).toMatchObject({item:'心血管方案',originalActivity:'心血管方案'});
    expect(validateManualMasterPerson(person({item:' 特殊 ',originalActivity:' 既有活動 '}))).toMatchObject({item:'特殊',originalActivity:'既有活動'});
  });

  it.each([
    [{name:'　 '},'請輸入姓名。'],
    [{employeeNo:'　 '},'請輸入工號。'],
    [{nationalId:'　 '},'請確認完整且格式正確的身分證。'],
    [{nationalId:'A123'},'請確認完整且格式正確的身分證。'],
  ] as const)('人工新增缺少必要身分欄位時顯示明確錯誤且不寫入',async(patch,message)=>{
    await setCompanyMasterLocked('ITRI',true);const settings=await rosterDb.companySettings.get('ITRI');
    await expect(ensureCompanyMasterPerson(person(patch))).rejects.toThrow(message);
    expect(await rosterDb.masterPeople.count()).toBe(0);
    expect(await rosterDb.companySettings.get('ITRI')).toEqual(settings);
  });

  it.each(['xlsx','csv'] as const)('正式 %s 匯入仍拒絕性別空白，完整人員與鎖定資料不受影響',async format=>{
    await setCompanyMasterLocked('ITRI',true);
    const existing=await ensureCompanyMasterPerson(person({gender:'男',item:'一般',originalActivity:'一般健檢'}));
    const settings=await rosterDb.companySettings.get('ITRI');
    await expect(readMasterFile(fileFromRows(['00125','王小明','A123456789','','一般健檢','一般',''],format),'ITRI')).rejects.toThrow('缺少：性別');
    expect(await lookupCompanyMaster('ITRI',{employeeNo:'00125'})).toEqual(existing);
    expect(await rosterDb.companySettings.get('ITRI')).toEqual(settings);
  });

  it('正式 assertCompleteImportedPeople 與增量更新仍拒絕人工空性別資料，不修改原人員及鎖定',async()=>{
    await setCompanyMasterLocked('ITRI',true);
    const existing=await ensureCompanyMasterPerson(person());
    const settings=await rosterDb.companySettings.get('ITRI');
    expect(()=>assertCompleteImportedPeople([existing])).toThrow('缺少：性別');
    await expect(mergeCompanyMaster('ITRI',[{...existing,gender:'　 '}])).rejects.toThrow('缺少：性別');
    expect(await lookupCompanyMaster('ITRI',{nationalId:'A123456789'})).toEqual(existing);
    expect(await rosterDb.companySettings.get('ITRI')).toEqual(settings);
  });

  it('正式增量 CSV 可補人工空性別，保留主鍵、前導零、身分證索引、未更新人員與其他公司',async()=>{
    await setCompanyMasterLocked('ITRI',true);
    const added=await ensureCompanyMasterPerson(person({extension:'1234'}));
    const numericEmployee=await ensureCompanyMasterPerson(person({employeeNo:'125',nationalId:'B234567890',name:'另一人',item:'另一方案'}));
    await setCompanyMasterLocked('另一公司',false);
    const other=await ensureCompanyMasterPerson(person({companyName:'另一公司',employeeNo:'00125',name:'其他公司人員'}));
    const otherSettings=await rosterDb.companySettings.get('另一公司');
    const incoming=await readMasterFile(fileFromRows(['00125','王小明','a123456789','男','正式活動','正式方案',''],'csv'),' Ｉｔｒｉ ');
    expect(incoming[0]).toMatchObject({employeeNo:'00125',nationalId:'A123456789',gender:'男',companyKey:'ITRI'});
    expect(await mergeCompanyMaster('itri',incoming)).toEqual({inserted:0,updated:1,retained:1,total:2});
    const updated=await lookupCompanyMaster(' ＩＴＲＩ ',{nationalId:'a123456789'});
    expect(updated).toMatchObject({id:added.id,employeeNo:'00125',companyKey:'ITRI',gender:'男',item:'正式方案',originalActivity:'正式活動',extension:'1234'});
    expect(await lookupCompanyMaster('ITRI',{employeeNo:'00125'})).toEqual(updated);
    expect(await lookupCompanyMaster('ITRI',{employeeNo:'125'})).toEqual(numericEmployee);
    expect(await lookupCompanyMaster('另一公司',{employeeNo:'00125'})).toEqual(other);
    expect(await rosterDb.companySettings.get('另一公司')).toEqual(otherSettings);
    expect(await isCompanyMasterLocked('ITRI')).toBe(true);
    expect(await rosterDb.masterPeople.count()).toBe(3);
  });
});
