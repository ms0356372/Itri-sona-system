import type {RoomStatus} from '../../types';
import {getRoomIds} from './config';
export {MIN_ROOM_COUNT,MAX_ROOM_COUNT,DEFAULT_ROOM_COUNT,getRoomCount,resolveRoomCount,getRoomIds,isValidRoomCount,getRoomNumber,normalizeRoomId,isRoomEnabled,getRoomAliases} from './config';

/** Legacy consumers retain a default list; session UIs use getRoomIds(roomCount). */
export const roomIds=getRoomIds();
export const roomStatusLabels:Record<RoomStatus,string>={idle:'空閒',in_progress:'檢查中',away:'暫時離開'};
export const roomStatusDotClasses:Record<RoomStatus,string>={idle:'bg-emerald-400',in_progress:'bg-red-400',away:'bg-yellow-400'};
export const roomStatusBadgeClasses:Record<RoomStatus,string>={idle:'bg-emerald-50 text-emerald-900',in_progress:'bg-red-50 text-red-900',away:'bg-yellow-100 text-yellow-950'};

export function isRoomStatus(value:unknown):value is RoomStatus{return value==='idle'||value==='in_progress'||value==='away';}
export function canReceivePatient(status:RoomStatus|null|undefined):boolean{return status==='idle';}
