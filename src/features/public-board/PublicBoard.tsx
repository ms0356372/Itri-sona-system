import {useEffect,useState} from 'react';
import {formatTaiwanClock} from '../../lib/time';
import {BoardQrCode} from './BoardQrCode';
import {fetchPublicBoard,type PublicBoardData} from './service';

const REFRESH_INTERVAL_MS=10_000;
type BoardView={token:string;status:'loading'|'ready'|'closed'|'error';data:PublicBoardData|null;lastUpdatedAt:string|null};
const initialView=(token:string):BoardView=>({token,status:'loading',data:null,lastUpdatedAt:null});

function usePublicBoard(token:string){
  const [view,setView]=useState<BoardView>(()=>initialView(token));

  useEffect(()=>{
    let disposed=false;
    let request:AbortController|null=null;
    let interval:ReturnType<typeof setInterval>|null=null;
    setView(initialView(token));

    const refresh=async()=>{
      if(disposed||document.visibilityState!=='visible'||request)return;
      const controller=new AbortController();
      request=controller;
      try{
        const data=await fetchPublicBoard(token,controller.signal);
        if(disposed||controller.signal.aborted||request!==controller||document.visibilityState!=='visible')return;
        setView({token,status:data?'ready':'closed',data,lastUpdatedAt:new Date().toISOString()});
      }catch{
        if(disposed||controller.signal.aborted||request!==controller||document.visibilityState!=='visible')return;
        setView(previous=>({token,status:'error',data:null,lastUpdatedAt:previous.token===token?previous.lastUpdatedAt:null}));
      }finally{
        if(request===controller)request=null;
      }
    };

    const pause=()=>{
      if(interval!==null){clearInterval(interval);interval=null;}
      request?.abort();
      request=null;
    };
    const resume=()=>{
      if(document.visibilityState!=='visible'){pause();return;}
      if(interval!==null)clearInterval(interval);
      void refresh();
      interval=setInterval(()=>{void refresh();},REFRESH_INTERVAL_MS);
    };
    document.addEventListener('visibilitychange',resume);
    resume();
    return()=>{
      disposed=true;
      pause();
      document.removeEventListener('visibilitychange',resume);
    };
  },[token]);

  return view.token===token?view:initialView(token);
}

export function PublicBoard({token}:{token:string}){
  const view=usePublicBoard(token);
  const boardUrl=window.location.href;
  const sessionDate=view.data?.sessionDate.replaceAll('-','/');

  return <main className="min-h-dvh bg-slate-50 text-slate-900">
    <div className="mx-auto w-full max-w-[112rem] px-4 py-6 sm:px-8 sm:py-10 lg:px-12">
      <header className="flex min-w-0 flex-col gap-6 border-b border-slate-200 pb-6 md:flex-row md:items-start md:justify-between md:gap-10">
        <div className="min-w-0 pt-2">
          <h1 className="break-words text-3xl font-black leading-tight tracking-tight text-teal-900 sm:text-4xl lg:text-5xl">超音波目前等候名單</h1>
          {view.data&&<p className="mt-4 break-words text-xl font-semibold text-slate-600 sm:text-2xl">{view.data.companyName}｜{sessionDate}</p>}
        </div>
        <figure className="flex max-w-full shrink-0 flex-col items-center gap-2 self-end rounded-2xl border border-slate-200 bg-white p-4 text-center md:w-60">
          <BoardQrCode value={boardUrl}/>
          <figcaption className="max-w-52">
            <p className="text-base font-bold text-teal-900">手機查看等候進度</p>
            <p className="mt-1 text-sm leading-relaxed text-slate-600">掃描 QR Code 即可查看目前超音波等候名單</p>
            <p className="mt-2 text-sm text-slate-500">畫面每 10 秒自動更新</p>
          </figcaption>
        </figure>
      </header>

      <section aria-label="目前超音波等候名單" aria-busy={view.status==='loading'} className="py-6 sm:py-8">
        {view.status==='loading'&&<p role="status" className="rounded-2xl bg-white px-6 py-10 text-center text-xl font-semibold text-slate-600">正在載入目前等候進度…</p>}
        {view.status==='closed'&&<p role="status" className="rounded-2xl bg-white px-6 py-10 text-center text-xl font-semibold text-slate-600">此場次目前未開放等候進度查詢。</p>}
        {view.status==='error'&&<p role="status" className="rounded-2xl bg-amber-50 px-6 py-10 text-center text-xl font-semibold text-amber-900">目前無法取得等候進度，系統將自動重試。</p>}
        {view.status==='ready'&&(view.data?.people.length?<ul aria-label="等候受檢者" className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {view.data.people.map((person,index)=><li key={`${person.employeeNo}-${index}`} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-2xl border border-slate-200 bg-white px-5 py-6 shadow-sm sm:px-6">
            <span className="min-w-0 break-all text-2xl font-bold tabular-nums tracking-wide text-slate-700 lg:text-3xl">{person.employeeNo}</span>
            <span className="min-w-0 break-all text-3xl font-black tracking-wider text-teal-900 lg:text-4xl">{person.maskedName}</span>
          </li>)}
        </ul>:<p role="status" className="rounded-2xl bg-white px-6 py-10 text-center text-xl font-semibold text-slate-600">目前無受檢者等候超音波檢查</p>)}
      </section>

      {view.lastUpdatedAt&&<p className="text-right text-sm tabular-nums text-slate-500 sm:text-base">最後更新：<time dateTime={view.lastUpdatedAt}>{formatTaiwanClock(view.lastUpdatedAt)}</time></p>}
    </div>
  </main>;
}
