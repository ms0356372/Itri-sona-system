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

/** A check-in timestamp is also authoritative if an older record has no number. */
export function isAlreadyCheckedIn(participant:Participant):boolean{
  return Boolean(participant.checkinNo||participant.checkedInAt);
}

export function repeatCheckinMessage(participant:Participant):string|null{
  if(participant.status==='已完成')return '此受檢者已完成檢查。';
  if(!isAlreadyCheckedIn(participant))return null;
  return participant.checkinNo
    ?`此受檢者已報到，報到編號：${participant.checkinNo}，無須重複報到。`
    :'此受檢者已有報到紀錄，無須重複報到。';
}
