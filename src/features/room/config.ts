/** One shared definition for the supported ultrasound room range. */
export const MIN_ROOM_COUNT=1;
export const MAX_ROOM_COUNT=8;
export const DEFAULT_ROOM_COUNT=4;

export function isValidRoomCount(value:unknown):value is number{
  return typeof value==='number'&&Number.isInteger(value)&&value>=MIN_ROOM_COUNT&&value<=MAX_ROOM_COUNT;
}

/** Legacy sessions without a configured count retain the original four rooms. */
export function getRoomCount(value?:number|null):number{
  return isValidRoomCount(value)?value:DEFAULT_ROOM_COUNT;
}
export const resolveRoomCount=getRoomCount;

export function getRoomIds(roomCount?:number|null):string[]{
  return Array.from({length:getRoomCount(roomCount)},(_,index)=>`診間 ${index+1}`);
}

export function getRoomNumber(value?:string|null):number|null{
  if(typeof value!=='string')return null;
  const match=value.trim().match(/^(?:診間\s*|room_)([1-9]\d*)$/);
  if(!match)return null;
  const number=Number(match[1]);
  return Number.isSafeInteger(number)?number:null;
}

export function normalizeRoomId(value:string):string{
  const number=getRoomNumber(value);
  return number===null?value.trim():`診間 ${number}`;
}

export function isRoomEnabled(roomId?:string|null,roomCount?:number|null):boolean{
  const number=getRoomNumber(roomId);
  return number!==null&&number>=MIN_ROOM_COUNT&&number<=getRoomCount(roomCount);
}

export function getRoomAliases(roomId:string):string[]{
  const number=getRoomNumber(roomId);
  return number===null?[normalizeRoomId(roomId)]:[`診間 ${number}`,`診間${number}`,`room_${number}`];
}
