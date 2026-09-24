import Dexie,{type EntityTable} from 'dexie';
import type {MasterPerson} from './types';

class RosterDatabase extends Dexie {
  masterPeople!:EntityTable<MasterPerson,'id'>;
  constructor(){super('itri-sona-registration');this.version(1).stores({masterPeople:'++id, companyName, employeeNo, name, [companyName+employeeNo]'});}
}

export const rosterDb=new RosterDatabase();

export async function replaceCompanyMaster(companyName:string,people:MasterPerson[]){
  await rosterDb.transaction('rw',rosterDb.masterPeople,async()=>{await rosterDb.masterPeople.where('companyName').equals(companyName).delete();await rosterDb.masterPeople.bulkAdd(people);});
}
export const getCompanyMaster=(companyName:string)=>rosterDb.masterPeople.where('companyName').equals(companyName).toArray();
export const addMasterPerson=(person:MasterPerson)=>rosterDb.masterPeople.add(person);
export const updateMasterPerson=(id:number,changes:Partial<MasterPerson>)=>rosterDb.masterPeople.update(id,{...changes,updatedAt:new Date().toISOString()});
export const clearCompanyMaster=(companyName:string)=>rosterDb.masterPeople.where('companyName').equals(companyName).delete();
