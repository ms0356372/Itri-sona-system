import {useCallback,useEffect,useRef,useState} from 'react';
import type {Session as AuthSession} from '@supabase/supabase-js';
import {Activity,AlertTriangle,ArrowLeft,ClipboardList,FileSpreadsheet,LogOut,Settings,X} from 'lucide-react';
import {isSupabaseConfigured,supabase} from './lib/supabase';
import {signIn,signOut} from './features/auth/service';
import {createSession,listSessions} from './features/sessions/service';
import {RoomCountField} from './features/sessions/RoomCountField';
import {SessionRoomCountEditor} from './features/sessions/SessionRoomCountEditor';
import {DEFAULT_ROOM_COUNT,getRoomCount,isValidRoomCount} from './features/room/status';
import {listParticipants} from './features/schedule/service';
import {RosterManager} from './features/roster/RosterManager';
import {Checkin} from './features/checkin/Checkin';
import {clearPreparedSchedule} from './features/roster/db';
import {UltrasoundConsole} from './features/console/Console';
import {UltrasoundRoom} from './features/room/UltrasoundRoom';
import {RoomStatusOverview} from './features/room/RoomStatusOverview';
import {subscribeSession,subscribeSessions} from './features/sync/realtime';
import {clearSessionSchedule,deleteSession} from './features/sessions/management';
import {cleanupSummary} from './features/cleanup/summary';
import {listExaminations} from './features/examination/service';
import {downloadCheckinReport,downloadUltrasoundReport} from './features/export/sessionExport';
import {buildCheckinReport} from './features/export/statistics';
import type {Participant,Session} from './types';
import {friendlyError} from './lib/errors';
import {canUsePage,firstAllowedPage,getAllowedPages,permissionAccessMessage,type WorkPage} from './features/auth/permissions';
import {useStaffPermissions} from './features/auth/useStaffPermissions';
import {useRoomClaims} from './features/room/useRoomClaims';
import {taiwanToday} from './lib/time';

