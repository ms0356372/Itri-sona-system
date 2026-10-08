import type {Examination,Participant,WorkStatus} from '../../types';
import {getRoomNumber,isRoomEnabled} from '../room/status';
import {compareQueueNumbers,getQueueNumber} from '../workflow/mode';

export type ConsoleSortMode='priority'|'queue'|'room';
export type ConsoleSortDirection='asc'|'desc';

const priorities:Record<WorkStatus,number>={
  '檢查中':0,
  '已叫號':1,
  '等候中':2,
  '上廁所':3,
  '心電圖':4,
  '先做其他':5,
  '未報到':6,
  '已完成':7,
};

export const statusPriority=(status:WorkStatus):number=>priorities[status];

/** Preserve the console's existing displayed-room selection for every status. */
export function getAssignedRoom(person:Pick<Participant,'status'>,rounds:Examination[]):string|null|undefined{
  const active=rounds.find(item=>item.status==='waiting'||item.status==='in_progress');
  const completed=rounds.filter(item=>item.status==='completed');
  return person.status==='檢查中'?rounds.find(item=>item.status==='in_progress')?.roomId:active?.roomId??completed.at(-1)?.roomId;
}

type StandardQueue={group:string;number:number};
function standardQueue(person:Participant):StandardQueue|null{
  const match=person.checkinNo?.match(/^([A-G])([1-9]\d*)$/);
  if(!match)return null;
  const number=Number(match[2]);
  return Number.isSafeInteger(number)?{group:match[1],number}:null;
}

const compareId=(left:string,right:string)=>left===right?0:left<right?-1:1;
const fallback=(left:Participant,right:Participant)=>left.sequence-right.sequence||compareId(left.id,right.id);

function compareQueue(left:Participant,right:Participant,simple:boolean,direction:ConsoleSortDirection):number{
  const sign=direction==='desc'?-1:1;
  if(simple){
    const leftNumber=getQueueNumber(left);const rightNumber=getQueueNumber(right);
    if(leftNumber===null||rightNumber===null){
      if(leftNumber!==rightNumber)return leftNumber===null?1:-1;
      return fallback(left,right);
    }
    return leftNumber!==rightNumber?sign*compareQueueNumbers(left,right):fallback(left,right);
  }
  const leftQueue=standardQueue(left);const rightQueue=standardQueue(right);
  if(!leftQueue||!rightQueue){
    if(Boolean(leftQueue)!==Boolean(rightQueue))return leftQueue?-1:1;
    return fallback(left,right);
  }
  const compared=compareId(leftQueue.group,rightQueue.group)||leftQueue.number-rightQueue.number;
  return compared?sign*compared:fallback(left,right);
}

export function sortConsoleRows(rows:Participant[],options:{simple:boolean;mode:ConsoleSortMode;direction:ConsoleSortDirection;assignedRooms:ReadonlyMap<string,string|null|undefined>;roomCount:number}):Participant[]{
  const {simple,mode,direction,assignedRooms,roomCount}=options;
  const priority=(left:Participant,right:Participant)=>statusPriority(left.status)-statusPriority(right.status)||compareQueue(left,right,simple,'asc');
  return [...rows].sort((left,right)=>{
    if(mode==='priority')return priority(left,right);
    if(mode==='queue')return compareQueue(left,right,simple,direction);
    const leftRoom=assignedRooms.get(left.id);const rightRoom=assignedRooms.get(right.id);
    const leftNumber=isRoomEnabled(leftRoom,roomCount)?getRoomNumber(leftRoom):null;
    const rightNumber=isRoomEnabled(rightRoom,roomCount)?getRoomNumber(rightRoom):null;
    if(leftNumber===null||rightNumber===null){
      if(leftNumber!==rightNumber)return leftNumber===null?1:-1;
    }else if(leftNumber!==rightNumber)return (direction==='desc'?-1:1)*(leftNumber-rightNumber);
    return priority(left,right);
  });
}
