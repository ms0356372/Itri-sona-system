import {useEffect,useRef,useState} from 'react';
import {formatError,formatRoomCountError} from '../../lib/errors';
import {taiwanToday} from '../../lib/time';
import type {Session} from '../../types';
import {getRoomCount,isValidRoomCount} from '../room/status';
import {RoomCountField} from './RoomCountField';
import {updateSessionRoomCount} from './service';

export function SessionRoomCountEditor({session,onSaved}:{session:Session;onSaved:(session:Session)=>Promise<void>}){
  const configuredCount=getRoomCount(session.roomCount);
  const[count,setCount]=useState(configuredCount);
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState('');
  const[notice,setNotice]=useState('');
  const saving=useRef(false);
  const readOnly=session.status!=='active'||session.sessionDate<taiwanToday();

  useEffect(()=>{setCount(configuredCount);setError('');setNotice('');},[session.id,configuredCount]);

  const save=async()=>{
    if(saving.current||readOnly||!isValidRoomCount(count))return;
    saving.current=true;setBusy(true);setError('');setNotice('');
    try{
      const saved=await updateSessionRoomCount(session.id,count);
      setCount(getRoomCount(saved.roomCount));
      try{
        await onSaved(saved);
        setNotice('診間數量已儲存。');
      }catch(reason){
        setError(`診間數量已儲存至雲端，但場次重新載入失敗：${formatError(reason)}。請重新整理頁面。`);
      }
    }catch(reason){
      setError(formatRoomCountError(reason));
    }finally{
      saving.current=false;setBusy(false);
    }
  };

  return <form className="space-y-4 rounded-xl border border-slate-200 p-4" onSubmit={event=>{event.preventDefault();void save();}}>
    <div><h4 className="font-black">編輯場次</h4><p className="mt-1 text-sm text-slate-600">超音波診間：{configuredCount}間</p></div>
    <RoomCountField value={count} disabled={readOnly||busy} onChange={value=>{setCount(value);setError('');setNotice('');}}/>
    {readOnly&&<p className="text-sm text-slate-600">歷史場次、已結束或正在結束的場次，診間數量僅供檢視。</p>}
    {error&&<p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700">{error}</p>}
    {notice&&<p role="status" className="rounded-xl bg-teal-50 p-3 text-sm font-bold text-teal-900">{notice}</p>}
    <button type="submit" className="primary w-full disabled:opacity-40" disabled={readOnly||busy||!isValidRoomCount(count)}>{busy?'正在儲存…':'儲存診間數量'}</button>
  </form>;
}
