import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import Dexie from 'dexie';
import {addMasterPerson,isCompanyMasterLocked,replaceCompanyMaster,RosterDatabase,rosterDb,setCompanyMasterLocked,updateMasterPerson} from '../features/roster/db';
import {ensureCompanyMasterPerson,lookupCompanyMaster,validateManualMasterPerson} from '../features/roster/lookup';
import {makePreparedFromMaster} from '../features/roster/match';
import type {MasterPerson} from '../features/roster/types';

const person=(patch:Partial<MasterPerson>={}):MasterPerson=>({companyName:'ITRI',companyKey:'ITRI',employeeNo:'00125',name:'王小明',nationalId:'A123456789',gender:'男',originalActivity:'一般健檢',item:'一般',extension:'1234',updatedAt:'2026-01-01T00:00:00Z',...patch});
const reads:{index:string|null;limit:number|undefined;rows:number}[]=[];
rosterDb.use({stack:'dbcore',name:'master-lookup-query-count',create:core=>({...core,table:name=>{
  const table=core.table(name);
  return{...table,query:async request=>{
    const response=await table.query(request);
    if(name==='masterPeople')reads.push({index:request.query.index.name,limit:request.limit,rows:response.result.length});
    return response;
  }};
}})});

describe('Company Master indexed lookup',()=>{
  beforeEach(async()=>{await rosterDb.open();await rosterDb.masterPeople.clear();await rosterDb.companySettings.clear();reads.length=0;});
  afterEach(()=>vi.restoreAllMocks());

  it('5000人大名單僅用兩次compound index查詢，每次最多兩筆、不全讀或掃描',async()=>{
    await rosterDb.masterPeople.bulkAdd(Array.from({length:5000},(_,index)=>person({employeeNo:`E${index.toString().padStart(5,'0')}`,nationalId:`A${100000000+index}`,name:`測試人員 ${index}`})));
    reads.length=0;
    vi.spyOn(rosterDb.masterPeople,'toArray').mockImplementation(()=>{throw new Error('禁止整份讀取');});
    vi.spyOn(rosterDb.masterPeople,'toCollection').mockImplementation(()=>{throw new Error('禁止整份掃描');});
    expect(await lookupCompanyMaster(' Ｉｔｒｉ ',{nationalId:' a100004999 '})).toMatchObject({employeeNo:'E04999'});
    expect(await lookupCompanyMaster('itri',{employeeNo:' E04999 '})).toMatchObject({nationalId:'A100004999'});
    expect(reads).toEqual([{index:'[companyKey+nationalId]',limit:2,rows:1},{index:'[companyKey+employeeNo]',limit:2,rows:1}]);
  });

  it('公司隔離、ID大小寫正規化、工號前導零及精確大小寫保持',async()=>{
    await addMasterPerson(person());await addMasterPerson(person({companyName:'另一公司',employeeNo:'00999',name:'另一人'}));
    await addMasterPerson(person({employeeNo:'125',nationalId:'B234567890'}));
    expect(await lookupCompanyMaster(' itri ',{nationalId:'a123456789'})).toMatchObject({employeeNo:'00125'});
    expect(await lookupCompanyMaster('另一公司',{nationalId:'A123456789'})).toMatchObject({employeeNo:'00999'});
    expect(await lookupCompanyMaster('ITRI',{employeeNo:'00125'})).toMatchObject({nationalId:'A123456789'});
    expect(await lookupCompanyMaster('ITRI',{employeeNo:'125'})).toMatchObject({nationalId:'B234567890'});
    expect(await lookupCompanyMaster('ITRI',{employeeNo:'001'})).toBeNull();
    expect(await lookupCompanyMaster('ITRI',{employeeNo:'未知'})).toBeNull();
  });

  it('同公司重複工號或身分證均拒絕，不任意挑第一筆且僅讀兩筆',async()=>{
    await rosterDb.masterPeople.bulkAdd(Array.from({length:5},(_,index)=>person({name:`人員 ${index}`})));
    reads.length=0;
    await expect(lookupCompanyMaster('ITRI',{employeeNo:'00125'})).rejects.toThrow('此工號對應多筆人員');
    await expect(lookupCompanyMaster('ITRI',{nationalId:'A123456789'})).rejects.toThrow('此身分證對應多筆人員');
    expect(reads.map(read=>read.rows)).toEqual([2,2]);
  });

  it('空查詢不讀DB，新新增、取代及修改的ID皆可由索引查到',async()=>{
    expect(await lookupCompanyMaster('ITRI',{nationalId:' '})).toBeNull();
    expect(await lookupCompanyMaster(' ',{employeeNo:'00125'})).toBeNull();expect(reads).toHaveLength(0);
    await replaceCompanyMaster('ITRI',[person({nationalId:' a123456789 '})]);
    const stored=await lookupCompanyMaster('ITRI',{nationalId:'A123456789'});expect(stored?.nationalId).toBe('A123456789');
    await updateMasterPerson(stored!.id!,{nationalId:' b234567890 '});
    expect(await lookupCompanyMaster('ITRI',{nationalId:'B234567890'})).toMatchObject({id:stored?.id});
    expect(await lookupCompanyMaster('ITRI',{nationalId:'A123456789'})).toBeNull();
  });

  it('鎖定大名單仍可人工單筆新增與並發重試，鎖定資料完全不變',async()=>{
    await replaceCompanyMaster('ITRI',[person()]);const settings=await rosterDb.companySettings.get('ITRI');
    const next=person({employeeNo:'00999',nationalId:'B234567890',name:'新進人員',originalActivity:'',extension:''});
    const [first,retry]=await Promise.all([ensureCompanyMasterPerson(next),ensureCompanyMasterPerson(next)]);
    expect(first.id).toBe(retry.id);expect(await rosterDb.masterPeople.count()).toBe(2);
    expect(await rosterDb.companySettings.get('ITRI')).toEqual(settings);expect(await isCompanyMasterLocked('itri')).toBe(true);
    expect(first).toMatchObject({originalActivity:'一般',extension:''});
  });

  it('既有人員不被人工重試覆寫，身分衝突不寫入',async()=>{
    const stored=await ensureCompanyMasterPerson(person());
    expect(await ensureCompanyMasterPerson(person({item:'人工填入另一項目',gender:'女',extension:''}))).toEqual(stored);
    await expect(ensureCompanyMasterPerson(person({nationalId:'B234567890'}))).rejects.toThrow('此工號已存在');
    await expect(ensureCompanyMasterPerson(person({employeeNo:'99999'}))).rejects.toThrow('此身分證已存在');
    await expect(ensureCompanyMasterPerson(person({name:'另一人'}))).rejects.toThrow('人員資料不同');
    expect(await rosterDb.masterPeople.count()).toBe(1);expect(await lookupCompanyMaster('ITRI',{employeeNo:'00125'})).toEqual(stored);
  });

  it.each(['employeeNo','name','gender','item'] as const)('人工新增必要欄位 %s 空白時拒絕且不改lock',async field=>{
    await setCompanyMasterLocked('ITRI',false);const settings=await rosterDb.companySettings.get('ITRI');
    await expect(ensureCompanyMasterPerson(person({[field]:'　 '}))).rejects.toThrow('皆為必填');
    expect(await rosterDb.masterPeople.count()).toBe(0);expect(await rosterDb.companySettings.get('ITRI')).toEqual(settings);
  });

  it('完整ID格式必要、選填分機可空、normalize不修改來源物件',()=>{
    expect(()=>validateManualMasterPerson(person({nationalId:'A123'}))).toThrow('完整且格式正確');
    const source=person({employeeNo:' 00125 ',nationalId:' a123456789 ',extension:' ',originalActivity:''});
    const before=structuredClone(source);
    expect(validateManualMasterPerson(source)).toMatchObject({employeeNo:'00125',nationalId:'A123456789',extension:'',originalActivity:'一般'});
    expect(source).toEqual(before);
  });
});

