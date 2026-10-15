import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const token='ab'.repeat(32);
const board={companyName:'ITRI',sessionDate:'2026-10-15',people:[{employeeNo:'00123456',maskedName:'王○明'}]};
const request=vi.fn<typeof fetch>();
const response=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
async function service(){return import('../features/public-board/service');}

describe('匿名公開查詢的實際 SDK 邊界',()=>{
  beforeEach(()=>{
    vi.stubEnv('VITE_SUPABASE_URL','https://public-board.example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY','public-publishable-test-key');
    request.mockReset().mockResolvedValue(response(board));
    vi.stubGlobal('fetch',request);
    localStorage.clear();
  });
  afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();vi.useRealTimers();localStorage.clear();});

  it('未設定雲端時不發送請求',async()=>{
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY','');
    await expect((await service()).fetchPublicBoard(token)).rejects.toThrow('public_board_unavailable');
    expect(request).not.toHaveBeenCalled();
  });

  it('存在工作人員 session 時，仍只發送匿名最小 RPC，不讀取已登入 JWT 或 Auth API',async()=>{
    localStorage.setItem('sb-public-board-auth-token',JSON.stringify({access_token:'staff-private-jwt-canary',refresh_token:'staff-refresh-canary',expires_at:4102444800,user:{id:'staff-id'}}));
    const storageRead=vi.spyOn(Storage.prototype,'getItem');
    const {fetchPublicBoard}=await service();
    expect(await fetchPublicBoard(token)).toEqual(board);
    expect(request).toHaveBeenCalledTimes(1);
    const [url,options]=request.mock.calls[0];
    expect(String(url)).toBe('https://public-board.example.supabase.co/rest/v1/rpc/get_public_waiting_board');
    expect(options?.method).toBe('POST');
    expect(JSON.parse(String(options?.body))).toEqual({p_token:token});
    const headers=new Headers(options?.headers);
    expect(headers.get('apikey')).toBe('public-publishable-test-key');
    expect(headers.get('authorization')).toBe('Bearer public-publishable-test-key');
    expect(JSON.stringify(request.mock.calls)).not.toContain('staff-private-jwt-canary');
    expect(storageRead.mock.calls.some(([key])=>key==='sb-public-board-auth-token'||key==='itri-public-board-anonymous')).toBe(false);
    expect(request.mock.calls.some(([url])=>String(url).includes('/auth/'))).toBe(false);
  });

  it.each(['','session-uuid','11111111-1111-1111-1111-111111111111','a'.repeat(63),'a'.repeat(65),'A'.repeat(64),'\' or true --'])('無效 token %s 不建立 SDK 或發送請求',async invalid=>{
    vi.stubEnv('VITE_SUPABASE_URL','');vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY','');
    expect(await (await service()).fetchPublicBoard(invalid)).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('停用／關閉／無效能力回應 null，不替代查詢 participants',async()=>{
    request.mockResolvedValue(response(null));
    expect(await (await service()).fetchPublicBoard(token)).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0][0])).not.toContain('/participants');
  });

  it('只將允許的公司、日期、工號與遮罩姓名交給畫面，不傳播額外欄位',async()=>{
    request.mockResolvedValue(response({...board,sessionId:'private-session',people:[{...board.people[0],full_name:'不可出現的姓名',room:'room_8',plannedItems:['private-medical'] }]}));
    expect(await (await service()).fetchPublicBoard(token)).toEqual(board);
  });

  it.each([[],{}, {companyName:'ITRI',sessionDate:'2026-10-15',people:[{employeeNo:123,maskedName:'王○明'}]},{companyName:'ITRI',sessionDate:'2026-10-15',people:[{employeeNo:'00123456',fullName:'王小明'}]}])('不完整公開回應不顯示假的名單 %j',async payload=>{
    request.mockResolvedValue(response(payload));
    await expect((await service()).fetchPublicBoard(token)).rejects.toThrow('public_board_unavailable');
  });

  it('Supabase 原始錯誤與細節不傳入公開 UI',async()=>{
    request.mockResolvedValue(response({message:'staff-private-jwt-canary',details:'sensitive schema details'},401));
    await expect((await service()).fetchPublicBoard(token)).rejects.toThrow(/^public_board_unavailable$/);
  });

  it('已取消的讀取不發送請求',async()=>{
    const controller=new AbortController();controller.abort();
    await expect((await service()).fetchPublicBoard(token,controller.signal)).rejects.toThrow('public_board_unavailable');
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['timeout','hidden'] as const)('%s 中斷卡住的請求，使下一個十秒更新仍可重試',async reason=>{
    vi.useFakeTimers();
    request.mockImplementationOnce((_url,options)=>new Promise((_resolve,reject)=>{
      options?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
    }));
    const {fetchPublicBoard}=await service();
    const controller=new AbortController();
    const reading=fetchPublicBoard(token,controller.signal);
    const rejected=expect(reading).rejects.toThrow('public_board_unavailable');
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    if(reason==='timeout')await vi.advanceTimersByTimeAsync(8000);else controller.abort();
    await rejected;
    expect(await fetchPublicBoard(token)).toEqual(board);
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
