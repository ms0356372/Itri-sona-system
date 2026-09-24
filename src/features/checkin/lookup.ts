import {normalizeNationalId} from '../../lib/privacy';
import type {Participant} from '../../types';
import type {PreparedPerson} from '../roster/types';

/** Complete Taiwan national/resident ID formats accepted by the workstation. */
export const isCompleteNationalId=(value:string)=>/^[A-Z](?:[1289]\d{8}|[A-D]\d{8})$/.test(normalizeNationalId(value));

export type LocalLookup={kind:'found';employeeNo:string}|{kind:'not_scheduled'}|{kind:'duplicate'};
export function findScheduledEmployee(rows:PreparedPerson[],nationalId:string):LocalLookup{
  const normalized=normalizeNationalId(nationalId);
  const matches=rows.filter(row=>normalizeNationalId(row.nationalId)===normalized);
  if(matches.length>1)return{kind:'duplicate'};
  return matches.length===1?{kind:'found',employeeNo:matches[0].employeeNo}:{kind:'not_scheduled'};
}

export function matchCloudParticipant(rows:Participant[],employeeNo:string):Participant|null{
  return rows.find(row=>row.employeeNo===employeeNo)??null;
}
