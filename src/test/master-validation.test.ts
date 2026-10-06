import {beforeEach,describe,expect,it} from 'vitest';
import * as XLSX from 'xlsx';
import {getCompanyMaster,mergeCompanyMaster,replaceCompanyMaster,rosterDb,setCompanyMasterLocked} from '../features/roster/db';
import {parseMasterRows,readMasterFile} from '../features/roster/excel';
import {assertCompleteImportedPeople} from '../features/roster/masterImport';
import type {MasterPerson} from '../features/roster/types';

type ImportedPerson=MasterPerson&{sourceRow?:number};
const person=(employeeNo:string,patch:Partial<ImportedPerson>={}):ImportedPerson=>({companyName:'ITRI',companyKey:'ITRI',employeeNo,name:'王小明',nationalId:'A123456789',gender:'男',originalActivity:'一般健檢',item:'一般',extension:'1234',updatedAt:'2026-01-01T00:00:00Z',...patch});
const excelRow=(employeeNo:string,patch:Record<string,unknown>={})=>({工號:employeeNo,姓名:'王小明',身分證:'A123456789',性別:'男','活動項目(原始)':'一般健檢',項目:'一般',院內分機:'1234',...patch});
const errorMessage=(run:()=>unknown):string=>{
  try{run();}catch(error){if(error instanceof Error)return error.message;throw error;}
  throw new Error('預期匯入驗證應拒絕不完整資料');
};
const fileFromSheet=(sheet:XLSX.WorkSheet):File=>{
  const workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,sheet,'公司大名單');
  const bytes=XLSX.write(workbook,{type:'array',bookType:'xlsx'}) as ArrayBuffer;
  return{arrayBuffer:async()=>bytes} as File;
};

describe('公司大名單彙整全部不完整人員',()=>{
  it('一次列出第 10、20、30 列的所有缺漏，保留列號、工號及姓名',()=>{
    const incoming=[
      person('A001',{sourceRow:10,nationalId:''}),
      person('A002',{sourceRow:20,name:'李小華',item:''}),
      person('A003',{sourceRow:30,name:''}),
    ];
    expect(errorMessage(()=>assertCompleteImportedPeople(incoming))).toBe([
      '本次匯入檔案有 3 筆資料不完整，請確認後重新匯入。',
      '',
      '第 10 列｜工號 A001｜王小明｜缺少：身分證',
      '第 20 列｜工號 A002｜李小華｜缺少：項目',
      '第 30 列｜工號 A003｜姓名未填｜缺少：姓名',
    ].join('\n'));
  });

  it('同一列缺少工號、姓名及性別，總數仍只計算一筆',()=>{
    expect(errorMessage(()=>assertCompleteImportedPeople([person('',{sourceRow:10,name:'',gender:''})]))).toBe([
      '本次匯入檔案有 1 筆資料不完整，請確認後重新匯入。',
      '',
      '第 10 列｜工號未填｜姓名未填｜缺少：工號、姓名、性別',
    ].join('\n'));
  });

  it('純空白欄位視為缺漏，並使用未填工號與姓名標示',()=>{
    const message=errorMessage(()=>assertCompleteImportedPeople([person(' \t　',{sourceRow:20,name:'　 \n',nationalId:' \t',gender:'　',originalActivity:'\n ',item:' \r\n',extension:''})]));
    expect(message).toBe([
      '本次匯入檔案有 1 筆資料不完整，請確認後重新匯入。',
      '',
      '第 20 列｜工號未填｜姓名未填｜缺少：工號、姓名、身分證、性別、活動項目(原始)、項目',
    ].join('\n'));
  });

  it('完整人員且分機未填可通過，不修改原始資料',()=>{
    const incoming=[person('00125',{extension:''}),person('125',{extension:'　'})];
    const before=structuredClone(incoming);
    expect(()=>assertCompleteImportedPeople(incoming)).not.toThrow();
    expect(incoming).toEqual(before);
    expect(parseMasterRows([excelRow('00125',{院內分機:''})],'ITRI')[0]).toMatchObject({employeeNo:'00125',extension:''});
  });

  it('只有完整人員或空陣列時不會拋出錯誤',()=>{
    expect(()=>assertCompleteImportedPeople([person('A001'),person('A002')])).not.toThrow();
    expect(()=>assertCompleteImportedPeople([])).not.toThrow();
  });

  it('混合完整與不完整資料時只計算不完整列，預設列號維持原位置',()=>{
    const incoming=[person('A001'),person('A002',{name:'李小華',gender:''}),person('A003'),person('A004',{name:'陳美玲',item:''})];
    const message=errorMessage(()=>assertCompleteImportedPeople(incoming));
    expect(message).toBe([
      '本次匯入檔案有 2 筆資料不完整，請確認後重新匯入。',
      '',
      '第 3 列｜工號 A002｜李小華｜缺少：性別',
      '第 5 列｜工號 A004｜陳美玲｜缺少：項目',
    ].join('\n'));
  });

  it('200 筆錯誤全部列出，最後第 4552 列不會被截斷',()=>{
    const incoming=Array.from({length:200},(_,index)=>person(`E${index.toString().padStart(3,'0')}`,{sourceRow:4353+index,name:`人員 ${index}`,gender:index===199?'男':'',item:index===199?'':'一般'}));
    const message=errorMessage(()=>assertCompleteImportedPeople(incoming));
    expect(message.startsWith('本次匯入檔案有 200 筆資料不完整，請確認後重新匯入。\n\n')).toBe(true);
    const lines=message.split('\n').filter(line=>line.startsWith('第 '));
    expect(lines).toHaveLength(200);
    incoming.forEach((row,index)=>expect(lines[index]).toBe(`第 ${row.sourceRow} 列｜工號 ${row.employeeNo}｜${row.name}｜缺少：${index===199?'項目':'性別'}`));
    expect(lines.at(-1)).toBe('第 4552 列｜工號 E199｜人員 199｜缺少：項目');
  });

  it('parser 優先彙整多筆缺少工號的人員，不將空工號誤報為重複工號',()=>{
    const rows=[
      excelRow('',{姓名:'',性別:''}),
      excelRow('　',{姓名:'李小華',身分證:''}),
      excelRow('A003',{姓名:'陳美玲',項目:''}),
    ];
    const message=errorMessage(()=>parseMasterRows(rows,'ITRI'));
    expect(message).toBe([
      '本次匯入檔案有 3 筆資料不完整，請確認後重新匯入。',
      '',
      '第 2 列｜工號未填｜姓名未填｜缺少：工號、姓名、性別',
      '第 3 列｜工號未填｜李小華｜缺少：工號、身分證',
      '第 4 列｜工號 A003｜陳美玲｜缺少：項目',
    ].join('\n'));
    expect(message).not.toContain('重複工號');
  });

  it('真實 Excel 空白列不影響不完整人員的第 10、20、30 列位置',async()=>{
    const cells:unknown[][]=Array.from({length:30},()=>[]);
    cells[0]=['工號','姓名','身分證','性別','活動項目(原始)','項目'];
    cells[9]=['A001','王小明','','男','一般健檢','一般'];
    cells[19]=['A002','李小華','B234567890','','一般健檢',''];
    cells[29]=['A003','陳美玲','C345678901','女','','一般'];
    await expect(readMasterFile(fileFromSheet(XLSX.utils.aoa_to_sheet(cells)),'ITRI')).rejects.toThrow([
      '本次匯入檔案有 3 筆資料不完整，請確認後重新匯入。',
      '',
      '第 10 列｜工號 A001｜王小明｜缺少：身分證',
      '第 20 列｜工號 A002｜李小華｜缺少：性別、項目',
      '第 30 列｜工號 A003｜陳美玲｜缺少：活動項目(原始)',
    ].join('\n'));
  });

  it('完整檔案有多組重複工號時仍列出每組及每人的姓名列號',()=>{
    const rows=[excelRow('A001'),excelRow('B003',{姓名:'李小華'}),excelRow('A001',{姓名:'陳美玲'}),excelRow('B003',{姓名:'林小美'})];
    const message=errorMessage(()=>parseMasterRows(rows,'ITRI'));
    expect(message).toBe([
      '本次匯入檔案有重複工號：A001、B003，請確認檔案後重新匯入。',
      'A001：王小明（Excel 第 2 列）、陳美玲（Excel 第 4 列）；B003：李小華（Excel 第 3 列）、林小美（Excel 第 5 列）',
    ].join('\n'));
  });
});

