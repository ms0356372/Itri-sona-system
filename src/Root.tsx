import {lazy,Suspense,useEffect,useState} from 'react';
import {getPublicBoardRoute} from './features/public-board/routing';

// Keep workstation Auth, local databases and subscriptions out of the public route.
const Workstation=lazy(()=>import('./App'));
const PublicBoard=lazy(()=>import('./features/public-board/PublicBoard').then(module=>({default:module.PublicBoard})));

export default function Root(){
  const[route,setRoute]=useState(()=>getPublicBoardRoute(window.location.hash));
  useEffect(()=>{
    const changed=()=>setRoute(getPublicBoardRoute(window.location.hash));
    window.addEventListener('hashchange',changed);
    return()=>window.removeEventListener('hashchange',changed);
  },[]);
  return <Suspense fallback={<div role="status" className="grid min-h-screen place-items-center bg-slate-50 p-6 text-slate-600">{route?'正在載入目前等候進度…':'正在載入系統…'}</div>}>
    {route?<PublicBoard key={route.token} token={route.token}/>:<Workstation/>}
  </Suspense>;
}
