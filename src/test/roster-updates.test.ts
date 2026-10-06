import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import * as XLSX from 'xlsx';
import {getCompanyMaster,isCompanyMasterLocked,mergeCompanyMaster,replaceCompanyMaster,rosterDb,setCompanyMasterLocked} from '../features/roster/db';
import {parseMasterRows,readMasterFile} from '../features/roster/excel';
import {previewCompanyMasterUpdate} from '../features/roster/masterImport';
import type {MasterPerson} from '../features/roster/types';

const master=(employeeNo:string,patch:Partial<MasterPerson>={}):MasterPerson=>({companyName:'ITRI',companyKey:'ITRI',employeeNo,name:`人員 ${employeeNo}`,nationalId:'A123456789',gender:'男',originalActivity:'一般健檢',item:'一般',extension:'1234',updatedAt:'2026-01-01T00:00:00Z',...patch});
const excelRow=(employeeNo:string,patch:Record<string,unknown>={})=>({工號:employeeNo,姓名:`人員 ${employeeNo}`,身分證:'A123456789',性別:'男','活動項目(原始)':'一般健檢',項目:'一般',院內分機:'1234',...patch});

describe('公司大名單更新',()=>{
  beforeEach(async()=>{await rosterDb.open();await rosterDb.masterPeople.clear();await rosterDb.companySettings.clear();});
  afterEach(()=>vi.restoreAllMocks());

  it('增量更新精確工號，保留缺席舊人員、ID 與空白選填欄位',async()=>{
    await replaceCompanyMaster('ITRI',[master('A001'),master('A002'),master('A003')]);
    const before=await getCompanyMaster('ITRI');
    const incoming=[master('A002',{name:'異動姓名',nationalId:' b234567890 ',gender:'女',originalActivity:'特殊健檢',item:'特殊',extension:'',companyName:'錯誤公司',companyKey:'WRONG',id:999}),master('A004')];
    expect(previewCompanyMasterUpdate(before,incoming)).toEqual({inserted:1,updated:1,retained:2,total:4});
    expect(await mergeCompanyMaster(' Itri ',incoming)).toEqual({inserted:1,updated:1,retained:2,total:4});
    const after=await getCompanyMaster('ＩＴＲＩ');
    expect(after.map(row=>row.employeeNo).sort()).toEqual(['A001','A002','A003','A004']);
    expect(after.find(row=>row.employeeNo==='A001')).toEqual(before.find(row=>row.employeeNo==='A001'));
    expect(after.find(row=>row.employeeNo==='A003')).toEqual(before.find(row=>row.employeeNo==='A003'));
    const changed=after.find(row=>row.employeeNo==='A002');
    expect(changed).toMatchObject({id:before.find(row=>row.employeeNo==='A002')?.id,name:'異動姓名',nationalId:'B234567890',gender:'女',originalActivity:'特殊健檢',item:'特殊',extension:'1234',companyName:' Itri ',companyKey:'ITRI'});
    expect(changed?.updatedAt).not.toBe('2026-01-01T00:00:00Z');
    expect(after.find(row=>row.employeeNo==='A004')?.id).not.toBe(999);
    expect(await isCompanyMasterLocked('itri')).toBe(true);
  });

  it('只有新增人員的增量檔案保留全部原名單與其他公司資料',async()=>{
    await replaceCompanyMaster('ITRI',[master('A001'),master('A002'),master('A003')]);
    await replaceCompanyMaster('另一公司',[master('A004')]);
    const other=await getCompanyMaster('另一公司');
    expect(await mergeCompanyMaster('itri',[master('A004')])).toEqual({inserted:1,updated:0,retained:3,total:4});
    expect(await getCompanyMaster('ITRI')).toHaveLength(4);
    expect(await getCompanyMaster('另一公司')).toEqual(other);
  });

  it('整份取代可以只留下新檔案，且公司欄位由目前公司決定',async()=>{
    await replaceCompanyMaster('ITRI',[master('A001'),master('A002'),master('A003')]);
    await setCompanyMasterLocked('ITRI',false);
    await replaceCompanyMaster('itri',[master('A004',{companyName:'別家公司',companyKey:'WRONG'})]);
    expect(await getCompanyMaster('ITRI')).toEqual([expect.objectContaining({employeeNo:'A004',companyName:'itri',companyKey:'ITRI'})]);
    expect(await isCompanyMasterLocked('ITRI')).toBe(true);
  });

  it('只解析及預覽後取消時，名單與解鎖狀態均不變',async()=>{
    await replaceCompanyMaster('ITRI',[master('A001')]);
    await setCompanyMasterLocked('ITRI',false);
    const before=await getCompanyMaster('ITRI');
    const setting=await rosterDb.companySettings.get('ITRI');
    const incoming=parseMasterRows([excelRow('A004')],'ITRI');
    expect(previewCompanyMasterUpdate(before,incoming)).toEqual({inserted:1,updated:0,retained:1,total:2});
    expect(await getCompanyMaster('ITRI')).toEqual(before);
    expect(await rosterDb.companySettings.get('ITRI')).toEqual(setting);
  });

  it('重複工號的增量和取代都在修改前拒絕，保留名單及鎖定狀態',async()=>{
    await replaceCompanyMaster('ITRI',[master('A001')]);
    await setCompanyMasterLocked('ITRI',false);
    const before=await getCompanyMaster('ITRI');
    const duplicates=[master('A004'),master('A004',{name:'另一姓名'})];
    const message='本次匯入檔案有重複工號：A004，請確認檔案後重新匯入。';
    await expect(mergeCompanyMaster('ITRI',duplicates)).rejects.toThrow(message);
    await expect(replaceCompanyMaster('ITRI',duplicates)).rejects.toThrow(message);
    expect(await getCompanyMaster('ITRI')).toEqual(before);
    expect(await isCompanyMasterLocked('ITRI')).toBe(false);
  });

  it('交易中途寫入失敗會復原更新、新增及原鎖定狀態',async()=>{
    await replaceCompanyMaster('ITRI',[master('A001'),master('A002')]);
    await setCompanyMasterLocked('ITRI',false);
    const before=await getCompanyMaster('ITRI');
    const setting=await rosterDb.companySettings.get('ITRI');
    vi.spyOn(rosterDb.masterPeople,'add').mockRejectedValueOnce(new Error('模擬寫入失敗'));
    await expect(mergeCompanyMaster('ITRI',[master('A002',{name:'更新姓名'}),master('A004')])).rejects.toThrow('模擬寫入失敗');
    expect(await getCompanyMaster('ITRI')).toEqual(before);
    expect(await rosterDb.companySettings.get('ITRI')).toEqual(setting);
  });

  it('鎖定狀態寫入失敗會一併復原增量人員更新',async()=>{
    await replaceCompanyMaster('ITRI',[master('A001')]);
    const before=await getCompanyMaster('ITRI');
    vi.spyOn(rosterDb.companySettings,'put').mockRejectedValueOnce(new Error('鎖定失敗'));
    await expect(mergeCompanyMaster('ITRI',[master('A001',{name:'更新姓名'}),master('A004')])).rejects.toThrow('鎖定失敗');
    expect(await getCompanyMaster('ITRI')).toEqual(before);
  });

  it('00125 和 125 是不同工號，不以姓名或數字轉換合併',async()=>{
    await replaceCompanyMaster('ITRI',[master('00125',{name:'同一姓名'})]);
    expect(await mergeCompanyMaster('ITRI',[master('125',{name:'同一姓名'})])).toEqual({inserted:1,updated:0,retained:1,total:2});
    expect((await getCompanyMaster('ITRI')).map(row=>row.employeeNo)).toEqual(['00125','125']);
  });

  it('本次提供的新分機更新舊值',async()=>{
    await replaceCompanyMaster('ITRI',[master('A001')]);
    await mergeCompanyMaster('ITRI',[master('A001',{extension:'5678'})]);
    expect((await getCompanyMaster('ITRI'))[0].extension).toBe('5678');
  });
});

