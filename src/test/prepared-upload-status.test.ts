import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import Dexie from 'dexie';
import {clearPreparedSchedule,getPreparedSchedule,getPreparedUpload,replacePreparedSchedule,RosterDatabase,rosterDb,savePreparedUpload,setPreparedUploadPendingChanges} from '../features/roster/db';
import {preparedScheduleSignature} from '../features/roster/uploadStatus';
import type {MasterPerson,PreparedPerson,PreparedUploadMetadata} from '../features/roster/types';

const prepared=(patch:Partial<PreparedPerson>={}):PreparedPerson=>({localId:crypto.randomUUID(),sequence:1,employeeNo:'00125',name:'王小明',gender:'男',scheduleDate:'2026-10-08',slot:'07:30~08:00',item:'一般',extension:'1234',nationalId:'A123456789',originalActivity:'一般健檢',dailyActivity:'一般健檢',issues:[],confirmed:true,...patch});
const metadata=(sessionId='session-a',patch:Partial<PreparedUploadMetadata>={}):PreparedUploadMetadata=>({sessionId,lastUploadedAt:'2026-10-08T03:36:00.000Z',lastUploadedCount:151,uploadedPreparedSignature:preparedScheduleSignature([prepared()]),...patch});

describe('每日排程上傳狀態的本機 metadata',()=>{
  beforeEach(async()=>{
    await rosterDb.open();
    await rosterDb.preparedPeople.clear();
    await rosterDb.preparedUploads.clear();
    await rosterDb.masterPeople.clear();
    await rosterDb.companySettings.clear();
  });
  afterEach(()=>vi.restoreAllMocks());

  it('未成功上傳的場次沒有 metadata',async()=>{
    await replacePreparedSchedule('session-a',[prepared()]);
    expect(await getPreparedUpload('session-a')).toBeNull();
  });

  it('第一次上傳前標記排程變更不建立假的成功 metadata',async()=>{
    expect(await setPreparedUploadPendingChanges('session-a',true)).toBeNull();
    expect(await setPreparedUploadPendingChanges('session-a',false)).toBeNull();
    expect(await getPreparedUpload('session-a')).toBeNull();
    expect(await rosterDb.preparedUploads.count()).toBe(0);
  });

  it('待確認重匯入標記保留成功資訊並跨 reopen 維持，乾淨重匯入與成功保存可清除',async()=>{
    const uploaded=metadata();const other=metadata('session-b');
    await savePreparedUpload(uploaded);await savePreparedUpload(other);
    const marked={...uploaded,hasPendingChanges:true};
    expect(await setPreparedUploadPendingChanges('session-a',true)).toEqual(marked);
    rosterDb.close();await rosterDb.open();
    expect(await getPreparedUpload('session-a')).toEqual(marked);
    expect(await getPreparedUpload('session-b')).toEqual(other);
    expect(await setPreparedUploadPendingChanges('session-a',false)).toEqual({...uploaded,hasPendingChanges:false});
    expect(await setPreparedUploadPendingChanges('session-a',true)).toEqual(marked);
    const latest=metadata('session-a',{lastUploadedAt:'2026-10-08T04:00:00.000Z',lastUploadedCount:152});
    await savePreparedUpload(latest);
    expect(await getPreparedUpload('session-a')).toEqual(latest);
    expect(await getPreparedUpload('session-a')).not.toHaveProperty('hasPendingChanges');
  });

  it('成功 metadata 以場次隔離、再次保存取代同場次，close/open 後仍可恢復',async()=>{
    const first=metadata();const other=metadata('session-b',{lastUploadedCount:2});
    await savePreparedUpload(first);await savePreparedUpload(other);
    const latest={...first,lastUploadedAt:'2026-10-08T04:01:00.000Z',lastUploadedCount:152};
    await savePreparedUpload(latest);
    rosterDb.close();await rosterDb.open();
    expect(await getPreparedUpload('session-a')).toEqual(latest);
    expect(await getPreparedUpload('session-b')).toEqual(other);
    expect(await rosterDb.preparedUploads.count()).toBe(2);
    expect(await getPreparedUpload('session-c')).toBeNull();
  });

  it('重新匯入只取代 prepared，不改寫最後成功 metadata，內容 signature 可辨識變更',async()=>{
    const row=prepared();const uploaded=metadata('session-a',{uploadedPreparedSignature:preparedScheduleSignature([row])});
    await replacePreparedSchedule('session-a',[row]);await savePreparedUpload(uploaded);
    const changed=prepared({employeeNo:'00126',name:'新受檢者',sequence:2});
    await replacePreparedSchedule('session-a',[changed]);
    expect(await getPreparedSchedule('session-a')).toEqual([changed]);
    expect(await getPreparedUpload('session-a')).toEqual(uploaded);
    expect(preparedScheduleSignature(await getPreparedSchedule('session-a'))).not.toBe(uploaded.uploadedPreparedSignature);
  });

  it('清除場次排程一併清除該場次 metadata，保留另一場次、大名單及 lock',async()=>{
    const first=prepared();const other=prepared({employeeNo:'00999'});
    const master:MasterPerson={id:91,companyName:'ITRI',companyKey:'ITRI',employeeNo:'00125',name:'王小明',nationalId:'A123456789',gender:'男',originalActivity:'一般健檢',item:'一般',extension:'1234',updatedAt:'2026-10-08T00:00:00Z'};
    const lock={companyName:'ITRI',companyKey:'ITRI',masterLocked:true,updatedAt:'2026-10-08T00:00:00Z'};
    await rosterDb.masterPeople.add(master);await rosterDb.companySettings.put(lock);
    await replacePreparedSchedule('session-a',[first]);await replacePreparedSchedule('session-b',[other]);
    await savePreparedUpload(metadata());const otherUpload=metadata('session-b');await savePreparedUpload(otherUpload);
    expect(await clearPreparedSchedule('session-a')).toBe(1);
    expect(await getPreparedSchedule('session-a')).toEqual([]);expect(await getPreparedUpload('session-a')).toBeNull();
    expect(await getPreparedSchedule('session-b')).toEqual([other]);expect(await getPreparedUpload('session-b')).toEqual(otherUpload);
    expect(await rosterDb.masterPeople.get(91)).toEqual(master);expect(await rosterDb.companySettings.get('ITRI')).toEqual(lock);
  });

  it('metadata 清除失敗時交易保留排程與最後成功狀態',async()=>{
    const row=prepared();const uploaded=metadata();
    await replacePreparedSchedule('session-a',[row]);await savePreparedUpload(uploaded);
    vi.spyOn(rosterDb.preparedUploads,'delete').mockRejectedValueOnce(new Error('本機寫入失敗'));
    await expect(clearPreparedSchedule('session-a')).rejects.toThrow('本機寫入失敗');
    expect(await getPreparedSchedule('session-a')).toEqual([row]);expect(await getPreparedUpload('session-a')).toEqual(uploaded);
  });
});

