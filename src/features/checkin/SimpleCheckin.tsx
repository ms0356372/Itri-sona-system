import {useEffect,useRef,useState} from 'react';
import type {Participant,Session} from '../../types';
import {normalizeNationalId} from '../../lib/privacy';
import {normalizeCompanyName} from '../../lib/company';
import {lookupCompanyMaster,ensureCompanyMasterPerson,validateManualMasterPerson} from '../roster/lookup';
import type {MasterPerson} from '../roster/types';
import {getQueueNumber,isSimpleSession} from '../workflow/mode';
import {isCompleteNationalId} from './lookup';
import {simpleCheckIn,simpleError,type SimplePerson} from './simpleService';
import {DEFAULT_MANUAL_ITEM,manualIdentityError} from './manual';

type Props={current:Session|null;participants:Participant[];onSuccess:()=>Promise<void>;setNotice:(message:string)=>void};
type NewPerson={nationalId:string;name:string;employeeNo:string;gender:string;item:string;extension:string};
const emptyPerson=():NewPerson=>({nationalId:'',name:'',employeeNo:'',gender:'',item:DEFAULT_MANUAL_ITEM,extension:''});

export function SimpleCheckin({current,participants,onSuccess,setNotice}:Props){
  const[mode,setMode]=useState<'nationalId'|'employeeNo'>('nationalId');
  const[query,setQuery]=useState('');const[candidate,setCandidate]=useState<SimplePerson|null>(null);
  const[result,setResult]=useState<Participant|null>(null);const[repeat,setRepeat]=useState(false);
  const[missing,setMissing]=useState(false);const[error,setError]=useState('');
  const[searching,setSearching]=useState(false);const[busy,setBusy]=useState(false);
  const[adding,setAdding]=useState(false);const[person,setPerson]=useState<NewPerson>(emptyPerson);
  const[fixedNationalId,setFixedNationalId]=useState(false);
  const[addToMaster,setAddToMaster]=useState(false);
  const input=useRef<HTMLInputElement>(null);const mounted=useRef(false);const request=useRef(0);
  const submitting=useRef(false);const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const key=`${current?.id??''}:${current?.companyName??''}`;const activeKey=useRef(key);activeKey.current=key;
  const enabled=Boolean(current&&isSimpleSession(current)&&current.status==='active');
  const active=useRef(enabled);active.current=enabled;
  const isCurrent=()=>mounted.current&&key===activeKey.current&&active.current;
  const valid=(scope:string,generation:number)=>mounted.current&&active.current&&scope===activeKey.current&&generation===request.current;
  const reset=()=>{
    if(!isCurrent())return;
    request.current++;if(timer.current!==null)clearTimeout(timer.current);
    setQuery('');setCandidate(null);setResult(null);setRepeat(false);setMissing(false);setError('');
    setAdding(false);setPerson(emptyPerson());setFixedNationalId(false);setAddToMaster(false);setSearching(false);input.current?.focus();
  };
  useEffect(()=>{
    mounted.current=true;request.current++;
    setMode('nationalId');setQuery('');setCandidate(null);setResult(null);setRepeat(false);setMissing(false);
    setError('');setAdding(false);setPerson(emptyPerson());setFixedNationalId(false);setAddToMaster(false);setSearching(false);setBusy(false);
    return()=>{mounted.current=false;if(timer.current!==null)clearTimeout(timer.current);};
  },[key]);
  const showCandidate=(source:SimplePerson)=>{
    const existing=participants.find(value=>value.sessionId===current?.id&&value.employeeNo===source.employeeNo);
    if(existing&&(existing.name.trim()!==source.name.trim()||existing.gender.trim()!==source.gender.trim())){
      throw new Error('此工號已有報到紀錄，但人員資料不同，請工作人員確認。');
    }
    setCandidate(source);setResult(existing?.checkedInAt?existing:null);setRepeat(Boolean(existing?.checkedInAt));
  };
  const search=async(raw=query)=>{
    if(!current||!isCurrent()||submitting.current)return;
    const value=mode==='nationalId'?normalizeNationalId(raw):raw.trim();
    const generation=++request.current;const scope=key;
    if(timer.current!==null)clearTimeout(timer.current);
    setCandidate(null);setResult(null);setRepeat(false);setMissing(false);setError('');
    if(!value||(mode==='nationalId'&&!isCompleteNationalId(value))){setError(mode==='nationalId'?'請確認完整且格式正確的身分證。':'請輸入工號。');return;}
    setSearching(true);
    try{
      const found=await lookupCompanyMaster(current.companyName,mode==='nationalId'?{nationalId:value}:{employeeNo:value});
      if(!valid(scope,generation))return;
      if(!found){setMissing(true);return;}
      showCandidate(found);
    }catch(reason){if(valid(scope,generation))setError(simpleError(reason));}
    finally{if(valid(scope,generation))setSearching(false);}
  };
  const changeQuery=(raw:string)=>{
    if(!isCurrent())return;
    const value=mode==='nationalId'?normalizeNationalId(raw):raw;
    request.current++;if(timer.current!==null)clearTimeout(timer.current);
    setQuery(value);setCandidate(null);setResult(null);setRepeat(false);setMissing(false);setError('');setSearching(false);
    if(mode==='nationalId'&&isCompleteNationalId(value))timer.current=setTimeout(()=>{void search(value);},100);
  };
  const commit=async(source:SimplePerson,scope:string,generation:number)=>{
    if(!current||!valid(scope,generation))return;
    const participant=await simpleCheckIn(current,source);
    if(!valid(scope,generation))return;
    setCandidate(source);setResult(participant);setRepeat(false);setAdding(false);
    setNotice(`報到完成，${participant.name}，號碼：${participant.checkinNo}。`);
    try{await onSuccess();}
    catch(reason){if(valid(scope,generation))setError(`報到已完成，但名單重新整理失敗：${simpleError(reason)}`);}
  };
  const confirm=async()=>{
    if(!candidate||result?.checkedInAt||!isCurrent()||submitting.current)return;
    submitting.current=true;setBusy(true);setError('');const generation=request.current;const scope=key;
    try{await commit(candidate,scope,generation);}
    catch(reason){if(valid(scope,generation))setError(simpleError(reason));}
    finally{submitting.current=false;if(valid(scope,generation))setBusy(false);}
  };
  const addAndCheckIn=async(event:React.FormEvent)=>{
    event.preventDefault();if(!current||!isCurrent()||submitting.current)return;
    submitting.current=true;setBusy(true);setError('');const generation=request.current;const scope=key;
    try{
      const master:MasterPerson=validateManualMasterPerson({...person,companyName:current.companyName,
        companyKey:normalizeCompanyName(current.companyName),originalActivity:person.item,updatedAt:new Date().toISOString()});
      const source=addToMaster?await ensureCompanyMasterPerson(master):master;
      if(!valid(scope,generation))return;
      await commit(source,scope,generation);
    }catch(reason){if(valid(scope,generation))setError(simpleError(reason));}
    finally{submitting.current=false;if(valid(scope,generation))setBusy(false);}
  };
  const startAdding=()=>{
    if(!isCurrent()||submitting.current)return;
    request.current++;if(timer.current!==null)clearTimeout(timer.current);
    setSearching(false);setCandidate(null);setResult(null);setRepeat(false);setMissing(false);
    setPerson({...emptyPerson(),nationalId:mode==='nationalId'?query:''});
    setFixedNationalId(mode==='nationalId'&&isCompleteNationalId(query));
    setAddToMaster(false);setError('');setAdding(true);
  };
  const complete=manualIdentityError(person)==='';
  const liveResult=result?(participants.find(value=>value.id===result.id)??result):null;
  return <div className="rounded-2xl bg-white p-5 shadow-sm">
    <h3 className="mb-3 font-bold">簡易報到</h3>
    {!current?<div className="grid min-h-36 place-items-center text-slate-400">請先建立或選擇健檢場次。</div>:!enabled?<p role="alert">此場次目前無法報到。</p>:<>
      <div className="mb-3 flex gap-2">{(['nationalId','employeeNo'] as const).map(value=><button type="button" key={value} disabled={busy||adding}
        className={mode===value?'primary flex-1 px-2':'secondary flex-1 px-2'} onClick={()=>{reset();setMode(value);}}>{value==='nationalId'?'身分證':'工號'}</button>)}</div>
      <form onSubmit={event=>{event.preventDefault();void search();}} className="flex flex-wrap gap-2">
        <label className="min-w-0 flex-1"><span className="label">{mode==='nationalId'?'身分證':'工號'}</span>
          <input ref={input} className="input" aria-label={mode==='nationalId'?'簡易報到身分證':'簡易報到工號'} autoComplete="off" disabled={busy||adding} value={query} onChange={event=>changeQuery(event.target.value)}/></label>
        <button disabled={busy||searching||adding} className="secondary self-end">{searching?'查詢中…':'查詢'}</button>
      </form>
      {missing&&<p role="status" className="mt-4 text-amber-800">公司大名單查無此受檢者。</p>}
      {candidate&&<section className="mt-4 space-y-3 rounded-xl bg-slate-50 p-4" aria-label="簡易報到受檢者">
        <h4 className="text-lg font-black">{liveResult?repeat?`${liveResult.name}已完成報到`:'報到完成':'請確認受檢者資料'}</h4>
        <dl className="grid grid-cols-2 gap-2"><dt>姓名</dt><dd>{candidate.name}</dd><dt>工號</dt><dd>{candidate.employeeNo}</dd>
          <dt>性別</dt><dd>{candidate.gender}</dd><dt>項目</dt><dd>{candidate.item}</dd>{candidate.extension&&<><dt>院內分機</dt><dd>{candidate.extension}</dd></>}
          {liveResult&&<><dt>{repeat?'報到號碼':'號碼'}</dt><dd className="text-2xl font-black text-teal-800">{getQueueNumber(liveResult)??liveResult.checkinNo}</dd><dt>目前狀態</dt><dd>{liveResult.status}</dd></>}
        </dl>
        {liveResult?<button type="button" disabled={busy} className="primary" onClick={reset}>掃描下一位</button>:<button type="button" disabled={busy} className="primary" onClick={()=>void confirm()}>{busy?'報到中…':'確認報到'}</button>}
      </section>}
      {!adding&&!liveResult&&<button type="button" className="secondary mt-4" disabled={busy} onClick={startAdding}>新增受檢者</button>}
      {adding&&<form className="mt-4 space-y-3 rounded-xl border p-4" aria-label="簡易模式新增受檢者" onSubmit={event=>void addAndCheckIn(event)}>
        <h4 className="font-black">新增全新人員</h4>
        <div className="grid gap-3 sm:grid-cols-2">{([['nationalId','身分證'],['name','姓名'],['employeeNo','工號'],['gender','性別（選填）'],['item','項目'],['extension','院內分機（選填）']] as const).map(([field,label])=><label key={field} className="block"><span className="label">{label}</span>
          <input className="input" required={field==='nationalId'||field==='name'||field==='employeeNo'} readOnly={field==='nationalId'&&fixedNationalId} aria-label={`新增${label}`} disabled={busy} value={person[field]}
            onChange={event=>{if(field==='nationalId'&&fixedNationalId)return;const value=field==='nationalId'?normalizeNationalId(event.target.value):event.target.value;setPerson(previous=>({...previous,[field]:value}));}}/></label>)}</div>
        <label className="flex items-center gap-2"><input type="checkbox" disabled={busy} checked={addToMaster} onChange={event=>setAddToMaster(event.target.checked)}/>同時加入公司大名單</label>
        <div className="flex gap-2"><button className="secondary" type="button" disabled={busy} onClick={()=>{setAdding(false);setError('');}}>取消</button><button className="primary disabled:opacity-40" disabled={busy||!complete}>{busy?'報到中…':'新增並報到'}</button></div>
      </form>}
    </>}
    {error&&<p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-red-700">{error}</p>}
  </div>;
}
