import {useEffect,useId,useState} from 'react';
import {AlertTriangle,X} from 'lucide-react';
import type {MasterUpdateSummary} from './masterImport';

export type MasterImportMode='merge'|'replace';
type Props={currentCount:number;incomingCount:number;summary:MasterUpdateSummary;busy:boolean;error:string;onCancel:()=>void;onConfirm:(mode:MasterImportMode)=>void};

export function MasterImportModal({currentCount,incomingCount,summary,busy,error,onCancel,onConfirm}:Props){
  const[mode,setMode]=useState<MasterImportMode>('merge');
  const[replaceConfirmed,setReplaceConfirmed]=useState(false);
  const titleId=useId();
  useEffect(()=>{const cancel=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!busy)onCancel();};document.addEventListener('keydown',cancel);return()=>document.removeEventListener('keydown',cancel);},[busy,onCancel]);
  return <div className="fixed inset-0 z-50 grid bg-slate-950/55 p-3 sm:p-6" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy} onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onCancel();}}>
    <div className="m-auto flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
      <header className="flex items-center justify-between border-b p-4 sm:p-5"><h2 id={titleId} className="text-xl font-black">如何更新公司大名單？</h2><button type="button" className="secondary min-h-10 px-3" disabled={busy} onClick={onCancel} aria-label="關閉"><X/></button></header>
      <div className="space-y-5 overflow-y-auto p-4 sm:p-6">
        <p className="text-sm text-slate-600">新檔案已通過格式檢查。確認更新後才會寫入；取消將保留目前大名單。</p>
        <dl className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-4"><div><dt className="text-sm text-slate-600">目前大名單</dt><dd className="mt-1 text-xl font-black">{currentCount} 人</dd></div><div><dt className="text-sm text-slate-600">本次 Excel</dt><dd className="mt-1 text-xl font-black">{incomingCount} 人</dd></div></dl>
        <fieldset disabled={busy} className="space-y-3"><legend className="mb-2 font-bold">更新方式</legend>
          <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${mode==='merge'?'border-teal-500 bg-teal-50':'border-slate-200'}`}><input type="radio" className="mt-1 h-4 w-4" name={titleId} value="merge" checked={mode==='merge'} onChange={()=>{setMode('merge');setReplaceConfirmed(false);}}/><span><span className="block font-black">增量更新（建議）</span><span className="mt-1 block text-sm text-slate-600">只新增或更新這次 Excel 中的人員，保留未出現在本次 Excel 的舊人員。適合新增／異動人員名單。</span></span></label>
          <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${mode==='replace'?'border-amber-500 bg-amber-50':'border-slate-200'}`}><input type="radio" className="mt-1 h-4 w-4" name={titleId} value="replace" checked={mode==='replace'} onChange={()=>{setMode('replace');setReplaceConfirmed(false);}}/><span><span className="block font-black">整份取代</span><span className="mt-1 block text-sm text-slate-600">以這次 Excel 完整取代目前公司大名單。適合廠商重新提供完整最新版大名單。</span></span></label>
        </fieldset>
        {mode==='merge'?<div className="rounded-xl border border-teal-200 bg-teal-50 p-4"><h3 className="mb-3 font-black">增量更新預估</h3><dl className="grid grid-cols-2 gap-3"><div><dt>新增</dt><dd className="font-bold">{summary.inserted} 人</dd></div><div><dt>更新</dt><dd className="font-bold">{summary.updated} 人</dd></div><div><dt>保留既有人員</dt><dd className="font-bold">{summary.retained} 人</dd></div><div><dt>更新後預估總數</dt><dd className="font-bold">{summary.total} 人</dd></div></dl></div>:<div className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4"><p className="font-bold">整份取代後：{incomingCount} 人</p><p className="flex items-start gap-2 text-amber-900"><AlertTriangle size={20} className="shrink-0"/><span>整份取代會刪除目前大名單中未出現在新 Excel 的人員。</span></p><label className="flex items-start gap-3 font-bold"><input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={replaceConfirmed} disabled={busy} onChange={event=>setReplaceConfirmed(event.target.checked)}/><span>我已確認這份 Excel 是完整大名單，並同意刪除未列入的人員。</span></label></div>}
        {error&&<p role="alert" className="max-h-80 overflow-y-auto whitespace-pre-line break-words rounded-xl border border-red-200 bg-red-50 p-3 text-red-800">{error}</p>}
        <p className="text-sm text-slate-600">更新成功後將自動重新鎖定公司大名單。</p>
        <div className="flex justify-end gap-3"><button type="button" className="secondary" disabled={busy} onClick={onCancel}>取消</button><button type="button" className="primary disabled:opacity-40" disabled={busy||(mode==='replace'&&!replaceConfirmed)} onClick={()=>onConfirm(mode)}>{busy?'處理中……':mode==='merge'?'確認增量更新':'確認整份取代'}</button></div>
      </div>
    </div>
  </div>;
}
