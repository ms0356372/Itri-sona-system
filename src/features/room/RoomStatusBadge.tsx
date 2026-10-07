import type {RoomStatus} from '../../types';
import {roomStatusBadgeClasses,roomStatusDotClasses,roomStatusLabels} from './status';

export function RoomStatusBadge({status,loading=false}:{status?:RoomStatus|null;loading?:boolean}){
  const known=status&&!loading?status:null;
  const label=known?roomStatusLabels[known]:loading?'讀取中':'狀態未確認';
  return <span role="status" className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-bold ${known?roomStatusBadgeClasses[known]:'bg-slate-100 text-slate-600'}`}><span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${known?roomStatusDotClasses[known]:'bg-slate-400'}`}/>{label}</span>;
}
