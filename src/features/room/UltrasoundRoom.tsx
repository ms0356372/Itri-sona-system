import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowLeft,Check,ChevronDown,ChevronUp,Clock,Eye,EyeOff,FileSpreadsheet,FolderLock,Pause,Play,SlidersHorizontal,Square,Trash2,Upload,X} from 'lucide-react';
import type {Examination,HistoricalRecord,HistoryImportSummary,Participant,Session} from '../../types';
import {demoHistory,ultrasoundItems,type HistoryVisit,type UltrasoundItem} from './demoData';
import {clearHistory,findHistoryByEmployeeNo,findHistoryByNationalId,historyStats,importHistory} from '../history/db';
import {displayUltrasoundResult,parseHistoryFile} from '../history/excel';
import {cloudNow,completeExamination,getExamination,getRoomExamination,listExaminations,restoreDraft,saveExaminationDraft,startExamination} from '../examination/service';
import {UltrasoundUiSettingsPanel} from './UltrasoundUiSettingsPanel';
import {defaultUltrasoundUiSettings,loadUltrasoundUiSettings,saveUltrasoundUiSettings,ULTRASOUND_UI_STORAGE_KEY,ultrasoundUiCssVariables,type UltrasoundUiSettings} from './ultrasoundUiSettings';
import {availableRoomHeight} from './viewportHeight';
import {useRoomStates} from './useRoomStates';
import {setRoomAway} from './service';
import {RoomStatusBadge} from './RoomStatusBadge';
import {getRoomCount,getRoomIds,normalizeRoomId} from './status';
import {formatError} from '../../lib/errors';

const demoPatient:Participant={id:'demo-patient',sessionId:'demo-session',sequence:15,employeeNo:'B30040',name:'王小明（虛構）',gender:'男',slot:'07:30～08:00',groupCode:'A',plannedItems:[],checkinNo:'A15',status:'等候中',checkedInAt:new Date().toISOString(),calledAt:null,note:'',updatedAt:''};
const formatElapsed=(seconds:number)=>[Math.floor(seconds/3600),Math.floor(seconds%3600/60),seconds%60].map(value=>String(value).padStart(2,'0')).join(':');
const cloudMessage='無法連線至雲端，檢查紀錄尚未完成同步，請確認網路後重試。';
const roomError=(error:unknown)=>{
  const detail=formatError(error);
  if(detail==='此帳號沒有執行此功能的權限。')return detail;
  if(detail.includes('room_away'))return '診間目前暫時離開，請先返回診間。';
  if(detail.includes('room_occupied'))return '此診間已有受檢者檢查中，請重新同步診間資料。';
  if(detail.includes('examination_in_other_room'))return `此受檢者正在${detail.split(':').at(-1)}檢查中。`;
  if(detail.includes('already_completed'))return '此受檢者已完成本次檢查。';
  return cloudMessage;
};
type RoomWorkspace={mode:'nationalId'|'employeeNo'|'list';query:string;selected:Participant|null;localPerson:{name:string;employeeNo:string}|null;records:HistoricalRecord[];items:UltrasoundItem[];expanded:UltrasoundItem[];examination:Examination|null;showTimer:boolean;clockOffset:number;confirming:boolean;actualItems:UltrasoundItem[];message:string};

