import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {UltrasoundRoom} from '../features/room/UltrasoundRoom';
import type {Examination,HistoricalRecord,Participant,Session,WorkStatus} from '../types';

const remote=vi.hoisted(()=>({queue:vi.fn(),history:vi.fn(),byId:vi.fn(),roomExamination:vi.fn(),examination:vi.fn(),start:vi.fn(),complete:vi.fn(),changed:vi.fn(),claimOwned:true}));
vi.mock('../features/workflow/service',()=>({getStandardWaitingQueue:remote.queue}));
vi.mock('../features/room/useRoomStates',()=>({useRoomStates:(sessionId:string|null)=>({rooms:sessionId?[{sessionId,roomId:'診間 1',status:'idle',updatedAt:''}]:[],roomCount:4,loading:false,error:'',refresh:vi.fn(async()=>{}),acceptRoom:vi.fn()})}));
vi.mock('../features/room/useRoomClaims',()=>({useRoomClaims:(sessionId:string|null)=>({roomId:sessionId&&remote.claimOwned?'診間 1':null,isOwned:Boolean(sessionId)&&remote.claimOwned,claimConfirmed:Boolean(sessionId)&&remote.claimOwned,loading:false,busy:false,error:'',warning:'',allOccupied:false,claims:sessionId?[{sessionId,roomId:'診間 1',isMine:remote.claimOwned,isClaimed:remote.claimOwned,claimedAt:null,claimExpiresAt:null,serverNow:''}]:[],selectRoom:vi.fn(async()=>true),refresh:vi.fn(async()=>{}),release:vi.fn(async()=>true),revoke:vi.fn()})}));
vi.mock('../features/sync/realtime',()=>({subscribeExaminations:()=>()=>{}}));
vi.mock('../features/history/db',()=>({findHistoryByEmployeeNo:remote.history,findHistoryByNationalId:remote.byId,historyStats:vi.fn(async()=>({recordCount:1,fileCount:1,years:[2025],lastImportAt:null,pending:0})),clearHistory:vi.fn(),importHistory:vi.fn()}));
vi.mock('../features/examination/service',()=>({getRoomExamination:remote.roomExamination,getExamination:remote.examination,listExaminations:vi.fn(async()=>[]),restoreDraft:vi.fn(async()=>null),saveExaminationDraft:vi.fn(async()=>{}),startExamination:remote.start,completeExamination:remote.complete,cloudNow:vi.fn(async()=>({offsetMs:0}))}));

const session:Session={id:'standard-room',companyName:'ITRI',sessionDate:'2026-10-16',status:'active',workflowMode:'standard',roomCount:4};
const person=(id:string,patch:Partial<Participant>={}):Participant=>({id,sessionId:session.id,sequence:99,employeeNo:`00${id}`,name:`完整姓名${id}`,gender:'男',slot:'07:30~08:00',groupCode:'A',plannedItems:['腹部超音波'],checkinNo:'A1',checkinSequence:1,status:'等候中',checkedInAt:'2026-10-15T23:30:00Z',promotedAt:null,calledAt:null,note:'',updatedAt:'2026-10-16T00:00:00Z',...patch});
const baseRows=()=>[person('D',{groupCode:'B',slot:'08:00~08:30',checkinNo:'B1'}),person('G',{groupCode:'G',slot:'10:30~11:00',checkinNo:'G1',promotedAt:'2026-10-16T00:00:01Z'}),person('C',{checkinNo:'A3'}),person('A',{checkinNo:'A1'}),person('B',{checkinNo:'A2'})];
const ranks=(ids:string[])=>new Map(ids.map((id,index)=>[id,index+1]));
const history:HistoricalRecord={fingerprint:'local',nationalId:'A123456789',employeeNo:'00A',name:'完整姓名A',year:2025,date:'2025-10-01',type:'腹部超音波',values:{整體結果:'本機歷年腹部結果'},sourceFile:'local.xlsx'};
const examination:Examination={id:'exam-1',participantId:'A',roundNo:1,roomId:'診間 1',startedAt:'2026-10-16T00:00:00Z',completedAt:null,durationSeconds:null,selectedItems:['腹部超音波'],actualItems:[],itemCount:0,status:'in_progress'};
const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
let root:Root;
let container:HTMLDivElement;

