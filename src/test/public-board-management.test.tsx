import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {getPublicBoardSettings,setPublicBoardEnabled} from '../features/public-board/management';
import {PublicBoardSettings} from '../features/public-board/PublicBoardSettings';
import type {Session} from '../types';

const remote=vi.hoisted(()=>({rpc:vi.fn(),from:vi.fn()}));
vi.mock('../lib/supabase',()=>({requireSupabase:()=>({rpc:remote.rpc,from:remote.from})}));
vi.mock('../features/public-board/routing',()=>({getPublicBoardUrl:(token:string)=>`https://example.test/Itri-sona-system/#/board/${token}`}));

const tokenA='a'.repeat(64);
const tokenB='b'.repeat(64);
const session:Session={id:'session-a',companyName:'ITRI',sessionDate:'2026-10-15',status:'active'};
type RpcResult={data:unknown;error:unknown};
const result=(data:unknown):RpcResult=>({data,error:null});
function deferred(){
  let resolve!:(value:RpcResult)=>void;
  const promise=new Promise<RpcResult>(done=>{resolve=done;});
  return{promise,resolve};
}

describe('公開看板的私有管理 RPC',()=>{
  beforeEach(()=>{remote.rpc.mockReset();remote.from.mockReset();});

  it('設定讀取僅使用驗證身分的專用 RPC，不查詢 health_sessions 或 participants',async()=>{
    remote.rpc.mockResolvedValue(result({enabled:true,token:tokenA,unneeded:'ignored'}));
    expect(await getPublicBoardSettings(session.id)).toEqual({enabled:true,token:tokenA});
    expect(remote.rpc).toHaveBeenCalledExactlyOnceWith('get_public_board_settings',{p_session_id:session.id});
    expect(remote.from).not.toHaveBeenCalled();
  });

  it.each([true,false])('啟用設定 %s 只傳入場次與目標狀態，由伺服器產生 token',async enabled=>{
    remote.rpc.mockResolvedValue(result({enabled,token:enabled?tokenA:null}));
    expect(await setPublicBoardEnabled(session.id,enabled)).toEqual({enabled,token:enabled?tokenA:null});
    expect(remote.rpc).toHaveBeenCalledExactlyOnceWith('set_public_board_enabled',{p_session_id:session.id,p_enabled:enabled});
    expect(remote.from).not.toHaveBeenCalled();
  });

  it('停用結果不把舊 token 提供給管理 UI',async()=>{
    remote.rpc.mockResolvedValue(result({enabled:false,token:tokenA}));
    expect(await getPublicBoardSettings(session.id)).toEqual({enabled:false,token:null});
  });

  it.each([null,[],{}, {enabled:'false',token:null},{enabled:true,token:null},{enabled:true,token:'session-a'},{enabled:false},{enabled:false,token:42}])('不完整或不安全的設定 %j 不會偽裝成可啟用狀態',async data=>{
    remote.rpc.mockResolvedValue(result(data));
    await expect(getPublicBoardSettings(session.id)).rejects.toThrow('設定格式不正確');
    await expect(setPublicBoardEnabled(session.id,true)).rejects.toThrow('設定格式不正確');
  });

  it('更新回應與目標不符視為失敗',async()=>{
    remote.rpc.mockResolvedValue(result({enabled:false,token:null}));
    await expect(setPublicBoardEnabled(session.id,true)).rejects.toThrow('設定未更新');
  });

  it.each(['get','set'])('%s RPC 原始權限失敗交由既有錯誤格式化處理，不進行替代寫入',async operation=>{
    const failure={code:'42501',message:'permission denied'};
    remote.rpc.mockResolvedValue({data:null,error:failure});
    await expect(operation==='get'?getPublicBoardSettings(session.id):setPublicBoardEnabled(session.id,true)).rejects.toEqual(failure);
    expect(remote.from).not.toHaveBeenCalled();
  });
});

