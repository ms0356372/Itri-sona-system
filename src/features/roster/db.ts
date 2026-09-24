import Dexie,{type EntityTable} from 'dexie';
import type {MasterPerson,PreparedPerson} from './types';

export type StoredPreparedPerson=PreparedPerson&{sessionId:string};
export type CompanyRosterSettings={companyName:string;masterLocked:boolean;updatedAt:string};

class RosterDatabase extends Dexie {
  masterPeople!:EntityTable<MasterPerson,'id'>;
  preparedPeople!:EntityTable<StoredPreparedPerson,'localId'>;
  companySettings!:EntityTable<CompanyRosterSettings,'companyName'>;
  constructor(){super('itri-sona-registration');this.version(1).stores({masterPeople:'++id, companyName, employeeNo, name, [companyName+employeeNo]'});this.version(2).stores({masterPeople:'++id, companyName, employeeNo, name, [companyName+employeeNo]',preparedPeople:'localId, sessionId, employeeNo, nationalId'});this.version(3).stores({masterPeople:'++id, companyName, employeeNo, name, [companyName+employeeNo]',preparedPeople:'localId, sessionId, employeeNo, nationalId',companySettings:'companyName'});}
}

export const rosterDb=new RosterDatabase();

export async function replaceCompanyMaster(companyName:string,people:MasterPerson[]){
  await rosterDb.transaction('rw',[rosterDb.masterPeople,rosterDb.companySettings],async()=>{await rosterDb.masterPeople.where('companyName').equals(companyName).delete();await rosterDb.masterPeople.bulkAdd(people);await rosterDb.companySettings.put({companyName,masterLocked:true,updatedAt:new Date().toISOString()});});
}
export const getCompanyMaster=(companyName:string)=>rosterDb.masterPeople.where('companyName').equals(companyName).toArray();
export const getCompanyMasterLockState=async(companyName:string)=>(await rosterDb.companySettings.get(companyName))?.masterLocked;
export const isCompanyMasterLocked=async(companyName:string)=>(await rosterDb.companySettings.get(companyName))?.masterLocked??false;
export const setCompanyMasterLocked=async(companyName:string,masterLocked:boolean)=>rosterDb.companySettings.put({companyName,masterLocked,updatedAt:new Date().toISOString()});
export const addMasterPerson=(person:MasterPerson)=>rosterDb.masterPeople.add(person);
export const updateMasterPerson=(id:number,changes:Partial<MasterPerson>)=>rosterDb.masterPeople.update(id,{...changes,updatedAt:new Date().toISOString()});
export const clearCompanyMaster=async(companyName:string)=>rosterDb.transaction('rw',[rosterDb.masterPeople,rosterDb.companySettings],async()=>{await rosterDb.masterPeople.where('companyName').equals(companyName).delete();await rosterDb.companySettings.delete(companyName);});
export async function replacePreparedSchedule(sessionId:string,people:PreparedPerson[]){
  await rosterDb.transaction('rw',rosterDb.preparedPeople,async()=>{await rosterDb.preparedPeople.where('sessionId').equals(sessionId).delete();await rosterDb.preparedPeople.bulkPut(people.map(person=>({...person,sessionId})));});
}
export async function getPreparedSchedule(sessionId:string):Promise<PreparedPerson[]>{
  const rows=await rosterDb.preparedPeople.where('sessionId').equals(sessionId).sortBy('sequence');
  return rows.map(row=>{const person={...row};delete (person as Partial<StoredPreparedPerson>).sessionId;return person;});
}