function button(label:string){const found=Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(node=>node.textContent===label);if(!found)throw new Error(`missing button ${label}`);return found;}
async function click(label:string){await act(async()=>{button(label).click();});}
async function render(rows:Participant[],current:Session|null=session){await act(async()=>{root.render(<UltrasoundRoom current={current} participants={rows} onChanged={remote.changed}/>);});}
async function settle(){await act(async()=>{await vi.advanceTimersByTimeAsync(125);});}
function selector(){const found=container.querySelector<HTMLSelectElement>('[aria-label="今日受檢者"]');if(!found)throw new Error('missing today selector');return found;}
function options(){return Array.from(selector().options).filter(option=>option.value);}
function ids(){return options().map(option=>option.value);}
function waitingIds(rows:Participant[]){const waiting=new Set(rows.filter(row=>row.status==='等候中').map(row=>row.id));return ids().filter(id=>waiting.has(id));}
async function select(id:string){await act(async()=>{const field=selector();field.value=id;field.dispatchEvent(new Event('change',{bubbles:true}));});}
async function showList(rows:Participant[]=baseRows(),current:Session=session){await render(rows,current);await click(current.workflowMode==='simple'?'今日名單':'今日排程');}
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((accept,deny)=>{resolve=accept;reject=deny;});return{promise,resolve,reject};}

