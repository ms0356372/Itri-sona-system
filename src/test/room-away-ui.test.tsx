import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {UltrasoundRoom} from '../features/room/UltrasoundRoom';
import type {Examination,HistoricalRecord,Participant,RoomState,Session} from '../types';

type StoredRoom=RoomState;
const remote=vi.hoisted(()=>({
  rooms:[] as StoredRoom[],roomCount:undefined as number|undefined,loading:false,error:'',refresh:vi.fn(),acceptRoom:vi.fn(),setAway:vi.fn(),
  roomExamination:vi.fn(),examinations:vi.fn(),examination:vi.fn(),restoreDraft:vi.fn(),saveDraft:vi.fn(),start:vi.fn(),complete:vi.fn(),clock:vi.fn(),
  historyById:vi.fn(),historyByEmployee:vi.fn(),stats:vi.fn(),
}));
vi.mock('../features/room/useRoomStates',()=>({useRoomStates:()=>({rooms:remote.rooms,roomCount:remote.roomCount,loading:remote.loading,error:remote.error,refresh:remote.refresh,acceptRoom:remote.acceptRoom})}));
vi.mock('../features/room/service',async importOriginal=>({...await importOriginal<typeof import('../features/room/service')>(),setRoomAway:remote.setAway}));
vi.mock('../features/examination/service',()=>({getRoomExamination:remote.roomExamination,listExaminations:remote.examinations,getExamination:remote.examination,restoreDraft:remote.restoreDraft,saveExaminationDraft:remote.saveDraft,startExamination:remote.start,completeExamination:remote.complete,cloudNow:remote.clock}));
vi.mock('../features/history/db',()=>({findHistoryByNationalId:remote.historyById,findHistoryByEmployeeNo:remote.historyByEmployee,historyStats:remote.stats,clearHistory:vi.fn(),importHistory:vi.fn()}));

const session:Session={id:'room-session',companyName:'ITRI',sessionDate:'2026-10-07',status:'active'};
const participant=(patch:Partial<Participant>={}):Participant=>({id:'person-1',sessionId:session.id,sequence:8,employeeNo:'00125',name:'王小明',gender:'男',slot:'08:30~09:00',groupCode:'C',plannedItems:['腹部超音波','甲狀腺超音波'],checkinNo:'C8',status:'等候中',checkedInAt:'2026-10-07T00:01:00Z',calledAt:null,note:'',updatedAt:'2026-10-07T00:01:00Z',...patch});
const history=(patch:Partial<HistoricalRecord>={}):HistoricalRecord=>({fingerprint:'history-1',nationalId:'A123456789',employeeNo:'00125',name:'王小明',year:2025,date:'2025-09-10',type:'腹部超音波',values:{整體結果:'既往腹部結果',肝臟:'既往肝臟結果'},sourceFile:'local.xlsx',...patch});
const examination=(patch:Partial<Examination>={}):Examination=>({id:'exam-1',participantId:'person-1',roundNo:1,roomId:'診間 1',startedAt:'2026-10-07T00:02:00Z',completedAt:null,durationSeconds:null,selectedItems:['腹部超音波','甲狀腺超音波'],actualItems:[],itemCount:0,status:'in_progress',...patch});
const roomState=(roomId='診間 1',status:StoredRoom['status']='idle'):StoredRoom=>({sessionId:session.id,roomId,status,updatedAt:'2026-10-07T00:01:00Z'});
const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
let root:Root;
let container:HTMLDivElement;
let changed:ReturnType<typeof vi.fn>;

