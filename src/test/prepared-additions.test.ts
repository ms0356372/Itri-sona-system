import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {addPreparedPerson,getCompanyMaster,getPreparedSchedule,isCompanyMasterLocked,replaceCompanyMaster,replacePreparedSchedule,rosterDb,setCompanyMasterLocked} from '../features/roster/db';
import {makePreparedFromMaster} from '../features/roster/match';
import type {MasterPerson,PreparedPerson} from '../features/roster/types';

const master=(patch:Partial<MasterPerson>={}):MasterPerson=>({companyName:'ITRI',companyKey:'ITRI',employeeNo:'00125',name:'王小明',nationalId:'A123456789',gender:'男',originalActivity:'一般健檢',item:'一般',extension:'1234',updatedAt:'2026-01-01T00:00:00Z',...patch});
const prepared=(patch:Partial<PreparedPerson>={}):PreparedPerson=>({...makePreparedFromMaster(master(),'2026-10-06','07:30~08:00',1),...patch});

describe('現場單筆新增 Prepared Schedule',()=>{
  beforeEach(async()=>{await rosterDb.open();await rosterDb.preparedPeople.clear();await rosterDb.masterPeople.clear();await rosterDb.companySettings.clear();});
  afterEach(()=>vi.restoreAllMocks());

  it('保留原排程且以最大 sequence + 1 加入，其他場次不變',async()=>{
    const old=prepared({employeeNo:'原有',nationalId:'B234567890',sequence:151});
    const other=prepared({employeeNo:'其他場次',nationalId:'C345678901',sequence:900});
    await replacePreparedSchedule('today',[old]);
    await replacePreparedSchedule('other',[other]);
    const added=await addPreparedPerson('today',prepared({sequence:1}));
    expect(added.sequence).toBe(152);
    expect(await getPreparedSchedule('today')).toEqual([old,added]);
    expect(await getPreparedSchedule('other')).toEqual([other]);
    expect(added).not.toHaveProperty('sessionId');
  });

  it('同工號與正規化身分證重試回傳原列，不變更排程或新增筆數',async()=>{
    const first=await addPreparedPerson('today',prepared());
    const retry=await addPreparedPerson('today',prepared({nationalId:' a123456789 ',slot:'08:00~08:30',item:'新項目',extension:'9999',sequence:999}));
    expect(retry).toEqual(first);
    expect(await getPreparedSchedule('today')).toEqual([first]);
  });

  it('併發新增不同人員仍取得唯一連續 sequence',async()=>{
    await replacePreparedSchedule('today',[prepared({employeeNo:'OLD',nationalId:'Z999999999',sequence:151})]);
    const additions=Array.from({length:8},(_,index)=>prepared({employeeNo:`N${index}`,name:`人員 ${index}`,nationalId:`A12345678${index}`}));
    const added=await Promise.all(additions.map(person=>addPreparedPerson('today',person)));
    expect(added.map(person=>person.sequence).sort((a,b)=>a-b)).toEqual([152,153,154,155,156,157,158,159]);
    expect(await getPreparedSchedule('today')).toHaveLength(9);
  });

  it('同一人併發重試僅新增一列且回傳同一 localId',async()=>{
    const rows=await Promise.all(Array.from({length:5},()=>addPreparedPerson('today',prepared())));
    expect(new Set(rows.map(row=>row.localId)).size).toBe(1);
    expect(rows.every(row=>row.sequence===1)).toBe(true);
    expect(await getPreparedSchedule('today')).toHaveLength(1);
  });

  it('舊排程的重複人員即使 identity 相同仍拒絕選擇其中一列',async()=>{
    const old=[prepared(),prepared({sequence:2})];
    await replacePreparedSchedule('today',old);
    await expect(addPreparedPerson('today',prepared())).rejects.toThrow('同一身分證或工號對應多筆今日資料，請工作人員確認排程。');
    expect(await getPreparedSchedule('today')).toEqual(old);
  });

  it.each([{nationalId:'B234567890'},{name:'另一個人'}])('相同工號且人員資料不同時拒絕，不覆蓋舊列：%j',async patch=>{
    const first=await addPreparedPerson('today',prepared());
    await expect(addPreparedPerson('today',prepared(patch))).rejects.toThrow('此工號已存在於今日排程，請確認人員資料。');
    expect(await getPreparedSchedule('today')).toEqual([first]);
  });

  it('相同身分證不同工號拒絕新增',async()=>{
    const first=await addPreparedPerson('today',prepared());
    await expect(addPreparedPerson('today',prepared({employeeNo:'OTHER',nationalId:' a123456789 '}))).rejects.toThrow('此身分證已存在於今日排程，請確認人員資料。');
    expect(await getPreparedSchedule('today')).toEqual([first]);
  });

  it('其他場次相同工號及身分證不會阻止目前場次新增',async()=>{
    await addPreparedPerson('other',prepared());
    expect((await addPreparedPerson('today',prepared())).sequence).toBe(1);
    expect(await getPreparedSchedule('today')).toHaveLength(1);
    expect(await getPreparedSchedule('other')).toHaveLength(1);
  });

  it('加入公司大名單同一交易保存，正規化公司 key 並補 originalActivity',async()=>{
    await replaceCompanyMaster('ITRI',[master({employeeNo:'EXISTING',nationalId:'B234567890'})]);
    const setting=await rosterDb.companySettings.get('ITRI');
    const added=await addPreparedPerson('today',prepared(),master({companyName:' Ｉｔｒｉ ',companyKey:'WRONG',originalActivity:''}));
    expect(await getPreparedSchedule('today')).toEqual([added]);
    expect((await getCompanyMaster('itri')).find(person=>person.employeeNo==='00125')).toMatchObject({companyName:' Ｉｔｒｉ ',companyKey:'ITRI',originalActivity:'一般'});
    expect(await rosterDb.companySettings.get('ITRI')).toEqual(setting);
    expect(await isCompanyMasterLocked('ITRI')).toBe(true);
  });

  it('人工單筆新增保持原本解鎖狀態',async()=>{
    await setCompanyMasterLocked('ITRI',false);
    const setting=await rosterDb.companySettings.get('ITRI');
    await addPreparedPerson('today',prepared(),master());
    expect(await rosterDb.companySettings.get('ITRI')).toEqual(setting);
    expect(await isCompanyMasterLocked('ITRI')).toBe(false);
  });

  it('首次人工新增未建立或修改公司鎖定設定',async()=>{
    await addPreparedPerson('today',prepared(),master());
    expect(await rosterDb.companySettings.get('ITRI')).toBeUndefined();
  });

  it('勾選加入大名單時同工號另一人阻止整筆交易',async()=>{
    await replaceCompanyMaster('ITRI',[master({nationalId:'B234567890'})]);
    const before=await getCompanyMaster('ITRI');
    await expect(addPreparedPerson('today',prepared(),master())).rejects.toThrow('此工號已存在於公司大名單且人員資料不同，請確認人員資料。');
    expect(await getPreparedSchedule('today')).toEqual([]);
    expect(await getCompanyMaster('ITRI')).toEqual(before);
  });

  it('未勾選加入大名單時，不以另一公司大名單資料擋住新增',async()=>{
    await replaceCompanyMaster('ITRI',[master({nationalId:'B234567890'})]);
    await addPreparedPerson('today',prepared());
    expect(await getPreparedSchedule('today')).toHaveLength(1);
    expect((await getCompanyMaster('ITRI'))[0].nationalId).toBe('B234567890');
  });

  it('大名單相同身分證不同工號時拒絕且不新增今日排程',async()=>{
    await replaceCompanyMaster('ITRI',[master({employeeNo:'OTHER'})]);
    await expect(addPreparedPerson('today',prepared(),master({nationalId:' a123456789 '}))).rejects.toThrow('此身分證已存在於公司大名單，請確認人員資料。');
    expect(await getPreparedSchedule('today')).toEqual([]);
  });

  it('舊大名單重複身分證即使 identity 相同仍阻止整筆新增',async()=>{
    await rosterDb.masterPeople.bulkAdd([master(),master()]);
    const before=await getCompanyMaster('ITRI');
    await expect(addPreparedPerson('today',prepared(),master())).rejects.toThrow('公司大名單中此身分證對應多筆人員，請至名單管理確認。');
    expect(await getPreparedSchedule('today')).toEqual([]);
    expect(await getCompanyMaster('ITRI')).toEqual(before);
  });

  it('舊大名單重複工號且不同身分證仍阻止選擇其中一列',async()=>{
    await rosterDb.masterPeople.bulkAdd([master(),master({nationalId:'B234567890'})]);
    const before=await getCompanyMaster('ITRI');
    await expect(addPreparedPerson('today',prepared(),master())).rejects.toThrow('公司大名單中此工號對應多筆人員，請至名單管理確認。');
    expect(await getPreparedSchedule('today')).toEqual([]);
    expect(await getCompanyMaster('ITRI')).toEqual(before);
  });

  it('大名單既有同一人保持原資料、不重複新增',async()=>{
    await replaceCompanyMaster('ITRI',[master()]);
    const before=await getCompanyMaster('ITRI');
    await addPreparedPerson('today',prepared(),master({extension:'9999'}));
    expect(await getCompanyMaster('ITRI')).toEqual(before);
    expect(await getPreparedSchedule('today')).toHaveLength(1);
  });

  it('公司大名單寫入失敗時也復原本機排程新增',async()=>{
    const old=await addPreparedPerson('today',prepared({employeeNo:'OLD',nationalId:'B234567890'}));
    vi.spyOn(rosterDb.masterPeople,'add').mockRejectedValueOnce(new Error('模擬大名單寫入失敗'));
    await expect(addPreparedPerson('today',prepared(),master())).rejects.toThrow('模擬大名單寫入失敗');
    expect(await getPreparedSchedule('today')).toEqual([old]);
    expect(await getCompanyMaster('ITRI')).toEqual([]);
  });

  it('新排程與要保存的大名單 identity 不同時拒絕全部新增',async()=>{
    await expect(addPreparedPerson('today',prepared(),master({employeeNo:'WRONG'}))).rejects.toThrow('公司大名單與今日排程的人員資料不一致');
    expect(await getPreparedSchedule('today')).toEqual([]);
    expect(await getCompanyMaster('ITRI')).toEqual([]);
  });
});
