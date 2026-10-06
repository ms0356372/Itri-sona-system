import Dexie,{type EntityTable} from 'dexie';
import {normalizeCompanyName} from '../../lib/company';
import {normalizeNationalId} from '../../lib/privacy';
import {assertCompleteImportedPeople,assertUniqueImportedEmployees,previewCompanyMasterUpdate,type MasterUpdateSummary} from './masterImport';
import type {MasterPerson,PreparedPerson} from './types';

export type StoredPreparedPerson=PreparedPerson&{sessionId:string};
export type CompanyRosterSettings={companyName:string;companyKey:string;masterLocked:boolean;updatedAt:string};

export class RosterDatabase extends Dexie {
  masterPeople!:EntityTable<MasterPerson,'id'>;
  preparedPeople!:EntityTable<StoredPreparedPerson,'localId'>;
  companySettings!:EntityTable<CompanyRosterSettings,'companyKey'>;
  constructor(name='itri-sona-registration'){
    super(name);
    this.version(1).stores({masterPeople:'++id, companyName, employeeNo, name, [companyName+employeeNo]'});
    this.version(2).stores({masterPeople:'++id, companyName, employeeNo, name, [companyName+employeeNo]',preparedPeople:'localId, sessionId, employeeNo, nationalId'});
    this.version(3).stores({masterPeople:'++id, companyName, employeeNo, name, [companyName+employeeNo]',preparedPeople:'localId, sessionId, employeeNo, nationalId',companySettings:'companyName'});
    this.version(4).stores({masterPeople:'++id, companyKey, employeeNo, name, [companyKey+employeeNo]',preparedPeople:'localId, sessionId, employeeNo, nationalId',companySettings:'companyName',companySettingsByKey:'companyKey'}).upgrade(async transaction=>{
      await transaction.table<MasterPerson>('masterPeople').toCollection().modify(person=>{person.companyKey=normalizeCompanyName(person.companyName);});
      const settings=await transaction.table<CompanyRosterSettings>('companySettings').toArray();
      const merged=new Map<string,CompanyRosterSettings>();
      for(const setting of settings){
        const companyKey=normalizeCompanyName(setting.companyName);
        const prior=merged.get(companyKey);
        merged.set(companyKey,{companyName:prior?.companyName??setting.companyName,companyKey,masterLocked:Boolean(prior?.masterLocked||setting.masterLocked),updatedAt:prior&&prior.updatedAt>setting.updatedAt?prior.updatedAt:setting.updatedAt});
      }
      await transaction.table('companySettingsByKey').bulkPut([...merged.values()]);
    });
    // Dexie cannot change a primary key in place. Preserve the rows in a temporary
    // store, remove the legacy store, then recreate it with companyKey as its key.
    this.version(5).stores({companySettings:null});
    this.version(6).stores({companySettings:'companyKey',companySettingsByKey:null}).upgrade(async transaction=>{
      const settings=await transaction.table<CompanyRosterSettings>('companySettingsByKey').toArray();
      await transaction.table('companySettings').bulkPut(settings);
    });
  }
}

export const rosterDb=new RosterDatabase();

export async function replaceCompanyMaster(companyName:string,people:MasterPerson[]){
  const companyKey=normalizeCompanyName(companyName);
  assertUniqueImportedEmployees(people);
  assertCompleteImportedPeople(people);
  await rosterDb.transaction('rw',[rosterDb.masterPeople,rosterDb.companySettings],async()=>{await rosterDb.masterPeople.where('companyKey').equals(companyKey).delete();await rosterDb.masterPeople.bulkAdd(people.map(person=>({...person,companyName,companyKey})));await rosterDb.companySettings.put({companyName,companyKey,masterLocked:true,updatedAt:new Date().toISOString()});});
}
export async function mergeCompanyMaster(companyName:string,people:MasterPerson[]):Promise<MasterUpdateSummary>{
  assertUniqueImportedEmployees(people);
  assertCompleteImportedPeople(people);
  const companyKey=normalizeCompanyName(companyName);
  return rosterDb.transaction('rw',[rosterDb.masterPeople,rosterDb.companySettings],async()=>{
    const existing=await rosterDb.masterPeople.where('companyKey').equals(companyKey).toArray();
    const byEmployee=new Map<string,MasterPerson>();
    for(const person of existing){
      if(byEmployee.has(person.employeeNo))throw new Error(`目前公司大名單有重複工號：${person.employeeNo}，請至名單管理確認後重新匯入。`);
      byEmployee.set(person.employeeNo,person);
    }
    const summary=previewCompanyMasterUpdate(existing,people);
    const now=new Date().toISOString();
    for(const person of people){
      const prior=byEmployee.get(person.employeeNo);
      const next:MasterPerson={...person,companyName,companyKey,nationalId:normalizeNationalId(person.nationalId),updatedAt:now};
      if(prior){
        next.id=prior.id;
        next.extension=person.extension.trim()?person.extension:prior.extension;
        await rosterDb.masterPeople.put(next);
      }else{
        delete next.id;
        await rosterDb.masterPeople.add(next);
      }
    }
    await rosterDb.companySettings.put({companyName,companyKey,masterLocked:true,updatedAt:now});
    return summary;
  });
}
export const getCompanyMaster=(companyName:string)=>rosterDb.masterPeople.where('companyKey').equals(normalizeCompanyName(companyName)).toArray();
export const getCompanyMasterLockState=async(companyName:string)=>(await rosterDb.companySettings.get(normalizeCompanyName(companyName)))?.masterLocked;
export const isCompanyMasterLocked=async(companyName:string)=>(await rosterDb.companySettings.get(normalizeCompanyName(companyName)))?.masterLocked??false;
export const setCompanyMasterLocked=async(companyName:string,masterLocked:boolean)=>rosterDb.companySettings.put({companyName,companyKey:normalizeCompanyName(companyName),masterLocked,updatedAt:new Date().toISOString()});
export const addMasterPerson=(person:MasterPerson)=>rosterDb.masterPeople.add({...person,companyKey:normalizeCompanyName(person.companyName)});
export const updateMasterPerson=async(id:number,changes:Partial<MasterPerson>)=>{const existing=await rosterDb.masterPeople.get(id);const companyName=changes.companyName??existing?.companyName;return rosterDb.masterPeople.update(id,{...changes,...(companyName?{companyKey:normalizeCompanyName(companyName)}:{}),updatedAt:new Date().toISOString()});};
export const clearCompanyMaster=async(companyName:string)=>{const companyKey=normalizeCompanyName(companyName);return rosterDb.transaction('rw',[rosterDb.masterPeople,rosterDb.companySettings],async()=>{await rosterDb.masterPeople.where('companyKey').equals(companyKey).delete();await rosterDb.companySettings.delete(companyKey);});};
export async function replacePreparedSchedule(sessionId:string,people:PreparedPerson[]){
  await rosterDb.transaction('rw',rosterDb.preparedPeople,async()=>{await rosterDb.preparedPeople.where('sessionId').equals(sessionId).delete();await rosterDb.preparedPeople.bulkPut(people.map(person=>({...person,sessionId})));});
}
export async function getPreparedSchedule(sessionId:string):Promise<PreparedPerson[]>{
  const rows=await rosterDb.preparedPeople.where('sessionId').equals(sessionId).sortBy('sequence');
  return rows.map(row=>{const person={...row};delete (person as Partial<StoredPreparedPerson>).sessionId;return person;});
}
const sameIdentity=(left:Pick<PreparedPerson,'employeeNo'|'nationalId'|'name'>,right:Pick<PreparedPerson,'employeeNo'|'nationalId'|'name'>)=>left.employeeNo===right.employeeNo&&normalizeNationalId(left.nationalId)===normalizeNationalId(right.nationalId)&&left.name.trim()===right.name.trim();
const withoutSessionId=(row:StoredPreparedPerson):PreparedPerson=>{const person={...row};delete (person as Partial<StoredPreparedPerson>).sessionId;return person;};

