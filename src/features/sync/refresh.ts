export type RefreshCoalescer={
  refresh:(invalidate?:boolean)=>Promise<void>;
  schedule:(invalidate?:boolean)=>Promise<void>;
  dispose:()=>void;
};

type Cycle={promise:Promise<void>;resolve:()=>void;reject:(error:unknown)=>void};

// One controller owns one caller-defined scope. This shares reads, not cached
// data: mutations during a read require a trailing read of their committed data.
export function createRefreshCoalescer(task:()=>Promise<void>,delayMs=100):RefreshCoalescer{
  let cycle:Cycle|null=null;
  let timer:ReturnType<typeof setTimeout>|null=null;
  let running=false;
  let dirty=false;
  let disposed=false;

  const pending=()=>{
    if(!cycle){
      let resolve!:()=>void;let reject!:(error:unknown)=>void;
      const promise=new Promise<void>((accept,deny)=>{resolve=accept;reject=deny;});
      cycle={promise,resolve,reject};
    }
    return cycle;
  };
  const cancelTimer=()=>{if(timer!==null){clearTimeout(timer);timer=null;}};
  const finish=(failed:boolean,error:unknown)=>{
    const completed=cycle;cycle=null;
    if(failed)completed?.reject(error);else completed?.resolve();
  };
  const execute=async()=>{
    if(disposed||running)return;
    running=true;dirty=false;
    let failed=false;let error:unknown;
    try{await task();}catch(reason){failed=true;error=reason;}
    running=false;
    if(disposed)return;
    if(dirty){
      // A fixed burst window never postpones updates indefinitely. If it
      // elapsed during this read, the trailing read starts immediately.
      if(timer===null)void execute();
    }else finish(failed,error);
  };
  const refresh=(invalidate=false):Promise<void>=>{
    if(disposed)return Promise.resolve();
    const promise=pending().promise;
    cancelTimer();
    if(running){if(invalidate)dirty=true;}
    else void execute();
    return promise;
  };
  const schedule=(invalidate=true):Promise<void>=>{
    if(disposed)return Promise.resolve();
    const promise=pending().promise;
    if(running&&!invalidate)return promise;
    if(running)dirty=true;
    if(timer===null)timer=setTimeout(()=>{timer=null;if(!running)void execute();},delayMs);
    return promise;
  };
  const dispose=()=>{
    if(disposed)return;
    disposed=true;dirty=false;cancelTimer();
    // Disposal cannot cancel an already-sent HTTP request. Callers retain their
    // generation/session guards; outstanding waiters need not await that request.
    finish(false,undefined);
  };
  return{refresh,schedule,dispose};
}