describe('增量匯入檔案驗證',()=>{
  it('重複工號錯誤列出工號、每個姓名及原始 Excel 列號',()=>{
    const rows=[excelRow('00125',{姓名:'王小明'}),excelRow('',{姓名:'',身分證:'',性別:'','活動項目(原始)':'',項目:'',院內分機:''}),excelRow('00125',{姓名:'李小華'})];
    expect(()=>parseMasterRows(rows,'ITRI')).toThrow('本次匯入檔案有重複工號：00125，請確認檔案後重新匯入。');
    expect(()=>parseMasterRows(rows,'ITRI')).toThrow('王小明（Excel 第 2 列）、李小華（Excel 第 4 列）');
  });

  it.each(['工號','姓名','身分證','性別','活動項目(原始)','項目'])('必要欄位 %s 空白時阻止匯入',field=>{
    expect(()=>parseMasterRows([excelRow('A001',{[field]:'　 '})],'ITRI')).toThrow(`缺少：${field}`);
  });

  it('可選分機可以空白，文字工號保留前導零',()=>{
    expect(parseMasterRows([excelRow('00125',{院內分機:''})],'itri')[0]).toMatchObject({employeeNo:'00125',extension:'',companyKey:'ITRI'});
  });

  it('讀取 Excel 格式化數字工號保留前導零',async()=>{
    const sheet=XLSX.utils.json_to_sheet([excelRow('00125')]);
    sheet.A2={t:'n',v:125,z:'00000'};
    const workbook=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook,sheet,'大名單');
    const bytes=XLSX.write(workbook,{type:'array',bookType:'xlsx'}) as ArrayBuffer;
    const file={arrayBuffer:async()=>bytes} as File;
    expect((await readMasterFile(file,'ITRI'))[0].employeeNo).toBe('00125');
  });

  it('真實 Excel 含空白列時，重複錯誤仍使用實際列號',async()=>{
    const sheet=XLSX.utils.aoa_to_sheet([['工號','姓名','身分證','性別','活動項目(原始)','項目'],['A001','王小明','A123456789','男','一般','一般'],[],['A001','李小華','B234567890','女','一般','一般']]);
    const workbook=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook,sheet,'大名單');
    const bytes=XLSX.write(workbook,{type:'array',bookType:'xlsx'}) as ArrayBuffer;
    await expect(readMasterFile({arrayBuffer:async()=>bytes} as File,'ITRI')).rejects.toThrow('王小明（Excel 第 2 列）、李小華（Excel 第 4 列）');
  });
});