function button(label:string){
  const element=Array.from(container.querySelectorAll('button')).find(value=>value.textContent===label);
  if(!element)throw new Error(`找不到按鈕：${label}`);
  return element;
}
const dialog=()=>container.querySelector<HTMLElement>('[role="dialog"]');
function roomSelector(){
  const element=Array.from(container.querySelectorAll('select')).find(value=>Array.from(value.options).some(option=>option.value==='診間 1'));
  if(!element)throw new Error('找不到診間選擇。');
  return element;
}
function queryInput(){
  const element=container.querySelector<HTMLInputElement>('input[placeholder="請掃描或輸入身分證"],input[placeholder="請輸入工號"]');
  if(!element)throw new Error('找不到受檢者查詢欄位。');
  return element;
}
async function click(element:HTMLElement){await act(async()=>{element.click();});}
async function input(element:HTMLInputElement,value:string){
  const setValue=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;
  await act(async()=>{setValue.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));});
}
async function render(participants:Participant[]=[participant()],current:Session|null=session){
  await act(async()=>{root.render(<UltrasoundRoom current={current} participants={participants} onChanged={changed}/>);});
}
async function switchRoom(roomId:string){
  const selector=roomSelector();
  await act(async()=>{selector.value=roomId;selector.dispatchEvent(new Event('change',{bubbles:true}));});
}
async function loadPerson(){
  await render();
  await input(queryInput(),'A123456789');
  expect(container.querySelector('.room-patient-name')?.textContent).toBe('王小明');
  await click(button('腹部超音波'));
  expect(container.querySelector('.room-history')?.textContent).toContain('既往腹部結果');
}
function expectPatientAndHistory(){
  expect(container.querySelector('.room-patient-name')?.textContent).toBe('王小明');
  expect(container.querySelector('.room-patient-details')?.textContent).toContain('00125');
  expect(button('腹部超音波').getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelector('.room-history')?.textContent).toContain('2025-09-10');
  expect(container.querySelector('.room-history')?.textContent).toContain('既往腹部結果');
}
function updateRoom(roomId:string,status:StoredRoom['status']){
  remote.rooms=remote.rooms.map(value=>value.roomId===roomId?{...value,status}:value);
}