export function UltrasoundRoom({current,participants,onChanged=async()=>undefined}:{current:Session|null;participants:Participant[];onChanged?:()=>Promise<void>}){
  const[selectedRoom,setRoom]=useState(()=>normalizeRoomId(localStorage.getItem('itri-ultrasound-room')||'診間 1'));const[demo,setDemo]=useState(false);const[hasLocalHistory,setHasLocalHistory]=useState<boolean|null>(null);const[mode,setMode]=useState<'nationalId'|'employeeNo'|'list'>('nationalId');const[query,setQuery]=useState('');const[selected,setSelected]=useState<Participant|null>(null);const[localPerson,setLocalPerson]=useState<{name:string;employeeNo:string}|null>(null);const[records,setRecords]=useState<HistoricalRecord[]>([]);const[items,setItems]=useState<UltrasoundItem[]>([]);const[expanded,setExpanded]=useState<UltrasoundItem[]>([]);const[examination,setExamination]=useState<Examination|null>(null);const[showTimer,setShowTimer]=useState(false);const[clockOffset,setClockOffset]=useState(0);const[now,setNow]=useState(Date.now());const[confirming,setConfirming]=useState(false);const[actualItems,setActualItems]=useState<UltrasoundItem[]>([]);const[busy,setBusy]=useState(false);const[message,setMessage]=useState('');const[importOpen,setImportOpen]=useState(false);const[settingsOpen,setSettingsOpen]=useState(false);const[uiSettings,setUiSettings]=useState(loadUltrasoundUiSettings);const inputRef=useRef<HTMLInputElement>(null);const workspaceRef=useRef<HTMLElement>(null);
  const roomStates=useRoomStates(demo?null:current?.id??null,current?.roomCount);
  const roomCount=getRoomCount(roomStates.roomCount??current?.roomCount);
  const roomIds=getRoomIds(roomCount);
  const room=roomIds.includes(selectedRoom)?selectedRoom:roomIds[0];
  const operationPending=useRef(false);
  const[demoAway,setDemoAway]=useState<Record<string,boolean>>({});
  const[loadedWorkspace,setLoadedWorkspace]=useState('');
  const[restoring,setRestoring]=useState(false);
  const workspaceKey=`${demo?'demo':current?.id??'none'}:${room}`;
  const workspaceKeyRef=useRef(workspaceKey);workspaceKeyRef.current=workspaceKey;
  const workspaces=useRef(new Map<string,RoomWorkspace>());
  const selectionRequest=useRef(0);
  const invalidateSelection=useCallback(()=>{selectionRequest.current++;},[]);
  const participantsRef=useRef(participants);participantsRef.current=participants;
  const cloudRoom=roomStates.rooms.find(value=>value.roomId===room);
  const liveRoom=cloudRoom;
  const status=demo?(demoAway[room]?'away':examination?.status==='in_progress'?'in_progress':'idle'):liveRoom?.status;
  const away=status==='away';
  const unavailable=!demo&&(!current||roomStates.loading||Boolean(roomStates.error)||!status);
  const locked=examination?.status==='in_progress'&&examination.roomId===room;
  const patientActionsDisabled=busy||away||unavailable||restoring||loadedWorkspace!==workspaceKey;
  useEffect(()=>{
    if(selectedRoom!==room)setRoom(room);
    const prefix=`${demo?'demo':current?.id??'none'}:`;
    for(const key of workspaces.current.keys())if(key.startsWith(prefix)&&!getRoomIds(roomCount).includes(key.slice(prefix.length)))workspaces.current.delete(key);
  },[room,selectedRoom,roomCount,demo,current?.id]);
  useEffect(()=>{
    if(loadedWorkspace!==workspaceKey)return;
    workspaces.current.set(workspaceKey,{mode,query,selected,localPerson,records,items,expanded,examination,showTimer,clockOffset,confirming,actualItems,message});
  },[loadedWorkspace,workspaceKey,mode,query,selected,localPerson,records,items,expanded,examination,showTimer,clockOffset,confirming,actualItems,message]);
  const elapsed=examination?.startedAt?Math.max(0,Math.floor((now+clockOffset-Date.parse(examination.startedAt!))/1000)):0;
  useEffect(()=>{void historyStats().then(value=>setHasLocalHistory(value.recordCount>0));},[importOpen]);
  useEffect(()=>{if(!locked)localStorage.setItem('itri-ultrasound-room',room);},[room,locked]);
  useEffect(()=>{if(!examination||examination.status!=='in_progress')return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[examination]);
  useEffect(()=>{const workspace=workspaceRef.current;if(!workspace)return;for(const[key,variable]of Object.entries(ultrasoundUiCssVariables))workspace.style.setProperty(variable,`${uiSettings[key as keyof UltrasoundUiSettings]}px`);},[uiSettings]);
  useEffect(()=>{const workspace=workspaceRef.current;if(!workspace)return;let frame=0;let applied=-1;const update=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{const landscape=window.matchMedia('(min-width: 900px) and (orientation: landscape)').matches;if(!landscape){workspace.style.removeProperty('--room-available-height');applied=-1;return;}const viewport=window.visualViewport;const next=availableRoomHeight(viewport?.height??window.innerHeight,workspace.getBoundingClientRect().top,8,viewport?.offsetTop??0);if(next!==applied){workspace.style.setProperty('--room-available-height',`${next}px`);applied=next;window.dispatchEvent(new Event('room-layout'));}});};update();window.addEventListener('resize',update);window.addEventListener('orientationchange',update);window.visualViewport?.addEventListener('resize',update);window.visualViewport?.addEventListener('scroll',update);return()=>{cancelAnimationFrame(frame);window.removeEventListener('resize',update);window.removeEventListener('orientationchange',update);window.visualViewport?.removeEventListener('resize',update);window.visualViewport?.removeEventListener('scroll',update);};},[]);
  const applyExamination=useCallback(async(value:Examination,person?:Participant)=>{
    const key=workspaceKeyRef.current;
    setShowTimer(false);setExamination(value);setItems(value.selectedItems as UltrasoundItem[]);
    setSelected(person??participantsRef.current.find(p=>p.id===value.participantId)??null);
    if(value.status==='in_progress'){
      try{const clock=await cloudNow();if(workspaceKeyRef.current===key)setClockOffset(clock.offsetMs);}
      catch{if(workspaceKeyRef.current===key)setClockOffset(0);}
    }
  },[]);
  // Room status and roster refreshes must never reset the current workspace.
  useEffect(()=>{
    let cancelled=false;const key=workspaceKey;invalidateSelection();
    const saved=workspaces.current.get(key);
    setMode(saved?.mode??'nationalId');setQuery(saved?.query??'');setSelected(saved?.selected??(demo?demoPatient:null));
    setLocalPerson(saved?.localPerson??null);setRecords(saved?.records??[]);setItems(saved?.items??[]);
    setExpanded(saved?.expanded??[]);setExamination(saved?.examination??null);setShowTimer(saved?.showTimer??false);
    setClockOffset(saved?.clockOffset??0);setConfirming(saved?.confirming??false);setActualItems(saved?.actualItems??[]);
    setMessage(saved?.message??'');setLoadedWorkspace(key);
    if(demo||!current){setRestoring(false);return()=>{cancelled=true;};}
    setRestoring(true);
    void getRoomExamination(current.id,room).then(async value=>{
      if(cancelled||workspaceKeyRef.current!==key)return;
      if(value&&value.id!==saved?.examination?.id){
        const person=participantsRef.current.find(p=>p.id===value.participantId);
        await applyExamination(value,person);
        if(person){const history=await findHistoryByEmployeeNo(person.employeeNo);if(!cancelled&&workspaceKeyRef.current===key)setRecords(history);}
      }
    }).catch(error=>{if(!cancelled)setMessage(roomError(error));}).finally(()=>{if(!cancelled)setRestoring(false);});
    return()=>{cancelled=true;invalidateSelection();};
  },[workspaceKey,demo,current?.id,room,applyExamination,invalidateSelection]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{
    if(loadedWorkspace!==workspaceKey)return;
    const person=participants.find(p=>p.id===(selected?.id??examination?.participantId));
    if(person&&person!==selected)setSelected(person);
  },[participants,selected,examination?.participantId,loadedWorkspace,workspaceKey]);
  // Reconcile other tablets' examination changes without resetting an unchanged patient's workspace.
  useEffect(()=>{
    if(demo||!current||loadedWorkspace!==workspaceKey||restoring)return;
    let cancelled=false;const key=workspaceKey;const request=selectionRequest.current;
    const valid=()=>!cancelled&&workspaceKeyRef.current===key&&selectionRequest.current===request;
    void (async()=>{
      const active=await getRoomExamination(current.id,room);
      if(!valid())return;
      if(active){
        if(active.id!==examination?.id){
          const person=participantsRef.current.find(value=>value.id===active.participantId);
          await applyExamination(active,person);
          if(person){const history=await findHistoryByEmployeeNo(person.employeeNo);if(valid())setRecords(history);}
        }
      }else if(examination?.status==='in_progress'&&examination.roomId===room){
        const rounds=await listExaminations([examination.participantId]);
        const updated=rounds.find(value=>value.id===examination.id);
        if(valid()&&updated?.status==='completed'){setExamination(updated);setConfirming(false);}
      }
    })().catch(error=>{if(valid())setMessage(roomError(error));});
    return()=>{cancelled=true;};
  },[participants,liveRoom?.updatedAt,loadedWorkspace]); // eslint-disable-line react-hooks/exhaustive-deps
  const selectPerson=async(person:Participant|null,history:HistoricalRecord[]=[] )=>{
    if(patientActionsDisabled||locked)return;
    const request=++selectionRequest.current;const key=workspaceKey;
    setSelected(person);setRecords(history);setExamination(null);setItems([]);setMessage('');
    if(!person||demo)return;
    try{
      const existing=await getExamination(person.id);
      if(request!==selectionRequest.current||key!==workspaceKeyRef.current)return;
      if(existing){await applyExamination(existing,person);if(request!==selectionRequest.current||key!==workspaceKeyRef.current)return;if(existing.status==='in_progress'&&existing.roomId!==room)setMessage(`此受檢者正在${existing.roomId}檢查中。`);return;}
      const draft=await restoreDraft(person.id);
      if(request===selectionRequest.current&&key===workspaceKeyRef.current&&draft&&normalizeRoomId(draft.roomId)===room)setItems(draft.items.filter(item=>ultrasoundItems.includes(item as UltrasoundItem)) as UltrasoundItem[]);
    }catch(error){if(request===selectionRequest.current&&key===workspaceKeyRef.current)setMessage(roomError(error));}
  };
  const search=async(raw=query)=>{
    if(patientActionsDisabled||locked)return;
    if(demo){await selectPerson(demoPatient);return;}
    const request=++selectionRequest.current;const key=workspaceKey;
    try{
      const normalized=raw.trim().toUpperCase();
      const foundRecords=mode==='nationalId'?await findHistoryByNationalId(normalized):mode==='employeeNo'?await findHistoryByEmployeeNo(raw.trim()):[];
      if(request!==selectionRequest.current||key!==workspaceKeyRef.current)return;
      const newest=[...foundRecords].sort((a,b)=>b.date.localeCompare(a.date))[0];
      setLocalPerson(newest?{name:newest.name,employeeNo:newest.employeeNo}:null);
      const employeeNo=mode==='employeeNo'?raw.trim():newest?.employeeNo;
      const person=participantsRef.current.find(p=>p.employeeNo===employeeNo)??null;
      await selectPerson(person,foundRecords);if(!person)setMessage('今日排程查無此受檢者。');
    }catch{if(request===selectionRequest.current&&key===workspaceKeyRef.current)setMessage('本機查詢失敗，請重試。');}
  };
  const toggleAway=async()=>{
    if(operationPending.current||busy||unavailable||restoring)return;
    const key=workspaceKey;operationPending.current=true;setBusy(true);
    try{
      if(demo)setDemoAway(values=>({...values,[room]:!away}));
      else if(current){
        const value=await setRoomAway(current.id,room,!away);
        if(workspaceKeyRef.current===key)roomStates.acceptRoom(value);
        await roomStates.refresh();
      }
    }catch(error){if(workspaceKeyRef.current===key){const detail=formatError(error);setMessage(detail==='此帳號沒有執行此功能的權限。'?detail:`診間狀態同步失敗：${detail}`);}}
    finally{operationPending.current=false;setBusy(false);}
  };
  const toggle=(item:UltrasoundItem)=>{if(patientActionsDisabled)return;const next=items.includes(item)?items.filter(x=>x!==item):[...items,item];setItems(next);setExpanded(old=>old.includes(item)?old:[...old,item]);if(selected&&!demo)void saveExaminationDraft(selected.id,room,next);};
  const begin=async()=>{
    if(operationPending.current||patientActionsDisabled||examination?.status==='in_progress'){if(away)setMessage('診間目前暫時離開，請先返回診間。');return;}
    if(!current||!selected){setMessage('今日排程查無此受檢者。');return;}
    if(!selected.checkedInAt||!selected.checkinNo){setMessage('此受檢者尚未報到，請先至健檢報到站完成報到。');return;}
    if(!items.length){setMessage('請至少選擇一種超音波項目。');return;}
    const key=workspaceKey;operationPending.current=true;setShowTimer(false);setBusy(true);setMessage('');
    try{
      if(demo){const iso=new Date().toISOString();setExamination({id:'demo',participantId:selected.id,roundNo:1,roomId:room,startedAt:iso,completedAt:null,durationSeconds:null,selectedItems:items,actualItems:[],itemCount:0,status:'in_progress'});}
      else{
        const value=await startExamination(selected.id,room,items);
        if(workspaceKeyRef.current!==key)return;
        await applyExamination(value,selected);
        if(workspaceKeyRef.current===key){await onChanged();await roomStates.refresh();}
      }
    }catch(error){if(workspaceKeyRef.current===key){setMessage(roomError(error));void roomStates.refresh().catch(()=>undefined);}}
    finally{operationPending.current=false;setBusy(false);}
  };
  const finish=async()=>{
    if(operationPending.current||patientActionsDisabled||examination?.roomId!==room||!examination||!selected||!actualItems.length)return;
    const key=workspaceKey;operationPending.current=true;setBusy(true);setMessage('');
    try{
      if(demo){const iso=new Date().toISOString();setExamination({...examination,status:'completed',completedAt:iso,durationSeconds:Math.max(0,Math.floor((Date.parse(iso)-Date.parse(examination.startedAt!))/1000)),actualItems,itemCount:actualItems.length});}
      else{
        const value=await completeExamination(examination.id,selected.id,examination.roomId!,actualItems);
        if(workspaceKeyRef.current!==key)return;
        setExamination(value);await onChanged();await roomStates.refresh();
      }
      if(workspaceKeyRef.current===key)setConfirming(false);
    }catch(error){if(workspaceKeyRef.current===key){setMessage(roomError(error));void roomStates.refresh().catch(()=>undefined);}}
    finally{operationPending.current=false;setBusy(false);}
  };
  const history=(item:UltrasoundItem):HistoryVisit[]=>demo?demoHistory[item].slice(0,3):records.filter(record=>record.type===item).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,3).map(record=>({date:record.date,result:record.values.整體結果??record.values.結果??'',details:record.values,labs:record.values}));
  const next=()=>{if(patientActionsDisabled||locked)return;++selectionRequest.current;setSelected(null);setLocalPerson(null);setRecords([]);setItems([]);setExpanded([]);setExamination(null);setQuery('');setMessage('');setTimeout(()=>inputRef.current?.focus(),0);};
  if(importOpen)return <ImportDialog close={()=>setImportOpen(false)}/>;
  const applyUiSettings=(value:UltrasoundUiSettings)=>{setUiSettings(value);saveUltrasoundUiSettings(value);};
  return <section ref={workspaceRef} className={`room-workspace${settingsOpen?' room-settings-open':''}`}>
    <header className="room-toolbar">
      <div className="room-toolbar-primary">
        <div className="room-toolbar-identity"><h2>超音波診間</h2><span aria-hidden="true">｜</span><p>{current?.companyName??(demo?'XX 公司（虛構展示）':'尚未選擇場次')}｜{(current?.sessionDate??new Date().toISOString().slice(0,10)).replaceAll('-','/')}</p><span aria-hidden="true">｜</span></div>
        <label className="room-selector"><span>診間</span><select disabled={locked||busy} className="input border-teal-600 text-slate-900 disabled:opacity-60" value={room} onChange={e=>setRoom(e.target.value)}>{roomIds.map(roomId=><option key={roomId} value={roomId}>{roomId}</option>)}</select></label>
        <div className="room-start-actions">
          <button disabled={patientActionsDisabled||examination?.status==='in_progress'||examination?.status==='completed'||!selected||!items.length} className="room-start-button primary disabled:opacity-40" onClick={()=>void begin()}><Play size={18}/>開始檢查</button>
          <button disabled={busy||unavailable||restoring} aria-pressed={away} className={`room-away-button${away?' is-away':''}`} onClick={()=>void toggleAway()}>{away?<ArrowLeft size={18}/>:<Pause size={18}/>}<span>{away?'返回診間':'暫時離開'}</span></button>
        </div>
        <RoomStatusBadge status={unavailable?undefined:status} loading={!demo&&roomStates.loading}/>
        {examination?.status==='completed'?<div className="room-completion" role="status"><strong><Check size={17}/>檢查已完成</strong><span>耗時 {formatElapsed(examination.durationSeconds??0)}</span><span>{examination.itemCount} 件</span><button disabled={patientActionsDisabled} className="primary disabled:opacity-40" onClick={next}>下一位受檢者</button></div>:examination?.status==='in_progress'&&<div className="room-examination-controls">
          {showTimer&&<span className="room-elapsed" aria-label={`已檢查 ${formatElapsed(elapsed)}`}>{formatElapsed(elapsed)}</span>}
          <button className="secondary room-timer-toggle" aria-pressed={showTimer} onClick={()=>setShowTimer(value=>!value)}>{showTimer?<EyeOff size={18}/>:<Eye size={18}/>}<span>{showTimer?'隱藏秒數':'顯示秒數'}</span></button>
          <button disabled={patientActionsDisabled||examination.roomId!==room} className="secondary room-finish-button disabled:opacity-40" onClick={()=>{setActualItems([...items]);setConfirming(true);}}><Square size={17}/>完成檢查</button>
        </div>}
      </div>
      <div className="room-toolbar-actions"><button role="switch" disabled={locked||busy||away} aria-checked={demo} className={demo?'bg-sky-100 text-sky-900 secondary':'secondary'} onClick={()=>setDemo(x=>!x)}>{demo?'展示：開':'展示'}</button><button className="secondary" aria-expanded={settingsOpen} onClick={()=>setSettingsOpen(value=>!value)}><SlidersHorizontal size={18}/>UI調整</button><button className="secondary" onClick={()=>setImportOpen(true)}><FileSpreadsheet size={18}/>歷年資料</button></div>
    </header>
    {!current&&!demo&&<div className="room-message" role="status">請先選擇場次。</div>}
    {away&&<div className="room-away-notice" role="status">醫師暫時離席；請先返回診間，再繼續操作。目前受檢者與檢查資料已保留。</div>}
    {!demo&&roomStates.error&&<div role="alert" className="room-message">{roomStates.error}<button className="secondary" onClick={()=>void roomStates.refresh().catch(()=>undefined)}>重新同步</button></div>}
    {message&&<div role="alert" className="room-message">{message}</div>}
    <div className="room-columns"><aside className="room-controls"><div className="room-control-card rounded-xl bg-white shadow-sm"><div className="flex items-center justify-between"><h3 className="text-lg font-black">受檢者</h3>{selected&&!locked&&examination?.status!=='completed'&&<button disabled={patientActionsDisabled} className="secondary min-h-11 px-3 disabled:opacity-40" onClick={next}>換下一位</button>}</div>{!selected&&!locked&&examination?.status!=='completed'&&<><div className="room-search-modes grid grid-cols-3 gap-2">{([['nationalId','身分證'],['employeeNo','工號'],['list','今日排程']] as const).map(([id,label])=><button key={id} disabled={patientActionsDisabled} className={mode===id?'primary px-2':'secondary px-2'} onClick={()=>{setMode(id);next();}}>{label}</button>)}</div>{mode==='list'?<select disabled={patientActionsDisabled} aria-label="今日受檢者" className="input" value="" onChange={async e=>{const key=workspaceKey;const request=++selectionRequest.current;const person=participants.find(p=>p.id===e.target.value)??null;try{const history=person?await findHistoryByEmployeeNo(person.employeeNo):[];if(key===workspaceKeyRef.current&&request===selectionRequest.current)await selectPerson(person,history);}catch{if(key===workspaceKeyRef.current&&request===selectionRequest.current)setMessage('本機查詢失敗，請重試。');}}}><option value="">選擇今日受檢者</option>{demo&&<option value={demoPatient.id}>A15 王小明（虛構）</option>}{participants.map(p=><option value={p.id} key={p.id}>{p.checkinNo??'未報到'} {p.name}（{p.employeeNo}）</option>)}</select>:<div className="flex gap-2"><input ref={inputRef} disabled={patientActionsDisabled} className="input min-w-0 flex-1" autoComplete="off" value={query} placeholder={mode==='nationalId'?'請掃描或輸入身分證':'請輸入工號'} onChange={e=>{invalidateSelection();setQuery(e.target.value);if(demo||(mode==='nationalId'&&e.target.value.trim().length>=10))void search(e.target.value);}} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void search(e.currentTarget.value);}}}/><button disabled={patientActionsDisabled} className="primary px-4 disabled:opacity-40" onClick={()=>void search()}>查詢</button></div>}</>}{selected?<CompactPatient patient={selected} examination={examination} room={room} away={away}/>:localPerson?<p className="mt-3 rounded-lg bg-amber-50 p-3 font-bold">{localPerson.name}（{localPerson.employeeNo}）今日排程查無此人。</p>:<p className="mt-3 text-slate-500">尚未選取受檢者。</p>}</div>
      <div className="room-control-card rounded-xl bg-white shadow-sm"><h3 className="text-lg font-black">本次檢查</h3><div className="room-exam-list mt-3">{ultrasoundItems.map(item=>{const on=items.includes(item);return <button aria-pressed={on} key={item} disabled={patientActionsDisabled||!selected||Boolean(examination)} onClick={()=>toggle(item)} className={`room-exam-button flex w-full items-center gap-3 rounded-xl border-2 px-3 text-left text-base font-black transition disabled:opacity-60 ${on?'border-teal-700 bg-teal-700 text-white shadow-md':'border-slate-200 bg-white text-slate-800'}`}><span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border-2 border-current">{on&&<Check size={19}/>}</span>{item}</button>})}</div><p className="mt-3 rounded-lg bg-slate-100 p-2 text-center font-black">本次已選擇：<span className="text-teal-700">{items.length}</span> 項</p></div></aside>
      <main className="room-history"><h3 className="room-history-heading">歷年超音波資料</h3>{!demo&&hasLocalHistory===false?<div className="rounded-2xl bg-white p-8 text-center font-bold text-slate-600">本台裝置尚未匯入歷年超音波資料。</div>:!items.length?<div className="rounded-2xl bg-white p-8 text-center text-slate-500">選取本次超音波項目後，將在此顯示各項最近三次紀錄。</div>:<div className="room-history-panels">{ultrasoundItems.filter(item=>items.includes(item)).map(item=><HistoryPanel key={item} item={item} visits={history(item)} open={expanded.includes(item)} toggle={()=>setExpanded(old=>old.includes(item)?old.filter(x=>x!==item):[...old,item])}/>)}</div>}</main></div>
    {confirming&&<div className="fixed inset-0 z-50 grid bg-slate-950/60 p-3" role="dialog" aria-modal="true"><div className="m-auto w-full max-w-lg rounded-2xl bg-white p-6"><div className="flex justify-between"><h3 className="text-xl font-black">確認本次實際完成的超音波項目</h3><button className="secondary px-3" onClick={()=>setConfirming(false)}><X/></button></div><div className="my-5 space-y-2">{items.map(item=><label key={item} className="flex min-h-14 items-center gap-3 rounded-xl border p-3 text-lg font-bold"><input type="checkbox" className="h-6 w-6" checked={actualItems.includes(item)} onChange={()=>setActualItems(old=>old.includes(item)?old.filter(x=>x!==item):[...old,item])}/>{item}</label>)}</div><p className="mb-3 text-sm">實際完成項目至少要有一項。</p>{away&&<div className="mb-3 rounded-lg bg-yellow-50 p-3"><p className="mb-2 font-bold text-yellow-900">診間暫時離開，已保留實際完成項目的選擇。</p><button disabled={busy||unavailable} className="room-away-button is-away" onClick={()=>void toggleAway()}>返回診間</button></div>}<button disabled={patientActionsDisabled||!actualItems.length} className="primary w-full disabled:opacity-40" onClick={()=>void finish()}>{busy?'同步中…':'確認完成並同步雲端'}</button></div></div>}
    {settingsOpen&&<UltrasoundUiSettingsPanel settings={uiSettings} onChange={applyUiSettings} onClose={()=>setSettingsOpen(false)} onReset={()=>{localStorage.removeItem(ULTRASOUND_UI_STORAGE_KEY);setUiSettings({...defaultUltrasoundUiSettings});}}/>}
    </section>;
}
function CompactPatient({patient,examination,room,away}:{patient:Participant;examination:Examination|null;room:string;away:boolean}){return <div className="room-patient mt-3 border-l-4 border-teal-700"><div className="flex min-w-0 items-baseline gap-2"><b className="room-patient-number shrink-0 text-teal-800">{patient.checkinNo??'—'}</b><strong className="room-patient-name min-w-0 break-words">{patient.name}</strong>{examination&&examination.roundNo>1&&<span className="rounded-full bg-violet-100 px-2 py-1 text-xs font-black text-violet-800">追加檢查</span>}</div><dl className="room-patient-details mt-1.5"><dt>工號</dt><dd>{patient.employeeNo}</dd><dt>時段</dt><dd className="whitespace-nowrap">{patient.slot}</dd><dt>狀態</dt><dd>{away?'暫時離開':examination?.status==='in_progress'?`檢查中・${examination.roomId}`:examination?.status==='completed'?'已完成':examination?.status==='waiting'?`等候追加・第 ${examination.roundNo} 輪`:`${patient.status}・${room}`}</dd></dl></div>}
function InfoBlock({label,value,strong=false}:{label:string;value:string;strong?:boolean}){return <div><p className="text-sm font-bold text-slate-500">{label}</p><p className={`mt-1 font-black ${strong?'text-3xl text-teal-800':'text-xl'}`}>{value}</p></div>}
function HistoryPanel({item,visits,open,toggle}:{item:UltrasoundItem;visits:HistoryVisit[];open:boolean;toggle:()=>void}){return <article className="room-history-panel"><button aria-expanded={open} onClick={toggle} className="room-history-toggle"><span>{item}｜最近三次</span>{open?<ChevronUp/>:<ChevronDown/>}</button>{open&&<div className="room-history-content">{!visits.length?<p className="room-history-empty">查無此項目歷年檢查紀錄。</p>:item==='腹部超音波'?<AbdominalTable visits={visits}/>:<div className="room-visit-grid">{visits.map(visit=><div key={visit.date} className="room-visit-card"><p className="room-visit-date"><Clock size={22}/>{visit.date}</p>{Object.entries(visit.details??{結果:visit.result}).map(([label,value])=><p key={label} className="room-visit-result"><b>{label}：</b>{displayUltrasoundResult(value)}</p>)}</div>)}</div>}</div>}</article>}
function AbdominalTable({visits}:{visits:HistoryVisit[]}){const rows=[['整體結果','整體結果'],['肝臟','肝臟'],['膽囊','膽囊'],['胰臟','胰臟'],['脾臟','脾臟'],['腎臟','腎臟'],['其他','其他']];return <div className="abdominal-history"><div className="room-table-wrap"><table className="room-history-table"><thead><tr><th>部位</th>{visits.map(v=><th key={v.date}>{v.date}</th>)}</tr></thead><tbody>{rows.map(([label,key])=><tr key={key}><th>{label}</th>{visits.map(v=><td key={v.date}>{displayUltrasoundResult(v.details?.[key]??'')}</td>)}</tr>)}</tbody></table></div><h4>B、C 肝原始檢驗資料</h4><div className="room-table-wrap"><table className="room-bc-table"><thead><tr><th>項目</th>{visits.map(v=><th key={v.date}>{v.date}</th>)}</tr></thead><tbody>{['HBsAg','Anti-HBs','Anti-HCV'].map(lab=><tr key={lab}><th>{lab}</th>{visits.map(v=><td key={v.date}>{v.labs?.[lab]??''}</td>)}</tr>)}</tbody></table></div></div>}
type ImportProgress={fileName:string;fileIndex:number;fileCount:number;stage:string;processed:number;total:number;percent:number};
type FileImportReport={fileName:string;sourceRows:number;validRecords:number;summary:HistoryImportSummary;errors:string[]};
const emptySummary=():HistoryImportSummary=>({inserted:0,skipped:0,pending:0,failed:0});
function ImportDialog({close}:{close:()=>void}){
  const[stats,setStats]=useState<Awaited<ReturnType<typeof historyStats>>|null>(null);const[busy,setBusy]=useState(false);const[message,setMessage]=useState('');const[summary,setSummary]=useState<HistoryImportSummary>(emptySummary());const[progress,setProgress]=useState<ImportProgress|null>(null);const[reports,setReports]=useState<FileImportReport[]>([]);
  const reload=()=>historyStats().then(setStats);useEffect(()=>{void reload();},[]);
  const choose=async(files:File[])=>{
    setBusy(true);setMessage('');setReports([]);const total=emptySummary();const completed:FileImportReport[]=[];
    try{
      for(let fileIndex=0;fileIndex<files.length;fileIndex++){
        const file=files[fileIndex];const update=(stage:string,processed=0,rowTotal=0)=>setProgress({fileName:file.name,fileIndex:fileIndex+1,fileCount:files.length,stage,processed,total:rowTotal,percent:rowTotal?Math.round(processed/rowTotal*100):0});
        try{
          update('正在讀取 Excel……');
          const parsed=await parseHistoryFile(file,event=>update(event.stage==='reading'?'正在讀取 Excel……':event.stage==='headers'?'正在辨識表頭……':`正在解析第 ${event.processed.toLocaleString()} / ${event.total.toLocaleString()} 列……`,event.processed,event.total));
          if(parsed.missing.length){
            const reason=`無法匯入：${file.name}\n工作表：${parsed.sheetName}\n原因：無法辨識必要表頭。\n已辨識表頭：${parsed.headers.join('、')||'（無）'}\n缺少欄位：${parsed.missing.join('、')}\n請確認 Excel 表頭是否在第一列，或選擇正確工作表。`;
            total.failed+=parsed.sourceRows||1;completed.push({fileName:file.name,sourceRows:parsed.sourceRows,validRecords:0,summary:{...emptySummary(),failed:parsed.sourceRows||1},errors:[reason]});setReports([...completed]);continue;
          }
          update('正在比對既有資料……',0,parsed.records.length);
          const result=await importHistory(parsed.records,file.name,{sourceRows:parsed.sourceRows,onProgress:value=>update(`正在寫入第 ${value.batch} / ${value.batches} 批……`,value.processed,value.total)});
          result.failed+=parsed.failed;for(const key of Object.keys(total) as (keyof HistoryImportSummary)[])total[key]+=result[key];
          completed.push({fileName:file.name,sourceRows:parsed.sourceRows,validRecords:parsed.records.length,summary:result,errors:parsed.rowErrors.slice(0,100).map(item=>`第 ${item.row} 列：${item.reason}`)});setReports([...completed]);setSummary({...total});
        }catch(error){total.failed++;completed.push({fileName:file.name,sourceRows:0,validRecords:0,summary:{...emptySummary(),failed:1},errors:[error instanceof Error?error.message:'無法解析 Excel。']});setReports([...completed]);setSummary({...total});}
      }
      setMessage(completed.some(report=>report.summary.failed||report.errors.length)?'匯入已結束，部分資料未成功；請查看下方摘要。':'匯入完成。');
    }finally{setBusy(false);setProgress(old=>old?{...old,stage:'匯入完成。',percent:100}:old);await reload();}
  };
  return <section className="mx-auto max-w-4xl"><header className="mb-5 flex items-center gap-4 border-b border-slate-200 pb-4"><button className="secondary" onClick={close}><ArrowLeft size={19}/>返回超音波診間</button><div><h2 className="text-2xl font-black">歷年資料管理</h2><p className="text-sm text-slate-600">支援一次選取多份正式健檢結果 Excel。</p></div></header><div className="rounded-2xl bg-white p-6 shadow-sm"><div className="mb-4 rounded-xl border-2 border-emerald-300 bg-emerald-50 p-4"><p className="flex gap-2 font-black text-emerald-950"><FolderLock/>歷年醫療資料只保存在本台裝置</p><p className="mt-2 text-sm text-emerald-900">身分證與歷年結果不會上傳 Supabase。</p></div>
    <div className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-4 sm:grid-cols-4"><InfoBlock label="匯入檔案" value={`${stats?.fileCount??0} 份`}/><InfoBlock label="有效紀錄" value={`${stats?.recordCount??0} 筆`}/><InfoBlock label="涵蓋年份" value={stats?.years.join('、')||'—'}/><InfoBlock label="最近匯入" value={stats?.lastImportAt?new Date(stats.lastImportAt).toLocaleString('zh-TW'):'—'}/></div>
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><InfoBlock label="本次新增" value={String(summary.inserted)}/><InfoBlock label="重複略過" value={String(summary.skipped)}/><InfoBlock label="待確認" value={String(summary.pending)}/><InfoBlock label="失敗" value={String(summary.failed)}/></div>
    <label className="secondary mt-5 w-full cursor-pointer border-dashed border-teal-600"><Upload/>{busy?'匯入處理中…':'選擇多份 Excel'}<input disabled={busy} type="file" accept=".xlsx,.xls" multiple className="sr-only" onChange={e=>{const selected=Array.from(e.target.files??[]);e.target.value='';void choose(selected);}}/></label>
    {progress&&<div className="mt-3 rounded-xl bg-sky-50 p-4" role="status"><b>{progress.fileName}（第 {progress.fileIndex} / {progress.fileCount} 份）</b><p>{progress.stage}</p><p>{progress.processed.toLocaleString()} / {progress.total.toLocaleString()} 筆（{progress.percent}%）</p><div className="mt-2 h-2 overflow-hidden rounded bg-sky-200"><div className="h-full bg-sky-700" style={{width:`${progress.percent}%`}}/></div></div>}
    {message&&<p className="mt-3 whitespace-pre-wrap rounded-xl bg-slate-100 p-3" role="alert">{message}</p>}
    {reports.map(report=><section key={report.fileName} className="mt-3 rounded-xl border p-4"><h4 className="font-black">{report.fileName}</h4><p className="mt-1 text-sm">來源資料列數：{report.sourceRows}；有效超音波紀錄數：{report.validRecords}；新增成功：{report.summary.inserted}；完全重複略過：{report.summary.skipped}；待人工確認：{report.summary.pending}；失敗：{report.summary.failed}</p>{report.errors.length>0&&<details className="mt-2"><summary className="cursor-pointer font-bold">錯誤摘要（{report.errors.length}）</summary><ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{report.errors.map((error,index)=><li className="whitespace-pre-wrap" key={index}>{error}</li>)}</ul></details>}</section>)}
    <button disabled={busy||!stats?.recordCount} className="secondary mt-5 w-full border-red-300 text-red-800 disabled:opacity-40" onClick={async()=>{if(confirm('確定清除本台裝置全部歷年超音波資料？此操作無法復原。')){await clearHistory();setSummary(emptySummary());setReports([]);setMessage('本機歷年資料已清除。');await reload();}}}><Trash2/>清除本機歷年資料</button>{stats&&!stats.recordCount&&<p className="mt-3 text-center font-bold text-slate-600">本台裝置尚未匯入歷年超音波資料。</p>}{stats&&stats.pending>0&&<p className="mt-3 rounded-xl bg-amber-50 p-3 font-bold text-amber-900">目前有 {stats.pending} 筆同人、同日、同項目但內容不同的待確認資料，未自動覆蓋。</p>}</div></section>;
}
