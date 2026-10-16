import type {GroupCode,Participant} from '../../types';
import {taiwanMinutesAt} from '../../lib/time';
export const SLOT_GROUP:Record<string,GroupCode>={'07:30~08:00':'A','08:00~08:30':'B','08:30~09:00':'C','09:00~09:30':'D','09:30~10:00':'E','10:00~10:30':'F','10:30~11:00':'G'};
export const normalizeSlot=(v:unknown)=>String(v??'').trim().replace(/[～〜－—–-]/g,'~').replace(/\s/g,'');
export const groupForSlot=(v:unknown)=>SLOT_GROUP[normalizeSlot(v)]??null;

// Derive both order and time bounds from the existing schedule definition.
const minutesInClock=(clock:string)=>{const[hour,minute]=clock.split(':').map(Number);return hour*60+minute;};
const scheduleGroups=Object.entries(SLOT_GROUP).map(([slot,group])=>({group,start:minutesInClock(slot.split('~')[0])})).sort((left,right)=>left.start-right.start);
const groupRank=(group:GroupCode|null)=>group===null?null:scheduleGroups.findIndex(item=>item.group===group);

/** Classify only the saved database check-in timestamp; time passing changes nothing. */
export function actualCheckinGroup(checkedInAt:string|null|undefined):GroupCode|null{
  const minute=taiwanMinutesAt(checkedInAt);
  if(minute===null)return null;
  for(let index=scheduleGroups.length-1;index>0;index--){
    if(minute>=scheduleGroups[index].start)return scheduleGroups[index].group;
  }
  return scheduleGroups[0].group;
}

export function effectiveQueueGroup(person:Pick<Participant,'groupCode'|'slot'|'checkedInAt'>):GroupCode|null{
  const scheduled=scheduleGroups.some(item=>item.group===person.groupCode)?person.groupCode:groupForSlot(person.slot);
  const actual=actualCheckinGroup(person.checkedInAt);
  if(scheduled===null||actual===null)return null;
  return scheduleGroups[Math.max(groupRank(scheduled)!,groupRank(actual)!)].group;
}

export type StandardBaseQueuePerson=Pick<Participant,'id'|'sequence'|'slot'|'groupCode'|'checkinNo'|'checkinSequence'|'status'|'checkedInAt'>;
const compareOptionalNumber=(left:number|null,right:number|null)=>left===right?0:left===null?1:right===null?-1:left-right;
const safePositiveInteger=(value:number|null|undefined)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0?value:null;
const checkinSuffix=(value:string|null)=>safePositiveInteger(Number(value?.match(/(\d+)\s*$/)?.[1]));
const timestampValue=(value:string|null)=>value&&taiwanMinutesAt(value)!==null?Date.parse(value):null;
const submillisecond=(value:string|null)=>(value?.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/i)?.[1]??'').slice(3).padEnd(6,'0');

/** PostgreSQL timestamps can include microseconds that Date.parse alone truncates. */
export function compareServerTimestamps(left:string|null,right:string|null):number{
  const leftValue=timestampValue(left);const rightValue=timestampValue(right);
  const compared=compareOptionalNumber(leftValue,rightValue);
  if(compared||leftValue===null)return compared;
  const leftFraction=submillisecond(left);const rightFraction=submillisecond(right);
  return leftFraction===rightFraction?0:leftFraction<rightFraction?-1:1;
}

export function compareStandardBaseQueue(left:StandardBaseQueuePerson,right:StandardBaseQueuePerson):number{
  return compareOptionalNumber(groupRank(effectiveQueueGroup(left)),groupRank(effectiveQueueGroup(right)))
    ||compareServerTimestamps(left.checkedInAt,right.checkedInAt)
    ||compareOptionalNumber(safePositiveInteger(left.checkinSequence),safePositiveInteger(right.checkinSequence))
    ||compareOptionalNumber(checkinSuffix(left.checkinNo),checkinSuffix(right.checkinNo))
    ||compareOptionalNumber(Number.isFinite(left.sequence)?left.sequence:null,Number.isFinite(right.sequence)?right.sequence:null)
    ||(left.id===right.id?0:left.id<right.id?-1:1);
}

export function buildStandardBaseQueue<T extends StandardBaseQueuePerson>(people:readonly T[]):T[]{
  return people.filter(person=>person.status==='等候中').sort(compareStandardBaseQueue);
}
