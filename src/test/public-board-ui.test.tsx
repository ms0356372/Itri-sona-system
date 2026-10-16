import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {QRCodeSVG} from 'qrcode.react';
import {PublicBoard} from '../features/public-board/PublicBoard';
import {fetchPublicBoard,type PublicBoardData} from '../features/public-board/service';

vi.mock('../features/public-board/service',()=>({fetchPublicBoard:vi.fn()}));
vi.mock('qrcode.react',()=>({QRCodeSVG:vi.fn(({value,size,role,title}:{value:string;size:number;role:string;title:string})=><svg data-encoded-value={value} width={size} height={size} role={role}><title>{title}</title></svg>)}));

const data:PublicBoardData={companyName:'ITRI',sessionDate:'2026-10-15',people:[{employeeNo:'00123456',maskedName:'王○明'},{employeeNo:'123872',maskedName:'林○華'},{employeeNo:'125103',maskedName:'歐○○明'}]};
const read=vi.mocked(fetchPublicBoard);
const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
let container:HTMLDivElement;
let root:Root;
let mounted:boolean;
let visibility:ReturnType<typeof vi.spyOn>;

function deferred<T>(){
  let resolve!:(value:T)=>void;
  let reject!:(reason?:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
async function flush(){for(let i=0;i<8;i++)await Promise.resolve();}
async function mount(token='public-token'){
  await act(async()=>{root.render(<PublicBoard token={token}/>);await flush();});
}
async function advance(milliseconds:number){await act(async()=>{await vi.advanceTimersByTimeAsync(milliseconds);});}
async function changeVisibility(state:DocumentVisibilityState){
  visibility.mockReturnValue(state);
  await act(async()=>{document.dispatchEvent(new Event('visibilitychange'));await flush();});
}
async function unmount(){
  await act(async()=>{root.unmount();});
  mounted=false;
}

describe('公開唯讀超音波等候看板',()=>{
  beforeEach(()=>{
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T10:35:20Z'));
    visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
    read.mockReset();
    read.mockResolvedValue(data);
    vi.mocked(QRCodeSVG).mockClear();
    window.history.replaceState(null,'','/Itri-sona-system/#/board/public-token');
    container=document.createElement('div');document.body.append(container);root=createRoot(container);mounted=true;
  });
  afterEach(async()=>{
    if(mounted)await unmount();
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;
  });

  it('無需工作人員登入即可立即取得公開名單，僅顯示公司、日期、完整工號與遮罩姓名',async()=>{
    await mount();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('public-token',expect.any(AbortSignal));
    expect(container.querySelector('h1')?.textContent).toBe('超音波目前等候名單');
    expect(container.textContent).toContain('ITRI｜2026/10/15');
    expect(container.textContent).toContain('00123456');
    expect(container.textContent).toContain('王○明');
    expect(container.textContent).toContain('歐○○明');
    expect(container.querySelectorAll('li')).toHaveLength(3);
    expect(container.querySelector('button,a,input,select,nav,table')).toBeNull();
    for(const forbidden of ['登入','帳號','報到編號','診間','A1','項目','狀態','王小明','身分證','性別','電話','分機','歷年資料','開始檢查','完成檢查']){
      expect(container.textContent).not.toContain(forbidden);
    }
  });

  it('第一次回應前顯示載入文字，且不預先顯示更新時間',async()=>{
    const response=deferred<PublicBoardData|null>();read.mockReturnValue(response.promise);
    await mount();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('正在載入目前等候進度…');
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelector('time')).toBeNull();
  });

  it('成功後顯示台灣 HH:mm:ss 最後更新時間',async()=>{
    await mount();
    expect(container.querySelector('time')?.textContent).toBe('18:35:20');
    expect(container.querySelector('time')?.dateTime).toBe('2026-10-15T10:35:20.000Z');
    expect(container.textContent).toContain('最後更新：18:35:20');
  });

  it('每 10 秒更新一次，前 1 秒與 2 秒不發送高頻請求',async()=>{
    await mount();
    await advance(1000);expect(read).toHaveBeenCalledTimes(1);
    await advance(1000);expect(read).toHaveBeenCalledTimes(1);
    await advance(7999);expect(read).toHaveBeenCalledTimes(1);
    await advance(1);expect(read).toHaveBeenCalledTimes(2);
    expect(container.querySelector('time')?.textContent).toBe('18:35:30');
    await advance(10_000);expect(read).toHaveBeenCalledTimes(3);
  });

  it('後續成功更新替換名單並保留伺服器提供的 queue 排序',async()=>{
    await mount();
    read.mockResolvedValueOnce({...data,people:[data.people[2],data.people[0]]});
    await advance(10_000);
    expect(Array.from(container.querySelectorAll('li')).map(element=>element.textContent)).toEqual(['1125103歐○○明可進入超音波等候區','200123456王○明可進入超音波等候區']);
    expect(container.textContent).not.toContain('林○華');
  });

  it('未報到或已不在等候中的資料由公開層排除後，不保留舊的受檢者',async()=>{
    await mount();
    read.mockResolvedValueOnce({...data,people:[data.people[1]]});
    await advance(10_000);
    expect(container.querySelectorAll('li')).toHaveLength(1);
    expect(container.textContent).toContain('123872');
    expect(container.textContent).not.toContain('00123456');
  });

  it('頁面 hidden 時停止輪詢，visible 時立即重新取得資料並恢復 10 秒節奏',async()=>{
    await mount();await advance(3000);
    await changeVisibility('hidden');
    await advance(60_000);expect(read).toHaveBeenCalledTimes(1);
    await changeVisibility('visible');expect(read).toHaveBeenCalledTimes(2);
    await advance(9999);expect(read).toHaveBeenCalledTimes(2);
    await advance(1);expect(read).toHaveBeenCalledTimes(3);
  });

  it('首次進入即為背景分頁時不請求，直到 visible 才載入',async()=>{
    visibility.mockReturnValue('hidden');
    await mount();await advance(30_000);
    expect(read).not.toHaveBeenCalled();
    expect(container.textContent).toContain('正在載入目前等候進度…');
    await changeVisibility('visible');
    expect(read).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('王○明');
  });

  it('背景化會中止進行中的請求，恢復前景後不接受舊回應',async()=>{
    const oldResponse=deferred<PublicBoardData|null>();
    read.mockReturnValueOnce(oldResponse.promise).mockResolvedValueOnce({...data,companyName:'新回應公司'});
    await mount();
    const signal=read.mock.calls[0][1]!;
    await changeVisibility('hidden');expect(signal.aborted).toBe(true);
    await changeVisibility('visible');expect(read).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('新回應公司');
    await act(async()=>{oldResponse.resolve({...data,companyName:'過期回應公司'});await flush();});
    expect(container.textContent).toContain('新回應公司');
    expect(container.textContent).not.toContain('過期回應公司');
  });

  it('上一個請求尚未完成時不重疊輪詢',async()=>{
    const response=deferred<PublicBoardData|null>();read.mockReturnValueOnce(response.promise);
    await mount();await advance(30_000);
    expect(read).toHaveBeenCalledTimes(1);
    await act(async()=>{response.resolve(data);await flush();});
    await advance(10_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('多次 visible 事件不建立重疊請求或多組輪詢',async()=>{
    const response=deferred<PublicBoardData|null>();read.mockReturnValueOnce(response.promise);
    await mount();await changeVisibility('visible');await changeVisibility('visible');
    expect(read).toHaveBeenCalledTimes(1);
    await act(async()=>{response.resolve(data);await flush();});
    await advance(10_000);expect(read).toHaveBeenCalledTimes(2);
    await advance(10_000);expect(read).toHaveBeenCalledTimes(3);
  });

  it('卸載時中止請求並清除輪詢與 visibility listener',async()=>{
    const response=deferred<PublicBoardData|null>();read.mockReturnValueOnce(response.promise);
    await mount();const signal=read.mock.calls[0][1]!;
    await unmount();expect(signal.aborted).toBe(true);
    await advance(30_000);await changeVisibility('visible');
    await act(async()=>{response.resolve(data);await flush();});
    expect(read).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('');
  });

  it('切換 token 立即清除舊名單，舊 token 遲到回應不得覆寫新 token',async()=>{
    const oldResponse=deferred<PublicBoardData|null>();
    const newResponse=deferred<PublicBoardData|null>();
    read.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise);
    await mount('old-token');
    const oldSignal=read.mock.calls[0][1]!;
    await mount('new-token');
    expect(oldSignal.aborted).toBe(true);
    expect(read.mock.calls[1][0]).toBe('new-token');
    await act(async()=>{newResponse.resolve({...data,companyName:'新場次'});await flush();});
    await act(async()=>{oldResponse.resolve({...data,companyName:'舊場次'});await flush();});
    expect(container.textContent).toContain('新場次');
    expect(container.textContent).not.toContain('舊場次');
  });

  it('切換 token 時不沿用舊場次的名單與最後更新時間',async()=>{
    await mount('old-token');
    expect(container.textContent).toContain('王○明');
    const response=deferred<PublicBoardData|null>();read.mockReturnValueOnce(response.promise);
    await mount('new-token');
    expect(container.textContent).not.toContain('王○明');
    expect(container.querySelector('time')).toBeNull();
    expect(container.textContent).toContain('正在載入目前等候進度…');
  });

  it('0 人時顯示空狀態，沒有空白表格',async()=>{
    read.mockResolvedValueOnce({...data,people:[]});
    await mount();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('目前無受檢者等候超音波檢查');
    expect(container.querySelector('table,ul,ol')).toBeNull();
    expect(container.textContent).toContain('ITRI｜2026/10/15');
  });

  it.each(['無效 token','停用看板','場次已刪除或已清除'])('%s 不顯示受檢者資料',async()=>{
    read.mockResolvedValueOnce(null);
    await mount();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('此場次目前未開放等候進度查詢。');
    expect(container.textContent).not.toContain('王○明');
    expect(container.textContent).not.toContain('00123456');
    expect(container.textContent).not.toContain('ITRI');
  });

  it('看板停用的下一次更新立即移除上一次名單',async()=>{
    await mount();
    read.mockResolvedValueOnce(null);
    await advance(10_000);
    expect(container.textContent).toContain('此場次目前未開放等候進度查詢。');
    expect(container.textContent).not.toContain('王○明');
    expect(container.querySelectorAll('li')).toHaveLength(0);
  });

  it('首次讀取失敗只顯示友善訊息，10 秒後自動重試成功',async()=>{
    read.mockRejectedValueOnce(new Error('Supabase internal participant UUID secret')).mockResolvedValueOnce(data);
    await mount();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('目前無法取得等候進度，系統將自動重試。');
    expect(container.textContent).not.toContain('secret');
    expect(container.textContent).not.toContain('Supabase');
    expect(container.querySelector('time')).toBeNull();
    await advance(10_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('王○明');
    expect(container.querySelector('time')?.textContent).toBe('18:35:30');
  });

  it('後續失敗清除過期名單並保留最後成功時間，重試成功才更新時間',async()=>{
    await mount();
    read.mockRejectedValueOnce(new Error('private details'));
    await advance(10_000);
    expect(container.textContent).toContain('目前無法取得等候進度，系統將自動重試。');
    expect(container.textContent).not.toContain('王○明');
    expect(container.querySelector('time')?.textContent).toBe('18:35:20');
    await advance(10_000);
    expect(container.textContent).toContain('王○明');
    expect(container.querySelector('time')?.textContent).toBe('18:35:40');
  });

  it('QR Code 在本機產生，encode 目前完整的看板 URL 與 quiet margin',async()=>{
    const url='/Itri-sona-system/#/board/a-long-public-token?display=tv';
    window.history.replaceState(null,'',url);
    await mount('a-long-public-token');
    const qr=vi.mocked(QRCodeSVG).mock.calls.at(-1)![0];
    expect(qr.value).toBe(window.location.href);
    expect(qr.value).toContain('/Itri-sona-system/#/board/a-long-public-token?display=tv');
    expect(qr.marginSize).toBe(4);
    expect(qr.size).toBe(152);
    expect(container.querySelector('[role="img"]')).not.toBeNull();
    expect(container.querySelector('img,iframe')).toBeNull();
    expect(container.textContent).toContain('手機查看等候進度');
    expect(container.textContent).toContain('掃描 QR Code 即可查看目前超音波等候名單');
    expect(container.textContent).toContain('畫面每 10 秒自動更新');
  });
});