describe('場次管理的受檢進度看板設定',()=>{
  const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
  let root:Root;
  let container:HTMLDivElement;
  let mounted:boolean;
  async function render(current:Session=session,disabled=false){
    await act(async()=>{root.render(<PublicBoardSettings session={current} disabled={disabled}/>);});
  }
  const button=(label:string)=>{
    const found=Array.from(container.querySelectorAll('button')).find(element=>element.textContent===label);
    if(!found)throw new Error(`找不到按鈕：${label}`);
    return found;
  };
  const url=()=>container.querySelector<HTMLInputElement>('input[aria-label="公開看板網址"]');
  const click=async(label:string)=>{await act(async()=>{button(label).click();});};
  beforeEach(()=>{
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;
    remote.rpc.mockReset();remote.from.mockReset();
    remote.rpc.mockImplementation(async(name:string,args:{p_enabled?:boolean})=>result({enabled:name==='set_public_board_enabled'&&args.p_enabled===true,token:name==='set_public_board_enabled'&&args.p_enabled?tokenA:null}));
    container=document.createElement('div');document.body.append(container);root=createRoot(container);mounted=true;
  });
  afterEach(async()=>{
    if(mounted)await act(async()=>{root.unmount();});
    container.remove();actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;
  });

  it('初次讀取顯示未啟用，不提供網址，也不自動啟用',async()=>{
    await render();
    expect(container.textContent).toContain('受檢進度看板');
    expect(container.textContent).toContain('未啟用');
    expect(button('啟用公開看板').disabled).toBe(false);
    expect(url()).toBeNull();
    expect(remote.rpc).toHaveBeenCalledExactlyOnceWith('get_public_board_settings',{p_session_id:session.id});
  });

  it('啟用成功後提供唯讀網址與安全另開連結；停用後立即移除網址',async()=>{
    await render();await click('啟用公開看板');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('已啟用');
    expect(url()?.value).toBe(`https://example.test/Itri-sona-system/#/board/${tokenA}`);
    expect(url()?.readOnly).toBe(true);
    const link=container.querySelector<HTMLAnchorElement>('a')!;
    expect(link.textContent).toBe('開啟看板');expect(link.href).toBe(url()?.value);
    expect(link.target).toBe('_blank');expect(link.rel).toBe('noopener noreferrer');
    expect(remote.rpc).toHaveBeenLastCalledWith('set_public_board_enabled',{p_session_id:session.id,p_enabled:true});
    await click('停用公開看板');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('未啟用');
    expect(url()).toBeNull();expect(container.querySelector('a')).toBeNull();
    expect(remote.rpc).toHaveBeenLastCalledWith('set_public_board_enabled',{p_session_id:session.id,p_enabled:false});
  });

  it('停用後重新啟用顯示伺服器新 token，不保留舊連結',async()=>{
    await render();await click('啟用公開看板');await click('停用公開看板');
    remote.rpc.mockResolvedValueOnce(result({enabled:true,token:tokenB}));
    await click('啟用公開看板');
    expect(url()?.value).toContain(tokenB);expect(container.innerHTML).not.toContain(tokenA);
  });

  it('重開設定時從伺服器讀取已啟用設定，不會重複啟用或輪替 token',async()=>{
    remote.rpc.mockResolvedValueOnce(result({enabled:true,token:tokenB}));
    await render();
    expect(url()?.value).toContain(tokenB);expect(button('停用公開看板').disabled).toBe(false);
    expect(remote.rpc).toHaveBeenCalledTimes(1);
  });

  it('首次讀取失敗只允許重新讀取，不把未知設定當成未啟用',async()=>{
    remote.rpc.mockResolvedValueOnce({data:null,error:{code:'42501',message:'permission denied'}});
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('此帳號沒有執行此功能的權限。');
    expect(container.textContent).not.toContain('啟用公開看板');expect(url()).toBeNull();
    await click('重新讀取看板設定');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button('啟用公開看板').disabled).toBe(false);
    expect(remote.rpc.mock.calls.map(call=>call[0])).toEqual(['get_public_board_settings','get_public_board_settings']);
  });

  it('格式錯誤的讀取結果顯示錯誤與重試，不產生錯誤的公開網址',async()=>{
    remote.rpc.mockResolvedValueOnce(result({enabled:true,token:'session-a'}));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('設定格式不正確');
    expect(button('重新讀取看板設定')).toBeDefined();expect(url()).toBeNull();
    expect(container.textContent).not.toContain('啟用公開看板');
  });

  it('讀取期間不顯示操作，完成前不誤判為未啟用',async()=>{
    const pending=deferred();remote.rpc.mockReturnValueOnce(pending.promise);
    await render();
    expect(container.textContent).toContain('正在讀取看板設定…');
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).not.toContain('未啟用');
    await act(async()=>{pending.resolve(result({enabled:true,token:tokenA}));});
    expect(url()?.value).toContain(tokenA);
  });

  it('更新失敗保留最後成功設定與網址，可重試停用',async()=>{
    remote.rpc.mockResolvedValueOnce(result({enabled:true,token:tokenA}));
    await render();
    remote.rpc.mockResolvedValueOnce({data:null,error:{message:'connection failed'}});
    await click('停用公開看板');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('無法更新看板設定：connection failed');
    expect(url()?.value).toContain(tokenA);expect(button('停用公開看板').disabled).toBe(false);
    await click('停用公開看板');
    expect(container.querySelector('[role="alert"]')).toBeNull();expect(url()).toBeNull();
  });

  it('啟用失敗不顯示成功網址或已啟用狀態',async()=>{
    await render();remote.rpc.mockRejectedValueOnce(new Error('network interrupted'));
    await click('啟用公開看板');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('未啟用');expect(url()).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('network interrupted');
    expect(button('啟用公開看板').disabled).toBe(false);
  });

  it('同步連點只送出一次更新，回應前保留原設定',async()=>{
    const pending=deferred();await render();remote.rpc.mockReturnValueOnce(pending.promise);
    await act(async()=>{button('啟用公開看板').click();button('啟用公開看板').click();});
    expect(remote.rpc).toHaveBeenCalledTimes(2);
    expect(button('正在啟用…').disabled).toBe(true);expect(url()).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('未啟用');
    await act(async()=>{pending.resolve(result({enabled:true,token:tokenA}));});
    expect(button('停用公開看板').disabled).toBe(false);expect(url()?.value).toContain(tokenA);
  });

  it.each(['closing','closed'] as const)('%s 場次不可啟用公開看板',async status=>{
    await render({...session,status});
    expect(button('啟用公開看板').disabled).toBe(true);
    expect(container.textContent).toContain('只有進行中的場次可以啟用公開看板');
    await click('啟用公開看板');expect(remote.rpc).toHaveBeenCalledTimes(1);
  });

  it('已結束場次若仍有啟用設定，可停用既有公開網址',async()=>{
    remote.rpc.mockResolvedValueOnce(result({enabled:true,token:tokenA}));
    await render({...session,status:'closed'});await click('停用公開看板');
    expect(remote.rpc).toHaveBeenLastCalledWith('set_public_board_enabled',{p_session_id:session.id,p_enabled:false});
    expect(url()).toBeNull();
  });

  it('父層停用時禁止更新，恢復後仍可正常操作',async()=>{
    await render(session,true);expect(button('啟用公開看板').disabled).toBe(true);
    await click('啟用公開看板');expect(remote.rpc).toHaveBeenCalledTimes(1);
    await render(session,false);await click('啟用公開看板');
    expect(url()?.value).toContain(tokenA);
    await render(session,true);expect(button('停用公開看板').disabled).toBe(true);
    await click('停用公開看板');expect(remote.rpc).toHaveBeenCalledTimes(2);
  });

  it('父層停用時也禁止失敗後的重新讀取',async()=>{
    remote.rpc.mockRejectedValueOnce(new Error('offline'));await render(session,true);
    expect(button('重新讀取看板設定').disabled).toBe(true);
    await click('重新讀取看板設定');expect(remote.rpc).toHaveBeenCalledTimes(1);
  });

  it('更新途中父層停用仍顯示完成結果，但保持操作停用',async()=>{
    await render();const pending=deferred();remote.rpc.mockReturnValueOnce(pending.promise);
    await click('啟用公開看板');await render(session,true);
    expect(button('正在啟用…').disabled).toBe(true);
    await act(async()=>{pending.resolve(result({enabled:true,token:tokenA}));});
    expect(url()?.value).toContain(tokenA);expect(button('停用公開看板').disabled).toBe(true);
    await click('停用公開看板');expect(remote.rpc).toHaveBeenCalledTimes(2);
  });

  it('切換場次後較慢的舊讀取不覆蓋新場次，也不洩出舊網址',async()=>{
    const pending=deferred();remote.rpc.mockReturnValueOnce(pending.promise);await render();
    await render({...session,id:'session-b'});
    expect(button('啟用公開看板').disabled).toBe(false);
    await act(async()=>{pending.resolve(result({enabled:true,token:tokenA}));});
    expect(url()).toBeNull();expect(container.querySelector('[role="status"]')?.textContent).toBe('未啟用');
    expect(remote.rpc).toHaveBeenLastCalledWith('get_public_board_settings',{p_session_id:'session-b'});
  });

  it('切換場次後舊更新結果不覆蓋新場次，舊 busy lock 也不阻塞新操作',async()=>{
    await render();const pending=deferred();remote.rpc.mockReturnValueOnce(pending.promise);
    await click('啟用公開看板');await render({...session,id:'session-b'});
    expect(button('啟用公開看板').disabled).toBe(false);expect(url()).toBeNull();
    await act(async()=>{pending.resolve(result({enabled:true,token:tokenA}));});
    expect(url()).toBeNull();
    remote.rpc.mockResolvedValueOnce(result({enabled:true,token:tokenB}));await click('啟用公開看板');
    expect(remote.rpc).toHaveBeenLastCalledWith('set_public_board_enabled',{p_session_id:'session-b',p_enabled:true});
    expect(url()?.value).toContain(tokenB);
  });

  it('切換場次即移除已載入的前一場次網址',async()=>{
    remote.rpc.mockResolvedValueOnce(result({enabled:true,token:tokenA}));await render();
    const pending=deferred();remote.rpc.mockReturnValueOnce(pending.promise);
    await render({...session,id:'session-b'});
    expect(url()).toBeNull();expect(container.textContent).toContain('正在讀取看板設定…');
    await act(async()=>{pending.resolve(result({enabled:false,token:null}));});
  });

  it('卸載後忽略尚未完成的設定讀取',async()=>{
    const pending=deferred();remote.rpc.mockReturnValueOnce(pending.promise);await render();
    await act(async()=>{root.unmount();});mounted=false;
    await act(async()=>{pending.resolve(result({enabled:true,token:tokenA}));});
    expect(container.innerHTML).toBe('');expect(remote.rpc).toHaveBeenCalledTimes(1);
  });

  it('卸載後忽略尚未完成的設定更新，不額外送出請求',async()=>{
    await render();const pending=deferred();remote.rpc.mockReturnValueOnce(pending.promise);
    await click('啟用公開看板');
    await act(async()=>{root.unmount();});mounted=false;
    await act(async()=>{pending.resolve(result({enabled:true,token:tokenA}));});
    expect(container.innerHTML).toBe('');expect(remote.rpc).toHaveBeenCalledTimes(2);
  });
});
