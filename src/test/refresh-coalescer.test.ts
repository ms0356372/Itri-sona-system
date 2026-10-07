import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createRefreshCoalescer} from '../features/sync/refresh';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(accept=>{resolve=accept;});return{promise,resolve};};

describe('同 scope refresh 聚合',()=>{
  beforeEach(()=>{vi.useFakeTimers();});
  afterEach(()=>{vi.useRealTimers();});

  it('同一交易連續三個事件只讀一次，使用固定100ms窗口',async()=>{
    const task=vi.fn(async()=>{});const refresh=createRefreshCoalescer(task);
    const first=refresh.schedule();
    await vi.advanceTimersByTimeAsync(60);
    expect(refresh.schedule()).toBe(first);
    await vi.advanceTimersByTimeAsync(30);
    expect(refresh.schedule()).toBe(first);
    await vi.advanceTimersByTimeAsync(10);await first;
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('focus、visibility與重新連線共用進行中的read，不再補讀',async()=>{
    const read=deferred();const task=vi.fn(()=>read.promise);const refresh=createRefreshCoalescer(task);
    const first=refresh.refresh();
    expect(refresh.schedule(false)).toBe(first);
    expect(refresh.refresh()).toBe(first);
    await vi.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledTimes(1);
    read.resolve();await first;
    await vi.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('read開始後的mutation事件必須補讀，且不並行發送同scope請求',async()=>{
    const firstRead=deferred();const secondRead=deferred();
    const task=vi.fn().mockImplementationOnce(()=>firstRead.promise).mockImplementationOnce(()=>secondRead.promise);
    const refresh=createRefreshCoalescer(task);const first=refresh.refresh();
    expect(refresh.schedule()).toBe(first);expect(refresh.schedule()).toBe(first);
    await vi.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledTimes(1);
    firstRead.resolve();await Promise.resolve();await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(2);
    let settled=false;void first.then(()=>{settled=true;});await Promise.resolve();expect(settled).toBe(false);
    secondRead.resolve();await first;expect(settled).toBe(true);
  });

  it('mutation在快速read期間到達時保留短聚合窗口及後續重讀',async()=>{
    const read=deferred();const task=vi.fn().mockImplementationOnce(()=>read.promise).mockResolvedValue(undefined);
    const refresh=createRefreshCoalescer(task);const result=refresh.refresh();
    refresh.schedule();read.resolve();await Promise.resolve();await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);await result;expect(task).toHaveBeenCalledTimes(2);
  });

  it('action後refresh(true)立即flush已排事件，等待新的快照',async()=>{
    const read=deferred();const task=vi.fn().mockImplementationOnce(()=>read.promise).mockResolvedValue(undefined);
    const refresh=createRefreshCoalescer(task);const first=refresh.refresh();refresh.schedule();
    expect(refresh.refresh(true)).toBe(first);
    read.resolve();await first;
    expect(task).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);expect(task).toHaveBeenCalledTimes(2);
  });

  it('手動refresh取消尚未開始的timer並立即讀取，不再重複排讀',async()=>{
    const task=vi.fn(async()=>{});const refresh=createRefreshCoalescer(task);const scheduled=refresh.schedule();
    expect(refresh.refresh(true)).toBe(scheduled);await scheduled;expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);expect(task).toHaveBeenCalledTimes(1);
  });

  it('dispose取消pending並釋放waiters，舊scope後續事件不發請求',async()=>{
    const task=vi.fn(async()=>{});const refresh=createRefreshCoalescer(task);const pending=refresh.schedule();
    refresh.dispose();await pending;await refresh.refresh(true);await refresh.schedule();
    await vi.advanceTimersByTimeAsync(100);expect(task).not.toHaveBeenCalled();
  });

  it('dispose時已送出的read不取消，但不再執行dirty trailing',async()=>{
    const read=deferred();const task=vi.fn(()=>read.promise);const refresh=createRefreshCoalescer(task);
    const pending=refresh.refresh();refresh.schedule();refresh.dispose();await pending;
    read.resolve();await vi.advanceTimersByTimeAsync(100);expect(task).toHaveBeenCalledTimes(1);
  });

  it('錯誤回傳給共用waiters，下一次可重新讀取',async()=>{
    const error=new Error('network');const task=vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const refresh=createRefreshCoalescer(task);const first=refresh.refresh();expect(refresh.refresh()).toBe(first);
    await expect(first).rejects.toBe(error);await refresh.refresh();expect(task).toHaveBeenCalledTimes(2);
  });

  it('已完成手動read後的新mutation仍必須讀取，不使用時間快取跳過事件',async()=>{
    const task=vi.fn(async()=>{});const refresh=createRefreshCoalescer(task);
    await refresh.refresh(true);const mutation=refresh.schedule();
    await vi.advanceTimersByTimeAsync(100);await mutation;expect(task).toHaveBeenCalledTimes(2);
  });
});