describe('上傳 metadata IndexedDB v8 升級',()=>{
  it('v7→v8 完整保留既有大名單、公司鎖定及排程，只新增本機 store',async()=>{
    const name=`prepared-upload-upgrade-${crypto.randomUUID()}`;const legacy=new Dexie(name);
    legacy.version(7).stores({masterPeople:'++id, companyKey, employeeNo, name, nationalId, [companyKey+employeeNo], [companyKey+nationalId]',preparedPeople:'localId, sessionId, employeeNo, nationalId',companySettings:'companyKey'});
    await legacy.open();
    const master:MasterPerson={id:91,companyName:'ITRI',companyKey:'ITRI',employeeNo:'00125',name:'王小明',nationalId:'A123456789',gender:'男',originalActivity:'一般健檢',item:'一般',extension:'1234',updatedAt:'2026-10-08T00:00:00Z'};
    const row={...prepared(),sessionId:'legacy-session'};
    const lock={companyName:'ITRI',companyKey:'ITRI',masterLocked:true,updatedAt:'2026-10-08T00:00:00Z'};
    await legacy.table('masterPeople').add(master);await legacy.table('preparedPeople').add(row);await legacy.table('companySettings').put(lock);legacy.close();
    const upgraded=new RosterDatabase(name);
    try{
      await upgraded.open();expect(upgraded.verno).toBe(8);
      expect(await upgraded.masterPeople.toArray()).toEqual([master]);
      expect(await upgraded.preparedPeople.toArray()).toEqual([row]);
      expect(await upgraded.companySettings.toArray()).toEqual([lock]);
      expect(await upgraded.preparedUploads.count()).toBe(0);
      const uploaded=metadata('legacy-session');await upgraded.preparedUploads.put(uploaded);
      upgraded.close();await upgraded.open();
      expect(await upgraded.preparedUploads.get('legacy-session')).toEqual(uploaded);
      expect(await upgraded.masterPeople.where('[companyKey+nationalId]').equals(['ITRI','A123456789']).toArray()).toEqual([master]);
      expect(await upgraded.preparedPeople.get(row.localId)).toEqual(row);
      expect(await upgraded.companySettings.get('ITRI')).toEqual(lock);
    }finally{upgraded.close();await Dexie.delete(name);}
  });
});