describe('超音波診間暫時離開',()=>{
  beforeEach(()=>{
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;
    localStorage.clear();
    vi.stubGlobal('matchMedia',vi.fn(()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()})));
    remote.rooms=[1,2,3,4].map(value=>roomState(`診間 ${value}`));
    remote.loading=false;remote.error='';remote.roomCount=undefined;
    for(const mock of [remote.refresh,remote.acceptRoom,remote.setAway,remote.roomExamination,remote.examinations,remote.examination,remote.restoreDraft,remote.saveDraft,remote.start,remote.complete,remote.clock,remote.historyById,remote.historyByEmployee,remote.stats])mock.mockReset();
    remote.refresh.mockResolvedValue(undefined);
    remote.acceptRoom.mockImplementation((room:StoredRoom)=>{remote.rooms=remote.rooms.map(value=>value.sessionId===room.sessionId&&value.roomId===room.roomId?room:value);});
    remote.setAway.mockImplementation(async(_sessionId:string,roomId:string,away:boolean)=>{
      updateRoom(roomId,away?'away':'idle');
      return remote.rooms.find(value=>value.roomId===roomId)!;
    });
    remote.roomExamination.mockResolvedValue(null);
    remote.examinations.mockResolvedValue([]);
    remote.examination.mockResolvedValue(null);
    remote.restoreDraft.mockResolvedValue(null);
    remote.saveDraft.mockResolvedValue(undefined);
    remote.start.mockResolvedValue(examination({selectedItems:['腹部超音波']}));
    remote.complete.mockResolvedValue(examination({status:'completed',completedAt:'2026-10-07T00:03:05Z',durationSeconds:65,actualItems:['腹部超音波'],itemCount:1}));
    remote.clock.mockResolvedValue({iso:'2026-10-07T00:02:00Z',offsetMs:0});
    remote.historyById.mockResolvedValue([history()]);
    remote.historyByEmployee.mockResolvedValue([history()]);
    remote.stats.mockResolvedValue({recordCount:1,fileCount:1,years:[2025],lastImportAt:'2026-10-07T00:00:00Z',pending:0});
    changed=vi.fn(async()=>{});
    container=document.createElement('div');document.body.append(container);root=createRoot(container);
  });
  afterEach(async()=>{
    await act(async()=>{root.unmount();});
    container.remove();
    vi.restoreAllMocks();vi.unstubAllGlobals();
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;
  });

  it.each([3,8])('設定%s間時選擇器只提供目前有效診間，保留雲端away狀態',async roomCount=>{
    remote.rooms=Array.from({length:8},(_,index)=>roomState(`診間 ${index+1}`,index===roomCount-1?'away':'idle'));
    await render([], {...session,roomCount});
    expect(Array.from(roomSelector().options).map(value=>value.value)).toEqual(Array.from({length:roomCount},(_,index)=>`診間 ${index+1}`));
    await switchRoom(`診間 ${roomCount}`);
    expect(button('返回診間').disabled).toBe(false);
    expect(button('開始檢查').disabled).toBe(true);
    expect(button('查詢').disabled).toBe(true);
  });

  it('已儲存的診間超出本場次設定時直接重設為診間1，重新整理仍只載入有效房號',async()=>{
    localStorage.setItem('itri-ultrasound-room','room_8');
    await render([], {...session,roomCount:2});
    expect(roomSelector().value).toBe('診間 1');
    expect(remote.roomExamination.mock.calls.every(([,roomId])=>roomId==='診間 1')).toBe(true);
    expect(localStorage.getItem('itri-ultrasound-room')).toBe('診間 1');
    await act(async()=>{root.unmount();});root=createRoot(container);
    await render([], {...session,roomCount:2});
    expect(roomSelector().options).toHaveLength(2);
    expect(roomSelector().value).toBe('診間 1');
  });

  it('即時減少診間後重設超範圍選取、清除受檢者及草稿，再增加時不恢復停用診間的舊畫面',async()=>{
    remote.rooms=Array.from({length:8},(_,index)=>roomState(`診間 ${index+1}`));
    const current={...session,roomCount:8};
    await render([participant()],current);await switchRoom('診間 8');
    await input(queryInput(),'A123456789');await click(button('腹部超音波'));
    expectPatientAndHistory();
    remote.roomCount=3;
    await render([participant()],current);
    expect(roomSelector().options).toHaveLength(3);
    expect(roomSelector().value).toBe('診間 1');
    expect(container.querySelector('.room-patient')).toBeNull();
    expect(queryInput().value).toBe('');
    expect(button('腹部超音波').getAttribute('aria-pressed')).toBe('false');
    remote.roomCount=8;await render([participant()],current);await switchRoom('診間 8');
    expect(container.querySelector('.room-patient')).toBeNull();
    expect(queryInput().value).toBe('');
    expect(button('腹部超音波').getAttribute('aria-pressed')).toBe('false');
  });

  it('切換到較少診間的場次會重設目前房號及受檢者，不沿用上一場次資料',async()=>{
    remote.rooms=Array.from({length:8},(_,index)=>roomState(`診間 ${index+1}`));
    await render([participant()], {...session,roomCount:8});await switchRoom('診間 7');
    await input(queryInput(),'A123456789');
    const next:Session={...session,id:'two-room-session',roomCount:2};
    remote.rooms=[roomState('診間 1'),roomState('診間 2')].map(value=>({...value,sessionId:next.id}));
    await render([],next);
    expect(roomSelector().options).toHaveLength(2);
    expect(roomSelector().value).toBe('診間 1');
    expect(container.querySelector('.room-patient')).toBeNull();
    expect(queryInput().value).toBe('');
    expect(remote.roomExamination).toHaveBeenLastCalledWith(next.id,'診間 1');
  });

  it('空診間的離開按鈕位於開始檢查右側，寫入正式狀態並且返回後恢復查詢',async()=>{
    await render([]);
    const start=button('開始檢查');const away=button('暫時離開');
    expect(start.compareDocumentPosition(away)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(start.closest('.room-toolbar-primary')).toBe(away.closest('.room-toolbar-primary'));
    expect(away.disabled).toBe(false);
    await click(away);
    expect(remote.setAway).toHaveBeenCalledWith(session.id,'診間 1',true);
    expect(remote.rooms[0].status).toBe('away');
    expect(button('返回診間').disabled).toBe(false);
    expect(button('開始檢查').disabled).toBe(true);
    expect(button('查詢').disabled).toBe(true);
    expect(queryInput().disabled).toBe(true);
    expect(container.textContent).toContain('暫時離開');
    const badge=Array.from(container.querySelectorAll('[role="status"]')).find(value=>value.textContent==='暫時離開');
    expect(badge?.querySelector('.bg-yellow-400')).not.toBeNull();
    await click(button('返回診間'));
    expect(remote.setAway).toHaveBeenLastCalledWith(session.id,'診間 1',false);
    expect(remote.rooms[0].status).toBe('idle');
    expect(button('暫時離開').disabled).toBe(false);
    expect(button('查詢').disabled).toBe(false);
    expect(queryInput().disabled).toBe(false);
  });

  it.each(['permission_denied','not_authorized'] as const)('開始檢查被拒絕時將%s轉為現場可理解的權限訊息',async reason=>{
    remote.start.mockRejectedValueOnce({code:'42501',message:reason});
    await loadPerson();await click(button('開始檢查'));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('此帳號沒有執行此功能的權限。');
    expect(container.textContent).not.toContain(reason);
    expect(container.textContent).not.toContain('無法連線至雲端');
    expectPatientAndHistory();
  });

  it('完成檢查被拒絕時顯示權限訊息並保留檢查確認視窗',async()=>{
    remote.examination.mockResolvedValue(examination());
    remote.complete.mockRejectedValueOnce({code:'42501',message:'permission_denied'});
    await render();await input(queryInput(),'A123456789');await click(button('完成檢查'));await click(button('確認完成並同步雲端'));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('此帳號沒有執行此功能的權限。');
    expect(dialog()).not.toBeNull();
    expect(container.querySelector('.room-patient-name')?.textContent).toBe('王小明');
  });

  it.each(['idle','away'] as const)('診間%s時離開或返回被拒絕，清楚顯示權限訊息而不更新房態',async status=>{
    remote.rooms[0]=roomState('診間 1',status);
    remote.setAway.mockRejectedValueOnce({code:'42501',message:'not_authorized'});
    await render([]);await click(button(status==='away'?'返回診間':'暫時離開'));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('此帳號沒有執行此功能的權限。');
    expect(remote.rooms[0].status).toBe(status);
    expect(remote.acceptRoom).not.toHaveBeenCalled();
  });

  it('重新載入診間資料被拒絕時呈現權限錯誤而不是網路同步失敗',async()=>{
    remote.roomExamination.mockRejectedValue({code:'42501',message:'permission_denied'});
    await render([]);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('此帳號沒有執行此功能的權限。');
    expect(container.textContent).not.toContain('permission_denied');
    expect(container.textContent).not.toContain('無法連線至雲端');
  });

  it('沒有選擇場次時顯示共用選場提示並禁止雲端診間操作',async()=>{
    await render([],null);
    expect(container.textContent).toContain('請先選擇場次。');
    expect(button('開始檢查').disabled).toBe(true);
    expect(button('暫時離開').disabled).toBe(true);
    expect(remote.roomExamination).not.toHaveBeenCalled();
  });

  it('已載入受檢者的歷年資料與選取項目保留，返回後從同一受檢者開始檢查',async()=>{
    await loadPerson();
    expect(button('開始檢查').disabled).toBe(false);
    await click(button('暫時離開'));
    expectPatientAndHistory();
    expect(button('開始檢查').disabled).toBe(true);
    expect(button('換下一位').disabled).toBe(true);
    await click(button('開始檢查'));await click(button('換下一位'));
    expect(remote.start).not.toHaveBeenCalled();expectPatientAndHistory();
    await click(button('返回診間'));
    expectPatientAndHistory();
    expect(button('開始檢查').disabled).toBe(false);
    await click(button('開始檢查'));
    expect(remote.start).toHaveBeenCalledWith('person-1','診間 1',['腹部超音波']);
    expect(container.querySelector('.room-patient-details')?.textContent).toContain('檢查中');
  });

  it.each(['工號','今日排程'])('既有%s選取受檢者流程仍可使用，離開與返回保留其歷年資料',async mode=>{
    await render();await click(button(mode));
    if(mode==='工號'){
      await input(queryInput(),'00125');await click(button('查詢'));
    }else{
      const selector=Array.from(container.querySelectorAll('select')).find(value=>Array.from(value.options).some(option=>option.value==='person-1'))!;
      await act(async()=>{selector.value='person-1';selector.dispatchEvent(new Event('change',{bubbles:true}));});
    }
    expect(remote.historyByEmployee).toHaveBeenCalledWith('00125');
    await click(button('腹部超音波'));expectPatientAndHistory();
    await click(button('暫時離開'));expectPatientAndHistory();
    await click(button('返回診間'));expectPatientAndHistory();
    expect(button('開始檢查').disabled).toBe(false);
  });

  it('只有歷年查詢結果而沒有今日受檢者時，離開與返回保留身分證及本機查詢結果',async()=>{
    await render([]);await input(queryInput(),'A123456789');
    expect(container.textContent).toContain('王小明（00125）今日排程查無此人。');
    const lookups=remote.historyById.mock.calls.length;
    await click(button('暫時離開'));
    expect(queryInput().value).toBe('A123456789');
    expect(container.textContent).toContain('王小明（00125）今日排程查無此人。');
    await click(button('查詢'));
    expect(remote.historyById).toHaveBeenCalledTimes(lookups);
    await click(button('返回診間'));
    expect(queryInput().value).toBe('A123456789');
    expect(container.textContent).toContain('王小明（00125）今日排程查無此人。');
  });

  it('重新掛載從雲端讀到 away 時直接顯示返回診間且禁止新受檢者查詢',async()=>{
    remote.rooms[0]=roomState('診間 1','away');
    await render();
    expect(button('返回診間').disabled).toBe(false);
    expect(button('開始檢查').disabled).toBe(true);
    expect(button('查詢').disabled).toBe(true);
    await act(async()=>{root.unmount();});root=createRoot(container);
    await render();
    expect(button('返回診間').disabled).toBe(false);
    expect(button('開始檢查').disabled).toBe(true);
    expect(remote.setAway).not.toHaveBeenCalled();
  });

  it('另一台裝置的即時離開與返回不清空已載入受檢者、歷年資料或選取項目',async()=>{
    await loadPerson();
    updateRoom('診間 1','away');await render();
    expect(button('開始檢查').disabled).toBe(true);expect(button('返回診間').disabled).toBe(false);expectPatientAndHistory();
    updateRoom('診間 1','idle');await render();
    expect(button('開始檢查').disabled).toBe(false);expect(button('暫時離開').disabled).toBe(false);expectPatientAndHistory();
    expect(remote.setAway).not.toHaveBeenCalled();
  });

  it('雲端狀態尚未確認或同步失敗時禁止開始，保留已載入資料直到恢復同步',async()=>{
    await loadPerson();
    remote.loading=true;await render();
    expect(button('開始檢查').disabled).toBe(true);expectPatientAndHistory();
    remote.loading=false;remote.error='診間狀態同步中斷';await render();
    expect(button('開始檢查').disabled).toBe(true);expectPatientAndHistory();
    remote.error='';await render();
    expect(button('開始檢查').disabled).toBe(false);expectPatientAndHistory();
  });

  it('離開請求處理中連點只送出一次，雲端失敗後保留原受檢者並可重試',async()=>{
    let rejectAway!:(error:Error)=>void;
    remote.setAway.mockImplementationOnce(()=>new Promise<StoredRoom>((_resolve,reject)=>{rejectAway=reject;}));
    await loadPerson();
    const away=button('暫時離開');
    await act(async()=>{away.click();away.click();});
    expect(remote.setAway).toHaveBeenCalledTimes(1);expectPatientAndHistory();
    await act(async()=>{rejectAway(new Error('雲端中斷'));});
    expectPatientAndHistory();expect(button('暫時離開').disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await click(button('暫時離開'));
    expect(remote.setAway).toHaveBeenCalledTimes(2);expect(button('返回診間').disabled).toBe(false);expectPatientAndHistory();
  });

  it('雲端離開成功但即時訂閱尚未回覆時，使用已保存的 away 回傳值禁用開始',async()=>{
    remote.setAway.mockResolvedValueOnce({...roomState('診間 1','away'),updatedAt:'2026-10-07T00:02:00Z'});
    await loadPerson();await click(button('暫時離開'));
    expect(remote.acceptRoom).toHaveBeenCalledWith(expect.objectContaining({roomId:'診間 1',status:'away'}));
    expect(button('返回診間').disabled).toBe(false);expect(button('開始檢查').disabled).toBe(true);expectPatientAndHistory();
  });

  it('今日排程新增其他人不清空目前受檢者與尚未開始的檢查項目',async()=>{
    await loadPerson();
    await render([participant(),participant({id:'person-2',name:'李小華',employeeNo:'00126'})]);
    expectPatientAndHistory();expect(button('開始檢查').disabled).toBe(false);
  });

  it('切換診間時各診間的 away 與受檢者畫面互相隔離，返回原診間恢復原畫面',async()=>{
    await loadPerson();await click(button('暫時離開'));
    await switchRoom('診間 2');
    expect(roomSelector().value).toBe('診間 2');
    expect(container.querySelector('.room-patient')).toBeNull();
    expect(button('暫時離開').disabled).toBe(false);expect(button('查詢').disabled).toBe(false);
    await switchRoom('診間 1');
    expect(roomSelector().value).toBe('診間 1');
    expect(button('返回診間').disabled).toBe(false);expect(button('開始檢查').disabled).toBe(true);expectPatientAndHistory();
    await click(button('返回診間'));
    expect(button('開始檢查').disabled).toBe(false);expectPatientAndHistory();
  });

  it.each(['resolve','reject'] as const)('切換診間後忽略舊診間檢查查詢的延遲 %s',async outcome=>{
    let resolveOld!:(value:Examination|null)=>void;let rejectOld!:(error:Error)=>void;
    remote.roomExamination.mockImplementationOnce(()=>new Promise<Examination|null>((resolve,reject)=>{resolveOld=resolve;rejectOld=reject;}));
    await render();await switchRoom('診間 2');
    await act(async()=>{if(outcome==='resolve')resolveOld(examination());else rejectOld(new Error('舊診間查詢失敗'));});
    expect(roomSelector().value).toBe('診間 2');expect(container.querySelector('.room-patient')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button('開始檢查').disabled).toBe(true);expect(button('暫時離開').disabled).toBe(false);
  });

  it('切換診間後忽略舊身分證歷年查詢的延遲回覆，避免選入其他診間受檢者',async()=>{
    let resolveOld!:(value:HistoricalRecord[])=>void;
    remote.historyById.mockImplementationOnce(()=>new Promise<HistoricalRecord[]>(resolve=>{resolveOld=resolve;}));
    await render();await input(queryInput(),'A123456789');await switchRoom('診間 2');
    await act(async()=>{resolveOld([history()]);});
    expect(roomSelector().value).toBe('診間 2');expect(container.querySelector('.room-patient')).toBeNull();
    expect(queryInput().value).toBe('');expect(remote.examination).not.toHaveBeenCalled();
  });

  it('身分證慢查詢尚未完成時改成未滿十碼，舊成功回覆不得載入已取消查詢的受檢者',async()=>{
    let resolveOld!:(value:HistoricalRecord[])=>void;
    remote.historyById.mockImplementationOnce(()=>new Promise<HistoricalRecord[]>(resolve=>{resolveOld=resolve;}));
    await render();await input(queryInput(),'A123456789');await input(queryInput(),'A123');
    expect(remote.historyById).toHaveBeenCalledTimes(1);
    await act(async()=>{resolveOld([history()]);});
    expect(queryInput().value).toBe('A123');expect(container.querySelector('.room-patient')).toBeNull();
    expect(container.textContent).not.toContain('王小明（00125）今日排程查無此人。');
    expect(remote.examination).not.toHaveBeenCalled();expect(button('開始檢查').disabled).toBe(true);
  });

  it('今日排程改選新受檢者後，舊歷年查詢的延遲失敗不得覆蓋成功選取的畫面或顯示錯誤',async()=>{
    let rejectOld!:(error:Error)=>void;
    remote.historyByEmployee.mockImplementation((employeeNo:string)=>employeeNo==='00125'?new Promise<HistoricalRecord[]>((_resolve,reject)=>{rejectOld=reject;}):Promise.resolve([history({fingerprint:'history-2',employeeNo:'00126',name:'李小華',values:{整體結果:'李小華歷年結果'}})]));
    await render([participant(),participant({id:'person-2',employeeNo:'00126',name:'李小華'})]);await click(button('今日排程'));
    const selector=container.querySelector<HTMLSelectElement>('[aria-label="今日受檢者"]')!;
    await act(async()=>{selector.value='person-1';selector.dispatchEvent(new Event('change',{bubbles:true}));});
    await act(async()=>{selector.value='person-2';selector.dispatchEvent(new Event('change',{bubbles:true}));});
    expect(container.querySelector('.room-patient-name')?.textContent).toBe('李小華');await click(button('腹部超音波'));
    await act(async()=>{rejectOld(new Error('舊受檢者歷年查詢失敗'));});
    expect(container.querySelector('.room-patient-name')?.textContent).toBe('李小華');
    expect(container.querySelector('.room-history')?.textContent).toContain('李小華歷年結果');
    expect(container.querySelector('[role="alert"]')).toBeNull();expect(container.textContent).not.toContain('本機查詢失敗');
    expect(remote.examination.mock.calls).toEqual([['person-2']]);expect(button('開始檢查').disabled).toBe(false);
  });

  it('檢查中遇到即時 away 保留確認視窗及實際項目選擇，返回後仍可完成並回傳時間',async()=>{
    remote.examination.mockResolvedValue(examination());
    await render();await input(queryInput(),'A123456789');
    expect(button('完成檢查').disabled).toBe(false);await click(button('完成檢查'));
    const checkboxes=dialog()!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);await click(checkboxes[1]);
    expect(checkboxes[0].checked).toBe(true);expect(checkboxes[1].checked).toBe(false);
    updateRoom('診間 1','away');await render();
    expect(dialog()).not.toBeNull();expect(button('完成檢查').disabled).toBe(true);expect(button('確認完成並同步雲端').disabled).toBe(true);
    await click(button('確認完成並同步雲端'));expect(remote.complete).not.toHaveBeenCalled();
    updateRoom('診間 1','in_progress');await render();
    expect(dialog()!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].checked).toBe(false);
    expect(button('確認完成並同步雲端').disabled).toBe(false);
    await click(button('確認完成並同步雲端'));
    expect(remote.complete).toHaveBeenCalledWith('exam-1','person-1','診間 1',['腹部超音波']);
    expect(dialog()).toBeNull();expect(container.textContent).toContain('檢查已完成');expect(container.textContent).toContain('00:01:05');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('檢查中從本台離開與返回，恢復原輪次和醫師已選項目，沒有另開或完成檢查',async()=>{
    remote.examination.mockResolvedValue(examination());
    await render();await input(queryInput(),'A123456789');
    updateRoom('診間 1','in_progress');await render();
    await click(button('暫時離開'));
    expect(button('完成檢查').disabled).toBe(true);expect(button('開始檢查').disabled).toBe(true);
    expect(container.querySelector('.room-patient-name')?.textContent).toBe('王小明');
    expect(button('甲狀腺超音波').getAttribute('aria-pressed')).toBe('true');
    remote.setAway.mockImplementationOnce(async()=>{updateRoom('診間 1','in_progress');return remote.rooms[0];});
    await click(button('返回診間'));
    expect(button('完成檢查').disabled).toBe(false);expect(button('開始檢查').disabled).toBe(true);
    expect(container.querySelector('.room-patient-details')?.textContent).toContain('檢查中');
    expect(remote.start).not.toHaveBeenCalled();expect(remote.complete).not.toHaveBeenCalled();
  });

  it('重新載入已暫時離開且尚有進行中檢查的診間，恢復同一受檢者與檢查輪次',async()=>{
    remote.rooms[0]=roomState('診間 1','away');remote.roomExamination.mockResolvedValue(examination());
    await render([participant({status:'檢查中'})]);
    expect(button('返回診間').disabled).toBe(false);expect(button('開始檢查').disabled).toBe(true);expect(button('完成檢查').disabled).toBe(true);
    expect(container.querySelector('.room-patient-name')?.textContent).toBe('王小明');
    expect(button('腹部超音波').getAttribute('aria-pressed')).toBe('true');expect(button('甲狀腺超音波').getAttribute('aria-pressed')).toBe('true');
    await click(button('腹部超音波｜最近三次'));
    expect(container.querySelector('.room-history')?.textContent).toContain('既往腹部結果');
    remote.setAway.mockImplementationOnce(async()=>{updateRoom('診間 1','in_progress');return remote.rooms[0];});
    await click(button('返回診間'));
    expect(button('完成檢查').disabled).toBe(false);expect(button('開始檢查').disabled).toBe(true);
    expect(remote.start).not.toHaveBeenCalled();expect(remote.complete).not.toHaveBeenCalled();
  });

  it('其他平板開始與完成同一受檢者時更新本輪狀態，保留歷年資料並顯示雲端完成時間',async()=>{
    await loadPerson();
    const running=examination({selectedItems:['腹部超音波']});
    remote.roomExamination.mockResolvedValue(running);remote.examinations.mockResolvedValue([running]);
    updateRoom('診間 1','in_progress');await render([participant({status:'檢查中',updatedAt:'2026-10-07T00:02:00Z'})]);
    expect(button('開始檢查').disabled).toBe(true);expect(button('完成檢查').disabled).toBe(false);expectPatientAndHistory();
    const completed=examination({selectedItems:['腹部超音波'],status:'completed',completedAt:'2026-10-07T00:03:05Z',durationSeconds:65,actualItems:['腹部超音波'],itemCount:1});
    remote.roomExamination.mockResolvedValue(null);remote.examinations.mockResolvedValue([completed]);
    updateRoom('診間 1','idle');await render([participant({status:'已完成',updatedAt:'2026-10-07T00:03:05Z'})]);
    expect(container.textContent).toContain('檢查已完成');expect(container.textContent).toContain('00:01:05');expectPatientAndHistory();
    expect(remote.start).not.toHaveBeenCalled();expect(remote.complete).not.toHaveBeenCalled();expect(changed).not.toHaveBeenCalled();
  });

  it('選到在其他診間檢查中的受檢者時禁止本診間操作，仍可切換至正確診間',async()=>{
    const running=examination({roomId:'診間 3'});remote.examination.mockResolvedValue(running);
    remote.roomExamination.mockImplementation(async(_sessionId:string,roomId:string)=>roomId==='診間 3'?running:null);
    updateRoom('診間 3','in_progress');
    await render();await input(queryInput(),'A123456789');
    expect(roomSelector().value).toBe('診間 1');expect(roomSelector().disabled).toBe(false);
    expect(button('開始檢查').disabled).toBe(true);expect(button('完成檢查').disabled).toBe(true);
    expect(container.textContent).toContain('此受檢者正在診間 3檢查中。');
    await switchRoom('診間 3');
    expect(container.querySelector('.room-patient-name')?.textContent).toBe('王小明');
    expect(button('完成檢查').disabled).toBe(false);expect(roomSelector().value).toBe('診間 3');
    expect(remote.start).not.toHaveBeenCalled();expect(remote.complete).not.toHaveBeenCalled();
  });

  it('切換場次時重設診間畫面，不能沿用上一場次的暫時離開覆蓋',async()=>{
    await loadPerson();await click(button('暫時離開'));
    const next:Session={...session,id:'next-session'};
    remote.rooms=[1,2,3,4].map(value=>({...roomState(`診間 ${value}`),sessionId:next.id}));
    await render([participant({id:'next-person',sessionId:next.id,name:'新場次人員'})],next);
    expect(container.querySelector('.room-patient')).toBeNull();expect(button('暫時離開').disabled).toBe(false);
    expect(button('查詢').disabled).toBe(false);expect(queryInput().value).toBe('');
  });
});
