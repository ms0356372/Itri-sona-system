import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import Dexie from 'dexie';
import * as XLSX from 'xlsx';
import {addMasterPerson,clearCompanyMaster,getCompanyMaster,isCompanyMasterLocked,replaceCompanyMaster,RosterDatabase,rosterDb,setCompanyMasterLocked} from '../features/roster/db';
import {normalizeCompanyName} from '../lib/company';
import {parseDailyRows,parseMasterRows,preparedRosterWorkbook} from '../features/roster/excel';
import {makePreparedFromMaster,matchRoster} from '../features/roster/match';
import type {DailySchedulePerson,MasterPerson} from '../features/roster/types';
import {preparedCloudRow} from '../features/schedule/service';
import {readFileSync} from 'node:fs';

const master=(patch:Partial<MasterPerson>={}):MasterPerson=>({companyName:'虛構公司',companyKey:'虛構公司',employeeNo:'00125',name:'王小明',nationalId:'A123456789',gender:'男',originalActivity:'員工一般健檢A',item:'一般',extension:'1234',updatedAt:'2026-09-24T00:00:00Z',...patch});
const daily=(patch:Partial<DailySchedulePerson>={}):DailySchedulePerson=>({sourceRow:2,employeeNo:'00125',name:'王小明',scheduleDate:'2026-09-24',slot:'07:30~08:00',activity:'員工一般健檢A',extension:'',...patch});