export default function App(){
  const[auth,setAuth]=useState<AuthSession|null>(null);
  const[checking,setChecking]=useState(true);
  const[sessions,setSessions]=useState<Session[]>([]);
  const[current,setCurrent]=useState<Session|null>(null);
  const[participants,setParticipants]=useState<Participant[]>([]);
  const[notice,setNotice]=useState('');
  const[busy,setBusy]=useState(false);
  const[page,setPage]=useState<WorkPage>('registration');
  const[pageOwner,setPageOwner]=useState<string|null>(null);
  const userId=auth?.user.id??null;
  const access=useStaffPermissions(userId);
  const allowedPages=getAllowedPages(access.permissions);
  const effectivePage=pageOwner===userId&&canUsePage(access.permissions,page)?page:firstAllowedPage(access.permissions);
  // Keep the lease controller outside the permission render guard. A focus
  // check or brief connection failure must not release an otherwise valid lease.
  const leaseContext=useRef<{userId:string;session:Session}|null>(null);
  if(access.ready){
    if(effectivePage==='room'&&userId){
      if(current)leaseContext.current={userId,session:current};
    }else leaseContext.current=null;
  }else if(leaseContext.current?.userId!==userId||(!access.loading&&!access.error))leaseContext.current=null;
  const leaseSession=leaseContext.current?.userId===userId?leaseContext.current.session:null;
  const roomClaims=useRoomClaims(leaseSession?.id??null,leaseSession?.roomCount,localStorage.getItem('itri-ultrasound-room'));
  const sessionRequest=useRef(0);
  const participantRequest=useRef(0);
  const authRequest=useRef(0);
  const activeSessionId=useRef(current?.id??null);activeSessionId.current=current?.id??null;
  const accessKey=[userId,access.ready,access.permissions?.canRegistration,access.permissions?.canConsole,access.permissions?.canRoom].join(':');
  const workAccess=useRef({key:accessKey,userId,ready:access.ready,permissions:access.permissions,version:0});
  if(workAccess.current.key!==accessKey){
    workAccess.current={key:accessKey,userId,ready:access.ready,permissions:access.permissions,version:workAccess.current.version+1};
    sessionRequest.current++;participantRequest.current++;
  }

  const reloadSessions=useCallback(async()=>{
    const context=workAccess.current;
    if(!context.ready)return;
    const request=++sessionRequest.current;
    try{
      const values=await listSessions();
      if(!workAccess.current.ready||context.version!==workAccess.current.version||request!==sessionRequest.current)return;
      if(leaseContext.current&&!values.some(value=>value.id===leaseContext.current?.session.id))leaseContext.current=null;
      setSessions(values);
      setCurrent(previous=>values.find(x=>x.id===previous?.id)??values.find(x=>x.id===leaseContext.current?.session.id)??values.find(x=>x.id===localStorage.getItem('itri-current-session'))??values[0]??null);
    }catch(error){
      if(context.version===workAccess.current.version&&workAccess.current.ready)throw error;
    }
  },[]);
  const reloadParticipants=useCallback(async(session=current)=>{
    const context=workAccess.current;
    if(!context.ready||(session?.id??null)!==activeSessionId.current)return;
    const request=++participantRequest.current;
    try{
      const values=session?await listParticipants(session.id):[];
      if(workAccess.current.ready&&context.version===workAccess.current.version&&request===participantRequest.current&&(session?.id??null)===activeSessionId.current)setParticipants(values);
    }catch(error){
      if(context.version===workAccess.current.version&&workAccess.current.ready&&(session?.id??null)===activeSessionId.current)throw error;
    }
  },[current]);

  useEffect(()=>{
    if(!supabase){setChecking(false);return;}
    let active=true;
    const generation=authRequest.current;
    void supabase.auth.getSession().then(({data})=>{
      if(active&&generation===authRequest.current){setAuth(data.session);setChecking(false);}
    }).catch(error=>{if(active&&generation===authRequest.current){setChecking(false);setNotice(friendlyError(error));}});
    const{data:{subscription}}=supabase.auth.onAuthStateChange((_event,next)=>{
      authRequest.current++;
      if(active){setAuth(next);setChecking(false);}
    });
    return()=>{active=false;subscription.unsubscribe();};
  },[]);
  useEffect(()=>{
    if(!access.ready){setSessions([]);setCurrent(null);setParticipants([]);setNotice('');}
  },[access.ready,userId]);
  useEffect(()=>{
    if(access.ready&&effectivePage){setPage(effectivePage);setPageOwner(userId);}
  },[access.ready,effectivePage,userId]);
  useEffect(()=>{
    if(access.ready)void reloadSessions().catch(error=>setNotice(friendlyError(error)));
  },[access.ready,userId,reloadSessions]);
  useEffect(()=>{
    if(!access.ready)return;
    const reload=()=>void reloadSessions().catch(error=>setNotice(friendlyError(error)));
    const unsubscribe=subscribeSessions(reload);
    return unsubscribe;
  },[access.ready,userId,reloadSessions]);
  useEffect(()=>{
    if(access.ready&&current)void reloadParticipants(current).catch(error=>setNotice(friendlyError(error)));
    else setParticipants([]);
  },[access.ready,userId,current,reloadParticipants]);
  useEffect(()=>{if(access.ready&&current)localStorage.setItem('itri-current-session',current.id);},[access.ready,current]);
  useEffect(()=>access.ready&&current?subscribeSession(current.id,()=>void reloadParticipants(current).catch(error=>setNotice(friendlyError(error)))):undefined,[access.ready,userId,current,reloadParticipants]);

  if(checking)return <Shell><div className="grid min-h-[60vh] place-items-center text-slate-500">正在確認登入狀態…</div></Shell>;
  if(!auth)return <Shell><Login onLogin={async(email,password)=>{
    setBusy(true);
    try{const{data,error}=await signIn(email,password);if(error)throw error;setAuth(data.session);}
    catch(error){throw new Error(friendlyError(error));}
    finally{setBusy(false);}
  }} busy={busy}/></Shell>;
  const header=<div className="system-user"><span>{access.permissions?.displayName||auth.user.email}</span><button disabled={busy} onClick={async()=>{
    setBusy(true);
    try{await roomClaims.release().catch(()=>false);await signOut();}
    catch(error){setNotice(friendlyError(error));}
    finally{setBusy(false);}
  }}><LogOut size={17}/>登出</button></div>;
  if(!access.ready||!effectivePage)return <Shell header={header}>
    <div role={access.loading?'status':'alert'} className="mx-auto mt-10 max-w-xl rounded-2xl bg-white p-6 text-center font-bold text-slate-700">
      {access.loading?'正在確認系統權限…':access.error||permissionAccessMessage(access.permissions)}
    </div>
    {notice&&<Notice text={notice} clear={()=>setNotice('')}/>}
  </Shell>;

  const selectSession=(id:string)=>{
    if(!workAccess.current.ready)return;
    const next=sessions.find(x=>x.id===id)??null;
    if(!next)leaseContext.current=null;
    activeSessionId.current=next?.id??null;participantRequest.current++;
    setParticipants([]);setCurrent(next);
  };
  const canManageRegistration=()=>workAccess.current.ready&&workAccess.current.userId===userId&&canUsePage(workAccess.current.permissions,'registration');
  const registrationNotice=(message:string)=>{if(canManageRegistration())setNotice(message);};
  const currentParticipants=participants.filter(person=>person.sessionId===current?.id);
  const labels:Record<WorkPage,string>={registration:'健檢報到站',console:'超音波控制台',room:'超音波診間'};
  return <Shell room={effectivePage==='room'} navigation={<nav className="system-navigation" aria-label="工作站導覽">
    {allowedPages.map(value=><button key={value} className={effectivePage===value?'is-active':''} onClick={()=>{if(canUsePage(access.permissions,value))setPage(value);}}>{labels[value]}</button>)}
  </nav>} header={header}>
    {notice&&<Notice text={notice} clear={()=>setNotice('')}/>}
    {effectivePage!=='registration'&&<label className="mb-3 flex flex-wrap items-center gap-2 text-sm font-bold text-slate-700">
      工作場次<select className="input min-h-10 w-auto max-w-full" aria-label="工作場次" value={current?.id??''} onChange={event=>selectSession(event.target.value)}>
        <option value="">選擇場次</option>
        {sessions.map(value=><option key={value.id} value={value.id}>{value.sessionDate}｜{value.companyName}</option>)}
      </select>
    </label>}
    {effectivePage==='registration'?<Registration authId={auth.user.id} sessions={sessions} current={current} participants={currentParticipants} onSelect={selectSession} onCreated={async session=>{
      if(!canManageRegistration())return;
      await reloadSessions();
      if(!canManageRegistration())return;
      setCurrent(session);setNotice('場次建立成功。');
    }} onImported={async message=>{if(!canManageRegistration())return;await reloadParticipants();registrationNotice(message);}} onCheckedIn={async()=>{if(canManageRegistration())await reloadParticipants();}} onManaged={async(deleted,message)=>{
      if(!canManageRegistration())return;await reloadSessions();if(!canManageRegistration())return;
      if(!deleted&&current)await reloadParticipants(current);
      registrationNotice(message);
    }} setNotice={registrationNotice}/>:effectivePage==='console'?<UltrasoundConsole canRoom={access.permissions?.canRoom===true} current={current} participants={currentParticipants} onChanged={()=>reloadParticipants(current)} onError={message=>setNotice('操作失敗：'+friendlyError(message))}/>:<UltrasoundRoom current={current} participants={currentParticipants} claimState={roomClaims} onChanged={()=>reloadParticipants(current)}/>}
  </Shell>;
}

