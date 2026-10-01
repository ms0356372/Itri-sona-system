import Dexie,{type EntityTable} from 'dexie';
import {normalizeCompanyName} from '../../lib/company';
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
  await rosterDb.transaction('rw',[rosterDb.masterPeople,rosterDb.companySettings],async()=>{await rosterDb.masterPeople.where('companyKey').equals(companyKey).delete();await rosterDb.masterPeople.bulkAdd(people.map(person=>({...person,companyKey})));await rosterDb.companySettings.put({companyName,companyKey,masterLocked:true,updatedAt:new Date().toISOString()});});
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
/** Removes only one day's locally prepared schedule. Company master data and its lock are untouched. */
export const clearPreparedSchedule=(sessionId:string)=>rosterDb.preparedPeople.where('sessionId').equals(sessionId).delete();