/** Appends one person atomically and reuses their original local row on retry. */
export async function addPreparedPerson(sessionId:string,person:PreparedPerson,master?:MasterPerson):Promise<PreparedPerson>{
  if(!sessionId||!person.employeeNo.trim()||!person.name.trim()||!normalizeNationalId(person.nationalId))throw new Error('新增受檢者缺少場次、工號、姓名或身分證資料。');
  return rosterDb.transaction('rw',[rosterDb.preparedPeople,rosterDb.masterPeople],async()=>{
    const existing=await rosterDb.preparedPeople.where('sessionId').equals(sessionId).toArray();
    const employeeMatches=existing.filter(row=>row.employeeNo===person.employeeNo);
    const nationalIdMatches=existing.filter(row=>normalizeNationalId(row.nationalId)===normalizeNationalId(person.nationalId));
    if(employeeMatches.length>1||nationalIdMatches.length>1)throw new Error('同一身分證或工號對應多筆今日資料，請工作人員確認排程。');
    if(employeeMatches.some(row=>!sameIdentity(row,person)))throw new Error('此工號已存在於今日排程，請確認人員資料。');
    if(nationalIdMatches.some(row=>row.employeeNo!==person.employeeNo))throw new Error('此身分證已存在於今日排程，請確認人員資料。');

    let newMaster:MasterPerson|undefined;
    if(master){
      if(!sameIdentity(master,person))throw new Error('公司大名單與今日排程的人員資料不一致，請確認人員資料。');
      const companyKey=normalizeCompanyName(master.companyName);
      const companyPeople=await rosterDb.masterPeople.where('companyKey').equals(companyKey).toArray();
      const matches=companyPeople.filter(row=>row.employeeNo===master.employeeNo);
      const masterIdMatches=companyPeople.filter(row=>normalizeNationalId(row.nationalId)===normalizeNationalId(master.nationalId));
      if(masterIdMatches.length>1)throw new Error('公司大名單中此身分證對應多筆人員，請至名單管理確認。');
      if(matches.length>1)throw new Error('公司大名單中此工號對應多筆人員，請至名單管理確認。');
      if(matches.some(row=>!sameIdentity(row,master)))throw new Error('此工號已存在於公司大名單且人員資料不同，請確認人員資料。');
      if(masterIdMatches.some(row=>row.employeeNo!==master.employeeNo))throw new Error('此身分證已存在於公司大名單，請確認人員資料。');
      if(!matches.length){
        newMaster={...master,companyKey,nationalId:normalizeNationalId(master.nationalId),originalActivity:master.originalActivity.trim()||master.item,updatedAt:new Date().toISOString()};
        delete newMaster.id;
      }
    }

    const prior=employeeMatches[0];
    const next=prior?withoutSessionId(prior):{...person,nationalId:normalizeNationalId(person.nationalId),sequence:existing.reduce((max,row)=>Math.max(max,row.sequence),0)+1};
    if(!prior)await rosterDb.preparedPeople.add({...next,sessionId});
    if(newMaster)await rosterDb.masterPeople.add(newMaster);
    return next;
  });
}
/** Removes only one day's locally prepared schedule. Company master data and its lock are untouched. */
export const clearPreparedSchedule=(sessionId:string)=>rosterDb.preparedPeople.where('sessionId').equals(sessionId).delete();
