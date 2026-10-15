import {act} from 'react';
import {createRoot,type Root as ReactRoot} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import Root from '../Root';
import {getPublicBoardRoute,getPublicBoardUrl,isPublicBoardToken} from '../features/public-board/routing';
import {formatTaiwanClock} from '../lib/time';

const access=vi.hoisted(()=>({workstation:vi.fn(),publicBoard:vi.fn()}));
vi.mock('../App',()=>({default:()=>{access.workstation();return <div>內部工作系統</div>;}}));
vi.mock('../features/public-board/PublicBoard',()=>({PublicBoard:({token}:{token:string})=>{access.publicBoard(token);return <div data-public-token={token}>公開等候看板</div>;}}));
const token='1a'.repeat(32);

describe('GitHub Pages 公開 hash 網址',()=>{
  it('公開網址保留部署 base，重新整理只請求既有 index 路徑',()=>{
    const url=new URL(getPublicBoardUrl(token,'https://ms0356372.github.io'));
    expect(url.href).toBe('https://ms0356372.github.io/Itri-sona-system/#/board/'+token);
    expect(url.pathname).toBe('/Itri-sona-system/');
    expect(url.search).toBe('');expect(url.hash).toBe('#/board/'+token);
    expect(getPublicBoardRoute(url.hash)).toEqual({token});
  });
  it.each(['#/board','#/board/','#/board/not-a-token','#/board/'+token+'/extra','#/board/%ZZ'])('無效公開網址 %s 不落入登入頁',hash=>{
    expect(getPublicBoardRoute(hash)).toEqual({token:''});
  });
  it.each(['','#/console','#/board-other/value','#/room'])('其餘 hash 保留原內部系統 %s',hash=>{
    expect(getPublicBoardRoute(hash)).toBeNull();
  });
  it('拒絕把場次 UUID 或容易猜測資料當作 token',()=>{
    expect(isPublicBoardToken(token)).toBe(true);
    for(const invalid of ['11111111-1111-1111-1111-111111111111','20261015','ITRI','a'.repeat(63),'A'.repeat(64)]){
      expect(isPublicBoardToken(invalid)).toBe(false);
      expect(()=>getPublicBoardUrl(invalid,'https://example.test')).toThrow('看板連結無效');
    }
  });
  it('台灣最後更新時間含秒，午夜使用 00 時',()=>{
    expect(formatTaiwanClock('2026-10-15T10:35:20Z')).toBe('18:35:20');
    expect(formatTaiwanClock('2026-10-14T16:00:05Z')).toBe('00:00:05');
    expect(formatTaiwanClock(null)).toBe('—');
  });
});

describe('公開頁與工作站的載入隔離',()=>{
  let root:ReactRoot;let container:HTMLDivElement;
  const environment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
  beforeEach(()=>{
    environment.IS_REACT_ACT_ENVIRONMENT=true;access.workstation.mockClear();access.publicBoard.mockClear();
    window.history.replaceState(null,'','/Itri-sona-system/');
    container=document.createElement('div');document.body.append(container);root=createRoot(container);
  });
  afterEach(async()=>{await act(async()=>{root.unmount();});container.remove();window.history.replaceState(null,'','/Itri-sona-system/');environment.IS_REACT_ACT_ENVIRONMENT=false;});
  async function ready(text:string){
    for(let attempt=0;attempt<100;attempt++){
      if(container.textContent?.includes(text))return;
      await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
    }
    throw new Error('路由未載入');
  }
  async function render(hash:string){window.history.replaceState(null,'','/Itri-sona-system/'+hash);await act(async()=>{root.render(<Root/>);});}
  async function route(hash:string){await act(async()=>{window.history.replaceState(null,'','/Itri-sona-system/'+hash);window.dispatchEvent(new HashChangeEvent('hashchange'));});}

  it('未登入且已存工作站資料時，公開入口只掛載看板',async()=>{
    localStorage.setItem('itri-current-session','private-session');
    await render('#/board/'+token);await ready('公開等候看板');
    expect(access.workstation).not.toHaveBeenCalled();
    expect(access.publicBoard).toHaveBeenCalledWith(token);
    expect(container.querySelector('[data-public-token]')?.getAttribute('data-public-token')).toBe(token);
    expect(container.textContent).not.toContain('內部工作系統');
    localStorage.removeItem('itri-current-session');
  });
  it('錯誤 token 仍只掛載公開關閉頁，不啟動 Auth 與工作頁',async()=>{
    await render('#/board/bad');await ready('公開等候看板');
    expect(access.workstation).not.toHaveBeenCalled();
    expect(access.publicBoard).toHaveBeenCalledWith('');
  });
  it('一般網址維持既有內部 App，明確切到公開頁才掛載看板',async()=>{
    await render('');await ready('內部工作系統');
    expect(access.publicBoard).not.toHaveBeenCalled();
    await route('#/board/'+token);await ready('公開等候看板');
    expect(container.textContent).not.toContain('內部工作系統');
    await route('#/board/not-a-token');await ready('公開等候看板');
    expect(container.querySelector('[data-public-token]')?.getAttribute('data-public-token')).toBe('');
  });
});