describe('診間選擇今日受檢者共用正式候檢順位',()=>{
  beforeEach(()=>{
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;vi.useFakeTimers();localStorage.clear();
    vi.stubGlobal('matchMedia',vi.fn(()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()})));
    remote.queue.mockReset().mockResolvedValue(ranks(['A','B','C','G','D']));
    remote.history.mockReset().mockResolvedValue([history]);remote.byId.mockReset().mockResolvedValue([history]);
    remote.roomExamination.mockReset().mockResolvedValue(null);remote.examination.mockReset().mockResolvedValue(null);
    remote.start.mockReset().mockResolvedValue(examination);
    remote.complete.mockReset().mockResolvedValue({...examination,status:'completed',completedAt:'2026-10-16T00:01:05Z',durationSeconds:65,actualItems:['腹部超音波'],itemCount:1});
    remote.changed.mockReset().mockResolvedValue(undefined);remote.claimOwned=true;
    container=document.createElement('div');document.body.append(container);root=createRoot(container);
  });
  afterEach(async()=>{await act(async()=>{root.unmount();});container.remove();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;});

  it('standard使用server最終順位A B C G promoted D，顯示內部完整姓名',async()=>{
    await showList();expect(ids()).toEqual(['A','B','C','G','D']);expect(options().map(option=>option.textContent)).toEqual(['A1 完整姓名A（00A）','A2 完整姓名B（00B）','A3 完整姓名C（00C）','G1 完整姓名G（00G）','B1 完整姓名D（00D）']);
    expect(remote.queue).toHaveBeenCalledExactlyOnceWith(session.id);expect(selector().disabled).toBe(false);
  });

  it('不採姓名、工號、Excel sequence或原array作為standard主要排序',async()=>{
    const rows=baseRows().map((row,index)=>({...row,name:String(10-index),employeeNo:String(index),sequence:index}));
    await showList(rows);expect(ids()).toEqual(['A','B','C','G','D']);
    await render([...rows].reverse().map(row=>({...row})));await settle();expect(ids()).toEqual(['A','B','C','G','D']);expect(remote.queue).toHaveBeenCalledTimes(1);
  });

  it('遲到者effective group變更後直接採server順位，不以原checkinNo重排',async()=>{
    const rows=[person('late',{checkinNo:'A1',groupCode:'A',checkedInAt:'2026-10-16T02:00:00Z'}),person('ontime',{checkinNo:'B7',groupCode:'B',slot:'08:00~08:30',checkedInAt:'2026-10-16T00:00:00Z'})];
    remote.queue.mockResolvedValue(ranks(['ontime','late']));await showList(rows);expect(ids()).toEqual(['ontime','late']);
    remote.queue.mockResolvedValue(ranks(['late','ontime']));await render(rows.map(row=>row.id==='late'?{...row,checkedInAt:'2026-10-15T23:45:00Z'}:row));await settle();expect(ids()).toEqual(['late','ontime']);
  });

  it('提早安排及取消都由participant更新重讀同一server順位',async()=>{
    let rows:Participant[]=baseRows().map(row=>({...row,promotedAt:null}));remote.queue.mockResolvedValue(ranks(['A','B','C','D','G']));await showList(rows);expect(ids()).toEqual(['A','B','C','D','G']);
    rows=rows.map(row=>row.id==='G'?{...row,promotedAt:'2026-10-16T00:00:01Z'}:row);remote.queue.mockResolvedValue(ranks(['A','B','C','G','D']));await render(rows);await settle();expect(ids()).toEqual(['A','B','C','G','D']);
    rows=rows.map(row=>({...row,promotedAt:null}));remote.queue.mockResolvedValue(ranks(['A','B','C','D','G']));await render(rows);await settle();expect(ids()).toEqual(['A','B','C','D','G']);expect(remote.queue).toHaveBeenCalledTimes(3);
  });

  it.each(['已叫號','檢查中','上廁所','心電圖','先做其他','已完成'] as const)('前三A轉成%s後保留既有選項，等候者自然遞補B C G D',async status=>{
    await showList();const rows=baseRows().map(row=>row.id==='A'?{...row,status}:row);remote.queue.mockResolvedValue(ranks(['B','C','G','D']));await render(rows);await settle();
    expect(waitingIds(rows)).toEqual(['B','C','G','D']);expect(ids()).toContain('A');expect(options().find(option=>option.value==='A')?.disabled).toBe(false);
  });

  it('離開後返回等候者依server重新加入Base Queue，與promoted相對順位一致',async()=>{
    let rows=baseRows().map(row=>row.id==='A'?{...row,status:'已叫號' as WorkStatus}:row);remote.queue.mockResolvedValue(ranks(['B','C','G','D']));await showList(rows);expect(waitingIds(rows)).toEqual(['B','C','G','D']);
    rows=rows.map(row=>({...row,status:'等候中'}));remote.queue.mockResolvedValue(ranks(['A','B','C','G','D']));await render(rows);await settle();expect(waitingIds(rows)).toEqual(['A','B','C','G','D']);
  });

  it('所有非waiting狀態均保留原位置與選項，只重排waiting slots',async()=>{
    const statuses:WorkStatus[]=['未報到','已叫號','檢查中','上廁所','心電圖','先做其他','已完成'];
    const others=statuses.map((status,index)=>person(`other-${index}`,{status,checkedInAt:status==='未報到'?null:'2026-10-15T23:30:00Z'}));
    const rows=[baseRows()[0],others[0],baseRows()[1],others[1],baseRows()[2],others[2],baseRows()[3],others[3],baseRows()[4],...others.slice(4)];
    await showList(rows);expect(ids()).toEqual(['A','other-0','B','other-1','C','other-2','G','other-3','D','other-4','other-5','other-6']);
    expect(options()).toHaveLength(rows.length);for(const row of others)expect(options().find(option=>option.value===row.id)?.disabled).toBe(false);
  });

  it('standard新人報到後載入新順位，原名單及非waiting不被過濾',async()=>{
    await showList();const rows=[person('new',{checkedInAt:'2026-10-15T23:31:00Z',checkinNo:'A4'}),...baseRows()];remote.queue.mockResolvedValue(ranks(['A','B','C','G','new','D']));await render(rows);await settle();expect(ids()).toEqual(['A','B','C','G','new','D']);expect(remote.queue).toHaveBeenCalledTimes(2);
  });

  it('simple依1 2 3 10數字排序，新增報到後即時計算且不讀standard RPC',async()=>{
    const simple={...session,workflowMode:'simple' as const};
    const rows=[10,3,1,2].map(value=>person(String(value),{queueNumber:value,checkinNo:String(value),groupCode:null,slot:null,sequence:20-value}));
    await showList(rows,simple);expect(ids()).toEqual(['1','2','3','10']);
    await render([person('4',{queueNumber:4,checkinNo:'4',groupCode:null,slot:null}),...rows].reverse(),simple);expect(ids()).toEqual(['1','2','3','4','10']);expect(remote.queue).not.toHaveBeenCalled();expect(container.textContent).not.toContain('候檢順位');
  });

  it('尚未載入順位仍保留全部選項，只停用waiting並guard程式觸發選擇',async()=>{
    const pending=deferred<ReadonlyMap<string,number>>();remote.queue.mockReturnValue(pending.promise);
    const called=person('called',{status:'已叫號'});await showList([...baseRows(),called]);expect(options()).toHaveLength(6);expect(selector().disabled).toBe(false);expect(container.textContent).toContain('候檢順位讀取中');
    for(const option of options().filter(option=>option.value!=='called')){expect(option.disabled).toBe(true);expect(option.textContent).toContain('順位未確認');}
    await select('A');expect(remote.history).not.toHaveBeenCalled();expect(remote.examination).not.toHaveBeenCalled();
    expect(options().find(option=>option.value==='called')?.disabled).toBe(false);await select('called');expect(remote.history).toHaveBeenCalledWith('00called');expect(container.querySelector('.room-patient-name')?.textContent).toBe('完整姓名called');
    await act(async()=>{pending.resolve(ranks(['A','B','C','G','D']));});expect(container.querySelector('.room-patient-name')?.textContent).toBe('完整姓名called');
  });

  it('順位失敗可重試，成功前不使用另一份本機或Base排序',async()=>{
    remote.queue.mockRejectedValueOnce(new Error('network unavailable'));await showList();expect(container.querySelector('[role="alert"]')?.textContent).toContain('等候中人員的順位尚未確認');expect(ids()).toEqual(baseRows().map(row=>row.id));expect(options().every(option=>option.disabled)).toBe(true);
    await click('重試順位');expect(ids()).toEqual(['A','B','C','G','D']);expect(options().every(option=>!option.disabled)).toBe(true);expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('server snapshot缺少目前等待者時保留全選項並提供重試，完整順位抵達後恢復排序',async()=>{
    remote.queue.mockResolvedValueOnce(ranks(['A','B','C','G']));
    const called=person('called',{status:'已叫號'});await showList([...baseRows(),called]);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('候檢名單正在同步，順位尚未確認');
    expect(options()).toHaveLength(6);expect(selector().disabled).toBe(false);
    for(const option of options())expect(option.disabled).toBe(option.value!=='called');
    await click('重試順位');expect(ids()).toEqual(['A','B','C','G','D','called']);
    expect(options().every(option=>!option.disabled)).toBe(true);expect(container.querySelector('[role="alert"]')).toBeNull();expect(remote.queue).toHaveBeenCalledTimes(2);
  });

  it('順位錯誤不鎖住工號查詢、歷年資料、開始與完成檢查',async()=>{
    remote.queue.mockRejectedValueOnce(new Error('network'));await showList();await click('工號');
    const field=container.querySelector<HTMLInputElement>('input[placeholder="請輸入工號"]')!;
    const setValue=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;
    await act(async()=>{setValue.call(field,'00A');field.dispatchEvent(new Event('input',{bubbles:true}));});await click('查詢');
    expect(container.querySelector('.room-patient-name')?.textContent).toBe('完整姓名A');await click('腹部超音波');expect(container.querySelector('.room-history')?.textContent).toContain('本機歷年腹部結果');
    expect(button('開始檢查').disabled).toBe(false);await click('開始檢查');expect(remote.start).toHaveBeenCalledExactlyOnceWith('A','診間 1',['腹部超音波']);
    await click('完成檢查');await click('確認完成並同步雲端');expect(remote.complete).toHaveBeenCalledExactlyOnceWith('exam-1','A','診間 1',['腹部超音波']);expect(container.textContent).toContain('檢查已完成');expect(remote.changed).toHaveBeenCalledTimes(2);
  });

  it('順位更新不重設已選受檢者、檢查項目與歷年資料',async()=>{
    await showList();await select('A');await click('腹部超音波');expect(container.querySelector('.room-history')?.textContent).toContain('本機歷年腹部結果');
    const previousReads=remote.queue.mock.calls.length;await render(baseRows().map(row=>row.id==='G'?{...row,promotedAt:null}:row));await settle();
    expect(container.querySelector('.room-patient-name')?.textContent).toBe('完整姓名A');expect(button('腹部超音波').getAttribute('aria-pressed')).toBe('true');expect(button('開始檢查').disabled).toBe(false);expect(container.querySelector('.room-history')?.textContent).toContain('本機歷年腹部結果');expect(remote.queue).toHaveBeenCalledTimes(previousReads);
  });

  it('相同場次切換列表前後不沿用過期順位',async()=>{
    await showList();await select('A');remote.queue.mockResolvedValue(ranks(['D','G','C','B','A']));await click('換下一位');expect(ids()).toEqual(['D','G','C','B','A']);expect(remote.queue).toHaveBeenCalledTimes(2);
  });

  it('跨場次延遲回應不能覆蓋新場次順位',async()=>{
    const old=deferred<ReadonlyMap<string,number>>();remote.queue.mockReturnValueOnce(old.promise);await showList();
    const next={...session,id:'next-session'};const rows=[person('X',{sessionId:next.id}),person('Y',{sessionId:next.id})];remote.queue.mockResolvedValue(ranks(['Y','X']));await render(rows,next);await click('今日排程');expect(ids()).toEqual(['Y','X']);
    await act(async()=>{old.resolve(ranks(['A','B','C','G','D']));});expect(ids()).toEqual(['Y','X']);
  });

  it('未選場次、未開列表及demo不讀取standard順位，claim限制維持',async()=>{
    await render([],null);expect(remote.queue).not.toHaveBeenCalled();expect(button('今日排程').disabled).toBe(true);
    await render(baseRows());expect(remote.queue).not.toHaveBeenCalled();await click('展示');expect(remote.queue).not.toHaveBeenCalled();
    await render(baseRows(),{...session,id:'another-session'});remote.claimOwned=false;await render(baseRows());expect(button('今日排程').disabled).toBe(true);expect(button('開始檢查').disabled).toBe(true);expect(remote.start).not.toHaveBeenCalled();
  });
});
