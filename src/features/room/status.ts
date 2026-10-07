import type {RoomStatus} from '../../types';

export const roomIds=['診間 1','診間 2','診間 3','診間 4'] as const;
export const roomStatusLabels:Record<RoomStatus,string>={idle:'空閒',in_progress:'檢查中',away:'暫時離開'};
export const roomStatusDotClasses:Record<RoomStatus,string>={idle:'bg-emerald-400',in_progress:'bg-red-400',away:'bg-yellow-400'};
export const roomStatusBadgeClasses:Record<RoomStatus,string>={idle:'bg-emerald-50 text-emerald-900',in_progress:'bg-red-50 text-red-900',away:'bg-yellow-100 text-yellow-950'};

export function isRoomStatus(value:unknown):value is RoomStatus{return value==='idle'||value==='in_progress'||value==='away';}
export function canReceivePatient(status:RoomStatus|null|undefined):boolean{return status==='idle';}
export function normalizeRoomId(value:string):string{
  const trimmed=value.trim();
  const number=trimmed.match(/^診間\s*([1-4])$/)?.[1];
  return number?`診間 ${number}`:trimmed;
}