describe('健檢報到站名單整理',()=>{
  beforeEach(async()=>{await rosterDb.open();await rosterDb.masterPeople.clear();await rosterDb.companySettings.clear();});
  afterEach(()=>vi.restoreAllMocks());
  it('成功匯入大名單並辨識欄位別名、保留工號前導 0',()=>{const result=parseMasterRows([{員工工號:'00125',員工姓名:'王小明',身份證號:'a123456789',性別:'男','活動項目（原始）':'員工一般健檢A',檢查項目:'一般',分機:'1234'}],'虛構公司');expect(result[0]).toMatchObject({employeeNo:'00125',nationalId:'A123456789',originalActivity:'員工一般健檢A',item:'一般'});});
  it('成功匯入只有單日欄位的每日排程',()=>{expect(parseDailyRows([{人員工號:'00125',人員姓名:'王小明',排程日期:'2026-09-24',排程時段:'07:30～08:00',活動項目:'員工一般健檢A'}])[0]).toMatchObject({employeeNo:'00125',slot:'07:30~08:00'});});
  it('正常比對並從大名單補入身分證、性別與最終項目',()=>{expect(matchRoster([master()],[daily()]).ready[0]).toMatchObject({nationalId:'A123456789',gender:'男',item:'一般'});});
  it('工號找不到時列入待確認',()=>expect(matchRoster([master()],[daily({employeeNo:'00999'})]).pending[0].issues).toContain('master_not_found'));
  it('工號一致但姓名不同時列入待確認',()=>expect(matchRoster([master()],[daily({name:'李小華'})]).pending[0].issues).toContain('name_mismatch'));
  it('活動項目不同時待確認，最終項目仍取自大名單',()=>{const row=matchRoster([master()],[daily({activity:'不同活動'})]).pending[0];expect(row.issues).toContain('activity_mismatch');expect(row.item).toBe('一般');});
  it('大名單重複工號與每日重複資料皆列入待確認',()=>{const result=matchRoster([master(),master({name:'另一人'})],[daily(),daily()]);expect(result.pending[0].issues).toEqual(expect.arrayContaining(['duplicate_master','duplicate_daily']));});
  it('可從大名單新增至今日排程',()=>expect(makePreparedFromMaster(master(),'2026-09-24','08:00~08:30',1)).toMatchObject({employeeNo:'00125',scheduleDate:'2026-09-24',item:'一般'}));
  it('公司名稱以 NFKC、空白與英文大小寫建立共用 key',()=>{
    for(const value of ['ITRI','itri',' Itri ','ＩＴＲＩ'])expect(normalizeCompanyName(value)).toBe('ITRI');
    for(const value of ['工研院',' 工研院 ','工研院　','工研院\u00a0'])expect(normalizeCompanyName(value)).toBe('工研院');
    expect(normalizeCompanyName('台灣  公司')).toBe('台灣 公司');
    expect(normalizeCompanyName('ABC')).not.toBe(normalizeCompanyName('ABC股份有限公司'));
  });
  it('同一公司可跨大小寫與空白共用、鎖定及清除大名單',async()=>{await replaceCompanyMaster('ITRI',[master({companyName:'ITRI'})]);expect(await getCompanyMaster(' itri　')).toHaveLength(1);expect(await isCompanyMasterLocked('Ｉｔｒｉ')).toBe(true);await setCompanyMasterLocked('itri',false);expect(await isCompanyMasterLocked('ITRI')).toBe(false);await clearCompanyMaster(' Itri ');expect(await getCompanyMaster('ITRI')).toHaveLength(0);});
  it('可新增全新人員並選擇寫入本機大名單',async()=>{await addMasterPerson(master({employeeNo:'00999',name:'新進人員'}));expect(await getCompanyMaster('虛構公司')).toHaveLength(1);});
  it('匯出整理後 Excel 包含身分證欄',()=>{const workbook=preparedRosterWorkbook([makePreparedFromMaster(master(),'2026-09-24','07:30~08:00',1)]);const json=XLSX.utils.sheet_to_json(workbook.Sheets['整理後排程']);expect(json[0]).toMatchObject({工號:'00125',身分證:'A123456789',項目:'一般'});});
  it('Supabase 上傳 payload 不含身分證或藏入其他文字欄位',()=>{const payload=preparedCloudRow('session-1',makePreparedFromMaster(master(),'2026-09-24','07:30~08:00',1),0);expect(payload).not.toHaveProperty('national_id');expect(JSON.stringify(payload)).not.toContain('A123456789');});
  it('增量 migration 移除 national_id 且不以空字串假裝刪除',()=>{const sql=readFileSync('supabase/migrations/202609240001_remove_participant_national_id.sql','utf8');expect(sql).toMatch(/drop column national_id/i);expect(sql).toMatch(/identifier_count > 0 and not removal_approved/i);expect(sql).not.toMatch(/set\s+national_id\s*=\s*''/i);expect(sql).not.toMatch(/disable row level security/i);});
  it('重新開啟資料庫後完整身分證仍只存在本機大名單',async()=>{await replaceCompanyMaster('虛構公司',[master()]);rosterDb.close();await rosterDb.open();expect((await getCompanyMaster('虛構公司'))[0]).toMatchObject({employeeNo:'00125',nationalId:'A123456789'});});
  it('匯入成功會自動鎖定，重新開啟 IndexedDB 後鎖定仍保留',async()=>{await replaceCompanyMaster('虛構公司',[master()]);expect(await isCompanyMasterLocked('虛構公司')).toBe(true);rosterDb.close();await rosterDb.open();expect(await isCompanyMasterLocked('虛構公司')).toBe(true);});
  it('解鎖不刪除大名單，公司資料清除則一併清除鎖定狀態',async()=>{await replaceCompanyMaster('虛構公司',[master()]);await setCompanyMasterLocked('虛構公司',false);expect(await getCompanyMaster('虛構公司')).toHaveLength(1);expect(await isCompanyMasterLocked('虛構公司')).toBe(false);await clearCompanyMaster('虛構公司');expect(await getCompanyMaster('虛構公司')).toHaveLength(0);expect(await isCompanyMasterLocked('虛構公司')).toBe(false);});
  it('取代寫入失敗時以交易保留原有大名單',async()=>{await replaceCompanyMaster('虛構公司',[master()]);await expect(replaceCompanyMaster('虛構公司',[master({id:99,employeeNo:'2'}),master({id:99,employeeNo:'3'})])).rejects.toThrow();expect(await getCompanyMaster('虛構公司')).toHaveLength(1);expect((await getCompanyMaster('虛構公司'))[0].employeeNo).toBe('00125');});
});

describe('公司大名單 IndexedDB migration',()=>{
  it('保留 v3 大名單與鎖定狀態，並可用標準化名稱查詢',async()=>{
    const name=`roster-migration-${crypto.randomUUID()}`;
    const legacy=new Dexie(name);
    legacy.version(3).stores({masterPeople:'++id, companyName, employeeNo, name, [companyName+employeeNo]',preparedPeople:'localId, sessionId, employeeNo, nationalId',companySettings:'companyName'});
    await legacy.open();
    await legacy.table('masterPeople').add(({...master({companyName:'ITRI'}),companyKey:undefined}));
    await legacy.table('companySettings').put({companyName:'ITRI',masterLocked:true,updatedAt:'2026-09-24T00:00:00Z'});
    legacy.close();
    const upgraded=new RosterDatabase(name);
    try{
      await upgraded.open();
      const people=await upgraded.masterPeople.where('companyKey').equals(normalizeCompanyName('itri')).toArray();
      expect(people).toHaveLength(1);
      expect(people[0]).toMatchObject({companyName:'ITRI',companyKey:'ITRI',employeeNo:'00125'});
      expect((await upgraded.companySettings.get(normalizeCompanyName(' Itri ')))?.masterLocked).toBe(true);
    }finally{upgraded.close();await Dexie.delete(name);}
  });
});
