import type {Examination,Participant,UltrasoundItemName} from '../../types';
import {ultrasoundItemNames} from '../../types';

export const isCheckedIn=(participant:Participant)=>participant.checkedInAt!==null||Boolean(participant.checkinNo?.trim());

const checkinSequence=(value:string|null)=>Number(value?.match(/\d+/)?.[0]??Number.MAX_SAFE_INTEGER);

export function buildCheckinReport(participants:Participant[]){
  const sorted=[...participants].sort((a,b)=>a.slot.localeCompare(b.slot,'zh-TW',{numeric:true})||a.groupCode.localeCompare(b.groupCode)||checkinSequence(a.checkinNo)-checkinSequence(b.checkinNo)||a.sequence-b.sequence);
  return{checkedIn:sorted.filter(isCheckedIn),notCheckedIn:sorted.filter(participant=>!isCheckedIn(participant))};
}

export function formatDuration(seconds:number|null|undefined){
  if(seconds===null||seconds===undefined||!Number.isFinite(seconds)||seconds<0)return '';
  const rounded=Math.round(seconds);const hours=Math.floor(rounded/3600);const minutes=Math.floor((rounded%3600)/60);const remaining=rounded%60;
  return `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(remaining).padStart(2,'0')}`;
}

export const completedForStatistics=(examination:Examination)=>examination.status==='completed'&&examination.completedAt!==null&&examination.durationSeconds!==null;

export function validActualItems(examination:Examination):UltrasoundItemName[]{
  const allowed=new Set<string>(ultrasoundItemNames);
  return examination.actualItems.filter((item):item is UltrasoundItemName=>allowed.has(item));
}

export function calculateEstimatedItemDurations(examination:Examination):Partial<Record<UltrasoundItemName,number>>{
  if(!completedForStatistics(examination))return{};
  const items=validActualItems(examination);if(!items.length)return{};
  const each=examination.durationSeconds!/items.length;
  return Object.fromEntries(items.map(item=>[item,each]));
}

export interface ItemStatistics{count:number;estimatedSeconds:number;averageEstimatedSeconds:number}
export interface ExaminationStatistics{completedPeople:number;completedItems:number;inProgressPeople:number;totalSeconds:number;averageSeconds:number;minimumSeconds:number;maximumSeconds:number;items:Record<UltrasoundItemName,ItemStatistics>}

export function buildExaminationStatistics(examinations:Examination[]):ExaminationStatistics{
  const completed=examinations.filter(completedForStatistics);const participantIds=new Set(completed.map(item=>item.participantId));const durations=completed.map(item=>item.durationSeconds!);
  const items=Object.fromEntries(ultrasoundItemNames.map(item=>[item,{count:0,estimatedSeconds:0,averageEstimatedSeconds:0}])) as Record<UltrasoundItemName,ItemStatistics>;
  for(const examination of completed){for(const [item,seconds] of Object.entries(calculateEstimatedItemDurations(examination)) as [UltrasoundItemName,number][]){items[item].count+=1;items[item].estimatedSeconds+=seconds;}}
  for(const item of ultrasoundItemNames)items[item].averageEstimatedSeconds=items[item].count?items[item].estimatedSeconds/items[item].count:0;
  const totalSeconds=durations.reduce((sum,value)=>sum+value,0);
  return{completedPeople:participantIds.size,completedItems:Object.values(items).reduce((sum,item)=>sum+item.count,0),inProgressPeople:examinations.filter(item=>item.status==='in_progress').length,totalSeconds,averageSeconds:participantIds.size?totalSeconds/participantIds.size:0,minimumSeconds:durations.length?Math.min(...durations):0,maximumSeconds:durations.length?Math.max(...durations):0,items};
}

export function groupExaminationsByRoom(examinations:Examination[]){
  const groups=new Map<string,Examination[]>();
  for(const examination of examinations){if(!examination.roomId)continue;const values=groups.get(examination.roomId)??[];values.push(examination);groups.set(examination.roomId,values);}
  for(const values of groups.values())values.sort((a,b)=>(a.startedAt??'').localeCompare(b.startedAt??''));
  return groups;
}

export function buildUltrasoundSummary(participants:Participant[],examinations:Examination[]){
  const checkin=buildCheckinReport(participants);const byRoom=groupExaminationsByRoom(examinations);
  return{scheduled:participants.length,checkedIn:checkin.checkedIn.length,notCheckedIn:checkin.notCheckedIn.length,overall:buildExaminationStatistics(examinations),rooms:[...byRoom.entries()].sort(([a],[b])=>a.localeCompare(b,'zh-TW',{numeric:true})).map(([roomId,values])=>({roomId,examinations:values,statistics:buildExaminationStatistics(values)}))};
}
