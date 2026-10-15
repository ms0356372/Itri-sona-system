import {useEffect,useId,useRef,useState} from 'react';
import {formatError} from '../../lib/errors';
import type {Session} from '../../types';
import {getPublicBoardSettings,setPublicBoardEnabled,type PublicBoardSettingsData} from './management';
import {getPublicBoardUrl} from './routing';

export function PublicBoardSettings({session,disabled=false}:{session:Session;disabled?:boolean}){
  const[config,setConfig]=useState<{sessionId:string;settings:PublicBoardSettingsData}|null>(null);
  const[loading,setLoading]=useState(true);
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState('');
  const[reload,setReload]=useState(0);
  const requestVersion=useRef(0);
  const saving=useRef(false);
  const urlId=useId();
  const settings=config?.sessionId===session.id?config.settings:null;

  useEffect(()=>{
    const version=++requestVersion.current;
    saving.current=false;setBusy(false);setLoading(true);setError('');setConfig(null);
    void getPublicBoardSettings(session.id).then(value=>{
      if(requestVersion.current===version)setConfig({sessionId:session.id,settings:value});
    }).catch(reason=>{
      if(requestVersion.current===version)setError(`無法讀取看板設定：${formatError(reason)}`);
    }).finally(()=>{
      if(requestVersion.current===version)setLoading(false);
    });
    return()=>{requestVersion.current=version+1;};
  },[session.id,reload]);

  const toggle=async()=>{
    if(saving.current||loading||disabled||!settings||(!settings.enabled&&session.status!=='active'))return;
    const version=requestVersion.current;
    const sessionId=session.id;
    saving.current=true;setBusy(true);setError('');
    try{
      const saved=await setPublicBoardEnabled(sessionId,!settings.enabled);
      if(requestVersion.current===version)setConfig({sessionId,settings:saved});
    }catch(reason){
      if(requestVersion.current===version)setError(`無法更新看板設定：${formatError(reason)}`);
    }finally{
      if(requestVersion.current===version){saving.current=false;setBusy(false);}
    }
  };

  const url=settings?.enabled&&settings.token?getPublicBoardUrl(settings.token):null;
  return <section className="min-w-0 space-y-3 rounded-xl border border-slate-200 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-black">受檢進度看板</h4>
      {settings&&<span role="status" className={`rounded-full px-3 py-1 text-sm font-bold ${settings.enabled?'bg-emerald-50 text-emerald-800':'bg-slate-100 text-slate-600'}`}>{settings.enabled?'已啟用':'未啟用'}</span>}
    </div>
    <p className="text-sm text-slate-600">提供不需登入的唯讀等候名單，僅顯示工號與遮罩姓名。</p>
    {loading&&<p role="status" className="text-sm text-slate-600">正在讀取看板設定…</p>}
    {error&&<p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700">{error}</p>}
    {!loading&&!settings&&<button type="button" className="secondary w-full disabled:opacity-40" disabled={disabled} onClick={()=>setReload(value=>value+1)}>重新讀取看板設定</button>}
    {settings&&<>
      {url&&<div className="min-w-0 space-y-2">
        <label htmlFor={urlId} className="label">公開看板網址</label>
        <input id={urlId} aria-label="公開看板網址" className="input min-w-0 text-sm" type="url" readOnly value={url}/>
        <a className="secondary w-full" href={url} target="_blank" rel="noopener noreferrer">開啟看板</a>
      </div>}
      {!settings.enabled&&session.status!=='active'&&<p className="text-sm text-slate-600">只有進行中的場次可以啟用公開看板。</p>}
      <button type="button" className="secondary w-full disabled:opacity-40" disabled={disabled||busy||loading||(!settings.enabled&&session.status!=='active')} onClick={()=>void toggle()}>{busy?(settings.enabled?'正在停用…':'正在啟用…'):(settings.enabled?'停用公開看板':'啟用公開看板')}</button>
    </>}
  </section>;
}
