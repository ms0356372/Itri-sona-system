import {normalizeCompanyName} from '../../lib/company';
import {normalizeNationalId} from '../../lib/privacy';
import {manualIdentityError,normalizeManualFields} from '../checkin/manual';
import {addMasterPerson,rosterDb} from './db';
import type {MasterPerson} from './types';

export type MasterLookup={nationalId:string;employeeNo?:never}|{employeeNo:string;nationalId?:never};

const unique=(rows:MasterPerson[],label:string):MasterPerson|null=>{
  if(rows.length>1)throw new Error(`公司大名單中此${label}對應多筆人員，請至名單管理確認。`);
  return rows[0]??null;
};

/** Exact compound-index lookups materialize at most two rows, never the roster. */
export async function lookupCompanyMaster(companyName:string,lookup:MasterLookup):Promise<MasterPerson|null>{
  const companyKey=normalizeCompanyName(companyName);
  if(!companyKey)return null;
  if(lookup.nationalId!==undefined){
    const id=normalizeNationalId(lookup.nationalId);if(!id)return null;
    return unique(await rosterDb.masterPeople.where('[companyKey+nationalId]').equals([companyKey,id]).limit(2).toArray(),'身分證');
  }
  const employeeNo=lookup.employeeNo.trim();if(!employeeNo)return null;
  return unique(await rosterDb.masterPeople.where('[companyKey+employeeNo]').equals([companyKey,employeeNo]).limit(2).toArray(),'工號');
}

/** Manual entries have their own defaults; formal file imports stay strict. */
export function validateManualMasterPerson(person:MasterPerson):MasterPerson{
  const normalized=normalizeManualFields(person);
  const next={...normalized,companyName:person.companyName.trim(),companyKey:normalizeCompanyName(person.companyName),
    nationalId:normalizeNationalId(person.nationalId),originalActivity:person.originalActivity.trim()||normalized.item};
  if(!next.companyKey)throw new Error('請先選擇目前公司的有效場次。');
  const identityError=manualIdentityError(next);
  if(identityError)throw new Error(identityError);
  return next;
}

/** One-person manual addition is atomic and never changes the master lock. */
export async function ensureCompanyMasterPerson(person:MasterPerson):Promise<MasterPerson>{
  const next=validateManualMasterPerson(person);
  return rosterDb.transaction('rw',rosterDb.masterPeople,async()=>{
    const [employeeMatch,idMatch]=await Promise.all([
      lookupCompanyMaster(next.companyName,{employeeNo:next.employeeNo}),
      lookupCompanyMaster(next.companyName,{nationalId:next.nationalId}),
    ]);
    if(employeeMatch&&(normalizeNationalId(employeeMatch.nationalId)!==next.nationalId||employeeMatch.name.trim()!==next.name))
      throw new Error('此工號已存在於公司大名單且人員資料不同，請確認人員資料。');
    if(idMatch&&idMatch.employeeNo!==next.employeeNo)throw new Error('此身分證已存在於公司大名單，請確認人員資料。');
    if(employeeMatch)return employeeMatch;
    const stored={...next,updatedAt:new Date().toISOString()};delete stored.id;
    const id=await addMasterPerson(stored);
    return{...stored,id};
  });
}