function Shell({children,header,navigation,room=false}:{children:React.ReactNode;header?:React.ReactNode;navigation?:React.ReactNode;room?:boolean}){return <div className={`min-h-screen bg-slate-50 text-slate-900 ${room?'pb-0':'pb-20'}`}><header className="system-header"><div className="system-toolbar"><div className="system-brand"><span className="system-logo"><Activity/></span><h1>超音波健檢系統</h1></div>{navigation}{header??<span className={`rounded-full px-3 py-1 text-xs font-bold ${isSupabaseConfigured?'bg-emerald-100 text-emerald-800':'bg-amber-100 text-amber-800'}`}>{isSupabaseConfigured?'雲端已連線':'尚未設定雲端'}</span>}</div></header><main className={`mx-auto max-w-7xl p-4 ${room?'pb-0 md:pb-0':'md:p-6'}`}>{children}</main></div>}
function Notice({text,clear}:{text:string;clear:()=>void}){return <div role="status" className="mb-4 flex justify-between rounded-xl border border-teal-200 bg-teal-50 p-4 text-teal-900"><span>{text}</span><button aria-label="關閉訊息" className="font-bold" onClick={clear}>×</button></div>}
function Login({onLogin,busy}:{onLogin:(email:string,password:string)=>Promise<void>;busy:boolean}){const[email,setEmail]=useState('');const[password,setPassword]=useState('');const[error,setError]=useState('');return <div className="mx-auto mt-10 max-w-md rounded-2xl bg-white p-6 shadow-sm"><Title title="工作人員登入" subtitle="請使用受管理的 Supabase Auth 工作人員帳號。"/><form onSubmit={async e=>{e.preventDefault();setError('');try{await onLogin(email,password);}catch(reason){setError(friendlyError(reason));}}} className="space-y-4"><label className="block"><span className="label">Email</span><input className="input" type="email" autoComplete="username" required value={email} onChange={e=>setEmail(e.target.value)}/></label><label className="block"><span className="label">Password</span><input className="input" type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)}/></label>{error&&<p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}<button disabled={busy||!isSupabaseConfigured} className="primary w-full disabled:opacity-40">{busy?'登入中…':'登入'}</button></form></div>}