describe('Company Master v7 index upgrade',()=>{
  it('v6升級保留所有人員主鍵/metadata、整理後排程及鎖定，只normalize ID新增index',async()=>{
    const name=`master-index-upgrade-${crypto.randomUUID()}`;const legacy=new Dexie(name);
    legacy.version(6).stores({masterPeople:'++id, companyKey, employeeNo, name, [companyKey+employeeNo]',preparedPeople:'localId, sessionId, employeeNo, nationalId',companySettings:'companyKey'});
    await legacy.open();const old=person({id:91,nationalId:' a123456789 '});
    const prepared={...makePreparedFromMaster(old,'2026-10-07','07:30~08:00',1),sessionId:'legacy-session'};
    const lock={companyName:'ITRI',companyKey:'ITRI',masterLocked:true,updatedAt:'2026-01-01T00:00:00Z'};
    await legacy.table('masterPeople').add(old);await legacy.table('preparedPeople').add(prepared);await legacy.table('companySettings').put(lock);legacy.close();
    const upgraded=new RosterDatabase(name);
    try{
      await upgraded.open();expect(upgraded.verno).toBe(7);
      expect(await upgraded.masterPeople.where('[companyKey+nationalId]').equals(['ITRI','A123456789']).toArray()).toEqual([{...old,nationalId:'A123456789'}]);
      expect(await upgraded.preparedPeople.get(prepared.localId)).toEqual(prepared);
      expect(await upgraded.companySettings.get('ITRI')).toEqual(lock);
      expect(upgraded.tables.map(table=>table.name).sort()).toEqual(['companySettings','masterPeople','preparedPeople']);
      upgraded.close();await upgraded.open();expect(await upgraded.masterPeople.get(91)).toEqual({...old,nationalId:'A123456789'});
    }finally{upgraded.close();await Dexie.delete(name);}
  });
});