describe('不完整大名單匯入不修改 IndexedDB',()=>{
  beforeEach(async()=>{await rosterDb.open();await rosterDb.masterPeople.clear();await rosterDb.companySettings.clear();});

  for(const [mode,operation] of [['整份取代',replaceCompanyMaster],['增量更新',mergeCompanyMaster]] as const){
    it.each([true,false])(`${mode}驗證失敗時完整保留原名單及原鎖定狀態 %s`,async locked=>{
      await replaceCompanyMaster('ITRI',[person('A001'),person('A002',{name:'李小華'})]);
      await setCompanyMasterLocked('ITRI',locked);
      await replaceCompanyMaster('另一公司',[person('OTHER')]);
      const beforePeople=await rosterDb.masterPeople.toArray();
      const beforeSettings=await rosterDb.companySettings.toArray();
      const incomplete=[person('A001',{gender:''}),person('A003',{nationalId:'',name:'陳美玲'}),person('A004',{originalActivity:'',name:'林小美'})];
      await expect(operation(' Ｉｔｒｉ ',incomplete)).rejects.toThrow([
        '本次匯入檔案有 3 筆資料不完整，請確認後重新匯入。',
        '',
        '第 2 列｜工號 A001｜王小明｜缺少：性別',
        '第 3 列｜工號 A003｜陳美玲｜缺少：身分證',
        '第 4 列｜工號 A004｜林小美｜缺少：活動項目(原始)',
      ].join('\n'));
      expect(await rosterDb.masterPeople.toArray()).toEqual(beforePeople);
      expect(await rosterDb.companySettings.toArray()).toEqual(beforeSettings);
      expect(await getCompanyMaster('ITRI')).toHaveLength(2);
      expect(await getCompanyMaster('另一公司')).toHaveLength(1);
    });
  }
});
