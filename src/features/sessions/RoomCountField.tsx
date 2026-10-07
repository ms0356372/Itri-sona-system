import {useId} from 'react';
import {DEFAULT_ROOM_COUNT,getRoomIds,isValidRoomCount,MAX_ROOM_COUNT,MIN_ROOM_COUNT} from '../room/status';

export function RoomCountField({value,onChange,disabled=false}:{value:number;onChange:(count:number)=>void;disabled?:boolean}){
  const id=useId();
  const valid=isValidRoomCount(value);
  const step=(direction:-1|1)=>onChange(Math.min(MAX_ROOM_COUNT,Math.max(MIN_ROOM_COUNT,(Number.isFinite(value)?Math.trunc(value):DEFAULT_ROOM_COUNT)+direction)));

  return <div className="space-y-2">
    <label htmlFor={id} className="label">超音波診間數量</label>
    <div className="flex items-center gap-2">
      <button type="button" className="secondary px-4 disabled:opacity-40" aria-label="減少超音波診間數量" disabled={disabled||value<=MIN_ROOM_COUNT} onClick={()=>step(-1)}>−</button>
      <input id={id} className="input w-24 text-center font-bold" type="number" min={MIN_ROOM_COUNT} max={MAX_ROOM_COUNT} step={1} required disabled={disabled} value={Number.isFinite(value)?value:''} aria-invalid={!valid} aria-describedby={`${id}-help`} onChange={event=>onChange(event.target.value===''?Number.NaN:Number(event.target.value))}/>
      <button type="button" className="secondary px-4 disabled:opacity-40" aria-label="增加超音波診間數量" disabled={disabled||value>=MAX_ROOM_COUNT} onClick={()=>step(1)}>+</button>
    </div>
    <p id={`${id}-help`} className={valid?'text-sm text-slate-500':'text-sm font-bold text-red-700'}>{valid?`可設定 ${MIN_ROOM_COUNT}～${MAX_ROOM_COUNT} 間。`:`請輸入 ${MIN_ROOM_COUNT}～${MAX_ROOM_COUNT} 的整數診間數量。`}</p>
    {valid&&<div className="rounded-xl bg-teal-50 p-3 text-sm text-teal-900" aria-live="polite"><p className="mb-2 font-bold">將啟用：</p><ul className="flex flex-wrap gap-2">{getRoomIds(value).map(roomId=><li key={roomId} className="rounded-lg bg-white px-3 py-1">{roomId.replace(/\s/g,'')}</li>)}</ul></div>}
  </div>;
}