describe('整理後排程的穩定內容 signature',()=>{
  it('相同內容更換 localId、重排讀取順序不誤判，且不修改來源',()=>{
    const first=prepared({issues:['name_mismatch','activity_mismatch'],confirmed:false});
    const second=prepared({sequence:2,employeeNo:'00126',name:'李小華'});
    const rows=[first,second];const before=structuredClone(rows);
    const copied=[{...second,localId:crypto.randomUUID()},{...first,localId:crypto.randomUUID(),issues:[...first.issues].reverse()}];
    expect(preparedScheduleSignature(copied)).toBe(preparedScheduleSignature(rows));
    expect(rows).toEqual(before);
    expect(preparedScheduleSignature([])).toBe('[]');
  });

  it('人工確認與重新比對的 validation flags 不視為內容變更',()=>{
    const row=prepared({issues:[],confirmed:true});
    expect(preparedScheduleSignature([{...row,confirmed:false}])).toBe(preparedScheduleSignature([row]));
    expect(preparedScheduleSignature([{...row,issues:['name_mismatch','activity_mismatch']}])).toBe(preparedScheduleSignature([row]));
  });

  it.each([
    ['sequence',{sequence:2}],['employeeNo',{employeeNo:'125'}],['name',{name:'李小華'}],
    ['gender',{gender:''}],['scheduleDate',{scheduleDate:'2026-10-09'}],['slot',{slot:'08:00~08:30'}],
    ['item',{item:'特殊'}],['extension',{extension:''}],['nationalId',{nationalId:'B234567890'}],
    ['originalActivity',{originalActivity:'不同來源'}],['dailyActivity',{dailyActivity:'不同活動'}],
  ] satisfies [string,Partial<PreparedPerson>][] )('%s 實質內容變更時 signature 改變',(_field,patch)=>{
    const row=prepared();
    expect(preparedScheduleSignature([{...row,...patch}])).not.toBe(preparedScheduleSignature([row]));
  });

  it('新增、刪除或重複一列皆改變 signature，保留筆數與 sequence 的意義',()=>{
    const row=prepared();const signature=preparedScheduleSignature([row]);
    expect(preparedScheduleSignature([])).not.toBe(signature);
    expect(preparedScheduleSignature([row,prepared({sequence:2,employeeNo:'00126'})])).not.toBe(signature);
    expect(preparedScheduleSignature([row,{...row,localId:crypto.randomUUID()}])).not.toBe(signature);
  });
});