function Registration({authId,sessions,current,participants,onSelect,onCreated,onImported,onCheckedIn,onManaged,setNotice}:{authId:string;sessions:Session[];current:Session|null;participants:Participant[];onSelect:(id:string)=>void;onCreated:(s:Session)=>Promise<void>;onImported:(s:string)=>Promise<void>;onCheckedIn:()=>Promise<void>;onManaged:(deleted:boolean,message:string)=>Promise<void>;setNotice:(s:string)=>void}){
  const[view,setView]=useState<'work'|'sessions'|'roster'>('work');const[date,setDate]=useState(taiwanToday);const[company,setCompany]=useState('');const[roomCount,setRoomCount]=useState(DEFAULT_ROOM_COUNT);const[busy,setBusy]=useState(false);const[manage,setManage]=useState(false);
  if(view==='roster')return <section><ManagementHeader title="名單管理" onBack={()=>setView('work')}/>{current?<RosterManager key={current.id} current={current} participants={participants} onUploaded={onImported} setNotice={setNotice}/>:<Empty text="請先到場次管理建立或選擇場次。"/>}</section>;
  if(view==='sessions')return <section><ManagementHeader title="場次管理" onBack={()=>setView('work')}/><div className="mx-auto grid max-w-4xl gap-5 lg:grid-cols-2"><div className="space-y-4 rounded-2xl bg-white p-5 shadow-sm"><h3 className="text-lg font-black">建立今日場次</h3><label className="block"><span className="label">公司名稱</span><input className="input" value={company} onChange={e=>setCompany(e.target.value)}/></label><label className="block"><span className="label">健檢日期</span><input type="date" className="input" value={date} onChange={e=>setDate(e.target.value)}/></label><RoomCountField value={roomCount} onChange={setRoomCount} disabled={busy}/><button disabled={busy||!company.trim()||!date||!isValidRoomCount(roomCount)} className="primary w-full disabled:opacity-40" onClick={async()=>{setBusy(true);try{await onCreated(await createSession(company,date,authId,roomCount));setCompany('');setRoomCount(DEFAULT_ROOM_COUNT);}catch(e){setNotice(friendlyError(e));}finally{setBusy(false);}}}>建立場次</button></div><div className="space-y-4 rounded-2xl bg-white p-5 shadow-sm"><h3 className="text-lg font-black">選擇既有場次</h3><select className="input" aria-label="目前場次" value={current?.id??''} onChange={e=>onSelect(e.target.value)}><option value="">選擇既有場次</option>{sessions.map(s=><option value={s.id} key={s.id}>{s.sessionDate}｜{s.companyName}｜超音波診間：{getRoomCount(s.roomCount)}間</option>)}</select>{current&&<><SessionRoomCountEditor key={current.id} session={current} onSaved={async updated=>{await onManaged(false,`超音波診間數量已更新為 ${getRoomCount(updated.roomCount)} 間。`);}}/><SessionExportPanel session={current} participants={participants} setNotice={setNotice}/><button className="secondary w-full border-amber-400 text-amber-900" onClick={()=>setManage(true)}><Settings size={18}/>清除排程或刪除場次</button></>}</div></div>{manage&&current&&<SessionManager session={current} participants={participants} onClose={()=>setManage(false)} onDone={async(deleted,message)=>{await onManaged(deleted,message);setManage(false);}}/>}</section>;
  return <section className="registration-workspace"><div className="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><h2 className="text-2xl font-black">健檢報到站</h2><p className="mt-1 text-base font-bold text-teal-900">{current?`${current.companyName} ｜ ${current.sessionDate.replaceAll('-','/')} ｜ 今日排程 ${participants.length} 人`:'尚未選擇今日場次'}</p></div><div className="flex gap-2"><button className="secondary" onClick={()=>setView('sessions')}><Settings size={18}/>場次管理</button><button className="secondary" onClick={()=>setView('roster')}><ClipboardList size={18}/>名單管理</button></div></div>{current&&<RoomStatusOverview sessionId={current.id} roomCount={current.roomCount}/>}<Checkin key={current?.id??'no-session'} current={current} participants={participants} onSuccess={onCheckedIn} setNotice={setNotice}/></section>
}
function SessionExportPanel({session,participants,setNotice}:{session:Session;participants:Participant[];setNotice:(message:string)=>void}){
  const[exporting,setExporting]=useState<'checkin'|'ultrasound'|null>(null);const report=buildCheckinReport(participants);const exportActive=useRef(true);
  useEffect(()=>{exportActive.current=true;return()=>{exportActive.current=false;};},[]);
  const run=async(kind:'checkin'|'ultrasound')=>{setExporting(kind);try{const freshParticipants=await listParticipants(session.id);if(!exportActive.current)return;if(kind==='checkin'){downloadCheckinReport(session,freshParticipants);setNotice('今日報到狀況 Excel 已完成下載。');return;}const examinations=await listExaminations(freshParticipants.map(person=>person.id));if(!exportActive.current)return;if(!examinations.length){setNotice('此場次目前尚無超音波檢查紀錄。');return;}downloadUltrasoundReport(session,freshParticipants,examinations);const inProgress=examinations.filter(item=>item.status==='in_progress').length;setNotice(inProgress?`今日超音波狀況 Excel 已完成下載；目前仍有 ${inProgress} 人檢查中，完成統計僅計入已完成檢查。`:'今日超音波狀況 Excel 已完成下載。');}catch(error){if(exportActive.current)setNotice(`匯出失敗：${friendlyError(error)}`);}finally{if(exportActive.current)setExporting(null);}};
  return <div className="space-y-4"><dl className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-4 sm:grid-cols-3"><Stat label="公司名稱" value={session.companyName}/><Stat label="健檢日期" value={session.sessionDate}/><Stat label="今日排程" value={`${participants.length} 人`}/><Stat label="已報到" value={`${report.checkedIn.length} 人`}/><Stat label="未報到" value={`${report.notCheckedIn.length} 人`}/><Stat label="已完成超音波" value={`${participants.filter(person=>person.status==='已完成').length} 人`}/><Stat label="超音波診間" value={`${getRoomCount(session.roomCount)}間`}/><Stat label="場次狀態" value={session.status}/></dl><div className="rounded-xl border border-teal-100 p-4"><h4 className="mb-3 font-black"><FileSpreadsheet className="mr-2 inline text-teal-700" size={20}/>資料匯出</h4><div className="grid gap-2"><button className="primary w-full disabled:opacity-50" disabled={exporting!==null} onClick={()=>void run('checkin')}><FileSpreadsheet size={18}/>{exporting==='checkin'?'正在整理 Excel……':'匯出今日報到狀況'}</button><button className="secondary w-full disabled:opacity-50" disabled={exporting!==null} onClick={()=>void run('ultrasound')}><FileSpreadsheet size={18}/>{exporting==='ultrasound'?'正在整理 Excel……':'匯出今日超音波狀況'}</button></div></div></div>;
}
function ManagementHeader({title,onBack}:{title:string;onBack:()=>void}){return <header className="mb-5 flex items-center gap-4 border-b border-slate-200 pb-4"><button className="secondary" onClick={onBack}><ArrowLeft size={19}/>返回報到站</button><div><h2 className="text-2xl font-black">{title}</h2><p className="text-sm text-slate-500">管理作業完成後，可返回現場工作畫面。</p></div></header>}
function SessionManager({session,participants,onClose,onDone}:{session:Session;participants:Participant[];onClose:()=>void;onDone:(deleted:boolean,message:string)=>Promise<void>}){
  const[action,setAction]=useState<'clear'|'delete'|null>(null);const[phrase,setPhrase]=useState('');const[busy,setBusy]=useState(false);const[error,setError]=useState('');const summary=cleanupSummary(participants);const risky=summary.checkedIn>0||summary.completed>0;
  const execute=async()=>{if(!action||phrase!==(action==='delete'?'刪除場次':'清除排程'))return;setBusy(true);setError('');try{if(action==='delete')await deleteSession(session.id);else await clearSessionSchedule(session.id);try{await clearPreparedSchedule(session.id);}catch(e){setError(`雲端已完成，但本機排程清除失敗，請重試：${friendlyError(e)}`);return;}if(action==='delete')localStorage.removeItem('itri-current-session');onClose();await onDone(action==='delete',action==='delete'?'場次及其雲端作業資料已刪除；公司大名單未受影響。':'今日排程與相關作業資料已清除；場次與公司大名單仍保留。');}catch(e){setError(`雲端操作失敗，未變更本機資料：${friendlyError(e)}`);}finally{setBusy(false);}};
  return <div className="fixed inset-0 z-50 grid bg-slate-950/60 p-3" role="dialog" aria-modal="true" aria-label="管理場次"><div className="m-auto max-h-full w-full max-w-2xl overflow-auto rounded-2xl bg-white shadow-2xl"><header className="flex items-center justify-between border-b p-5"><h2 className="text-xl font-black">管理場次</h2><button disabled={busy} className="secondary min-h-10 px-3" onClick={onClose} aria-label="關閉"><X/></button></header><div className="space-y-5 p-5"><dl className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-4 sm:grid-cols-3"><Stat label="公司名稱" value={session.companyName}/><Stat label="健檢日期" value={session.sessionDate}/><Stat label="今日排程" value={`${summary.total} 人`}/><Stat label="已報到" value={`${summary.checkedIn} 人`}/><Stat label="未報到" value={`${summary.total-summary.checkedIn} 人`}/><Stat label="已完成檢查" value={`${summary.completed} 人`}/><Stat label="超音波診間" value={`${getRoomCount(session.roomCount)}間`}/><Stat label="場次狀態" value={session.status}/></dl>
    {!action?<div className="grid gap-3 sm:grid-cols-2"><button className="secondary border-amber-400 text-amber-900" onClick={()=>setAction('clear')}>清除今日排程</button><button className="danger" onClick={()=>setAction('delete')}>刪除整個場次</button></div>:<div className={`rounded-xl border-2 p-5 ${risky?'border-red-500 bg-red-50':'border-amber-400 bg-amber-50'}`}><div className="flex gap-3"><AlertTriangle className="shrink-0 text-red-700"/><div><h3 className="text-lg font-black">{action==='delete'?'確定要刪除這個健檢場次？':'確定要清除今日排程？'}</h3><p className="mt-2 leading-7">公司：{session.companyName}<br/>日期：{session.sessionDate}<br/><br/>今日排程：{summary.total} 人<br/>已報到：{summary.checkedIn} 人<br/>已完成：{summary.completed} 人</p><p className="mt-3 font-bold">此操作將刪除本場次的今日排程、報到編號、報到狀態及相關檢查紀錄。公司大名單不會被刪除，其他日期不受影響。</p><p className="mt-2 text-red-800">此操作無法從目前系統直接復原。</p></div></div><label className="mt-4 block"><span className="label">請輸入「{action==='delete'?'刪除場次':'清除排程'}」以確認</span><input autoFocus className="input" value={phrase} onChange={e=>setPhrase(e.target.value)} disabled={busy}/></label>{error&&<p role="alert" className="mt-3 rounded-lg bg-red-100 p-3 text-red-900">{error}</p>}<div className="mt-5 flex justify-end gap-3"><button disabled={busy} className="secondary" onClick={()=>{setAction(null);setPhrase('');setError('');}}>取消</button><button disabled={busy||phrase!==(action==='delete'?'刪除場次':'清除排程')} className="danger disabled:opacity-40" onClick={()=>void execute()}>{busy?'處理中…':action==='delete'?'確認刪除':'確認清除'}</button></div></div>}
  </div></div></div>;
}
function Stat({label,value}:{label:string;value:string}){return <div><dt className="text-xs font-bold text-slate-500">{label}</dt><dd className="mt-1 font-black">{value}</dd></div>}
function Title({title,subtitle}:{title:string;subtitle:string}){return <div className="mb-5"><h2 className="text-2xl font-black">{title}</h2><p className="mt-1 text-slate-500">{subtitle}</p></div>}
function Empty({text}:{text:string}){return <div className="grid min-h-36 place-items-center text-center text-slate-400">{text}</div>}
