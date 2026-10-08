import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Session,StaffPermissions,WorkflowMode} from '../types';
import type {DailySchedulePerson,MasterPerson} from '../features/roster/types';

type PermissionChannel={listener:()=>void;status:(value:string)=>void};
const remote=vi.hoisted(()=>({
  channels:new Set<PermissionChannel>(),
  getSession:vi.fn(),onAuthStateChange:vi.fn(),getPermissions:vi.fn(),
  unsubscribeAuth:vi.fn(),removeChannel:vi.fn(),
  listSessions:vi.fn(),listParticipants:vi.fn(),
  subscribeSessions:vi.fn(),subscribeParticipants:vi.fn(),
  unsubscribeSessions:vi.fn(),unsubscribeParticipants:vi.fn(),
}));
vi.mock('../lib/supabase',()=>{
  const client={
    auth:{getSession:remote.getSession,onAuthStateChange:remote.onAuthStateChange},
    channel:()=>{
      const subscription:PermissionChannel={listener:()=>{},status:()=>{}};
      const channel={
        on:(_event:string,_filter:unknown,listener:()=>void)=>{subscription.listener=listener;return channel;},
        subscribe:(status:(value:string)=>void)=>{subscription.status=status;remote.channels.add(subscription);return subscription;},
      };
      return channel;
    },
    removeChannel:(channel:PermissionChannel)=>{remote.channels.delete(channel);remote.removeChannel(channel);return Promise.resolve();},
  };
  return{isSupabaseConfigured:true,supabase:client,requireSupabase:()=>client};
});
vi.mock('../features/auth/permissions',async importOriginal=>({
  ...await importOriginal<typeof import('../features/auth/permissions')>(),
  getStaffPermissions:remote.getPermissions,
}));
vi.mock('../features/auth/service',()=>({signIn:vi.fn(),signOut:vi.fn()}));
vi.mock('../features/sessions/service',()=>({listSessions:remote.listSessions,createSession:vi.fn(),updateSessionRoomCount:vi.fn()}));
vi.mock('../features/schedule/service',()=>({listParticipants:remote.listParticipants,uploadPreparedSchedule:vi.fn()}));
vi.mock('../features/sync/realtime',()=>({subscribeSessions:remote.subscribeSessions,subscribeParticipants:remote.subscribeParticipants}));
vi.mock('../features/workflow/WorkflowCheckin',()=>({WorkflowCheckin:()=> <div data-checkin-work>報到工作畫面</div>}));
vi.mock('../features/console/Console',()=>({UltrasoundConsole:()=>null}));
vi.mock('../features/room/UltrasoundRoom',()=>({UltrasoundRoom:()=>null}));
vi.mock('../features/room/RoomStatusOverview',()=>({RoomStatusOverview:()=>null}));
vi.mock('../features/room/useRoomClaims',()=>({useRoomClaims:()=>({release:async()=>true})}));
vi.mock('../features/sessions/management',()=>({clearSessionSchedule:vi.fn(),deleteSession:vi.fn()}));
vi.mock('../features/examination/service',()=>({listExaminations:vi.fn()}));
vi.mock('../features/export/sessionExport',()=>({downloadCheckinReport:vi.fn(),downloadUltrasoundReport:vi.fn()}));
vi.mock('../features/roster/excel',async importOriginal=>({
  ...await importOriginal<typeof import('../features/roster/excel')>(),
  readMasterFile:vi.fn(),readDailyFile:vi.fn(),
}));
vi.mock('../lib/time',async importOriginal=>({
  ...await importOriginal<typeof import('../lib/time')>(),taiwanToday:()=> '2026-10-07',
}));

import App from '../App';
import * as database from '../features/roster/db';
import {readDailyFile,readMasterFile} from '../features/roster/excel';

const actEnvironment=globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean};
const staff=(patch:Partial<StaffPermissions>={}):StaffPermissions=>({
  userId:'import-staff',loginEmail:'import@example.test',displayName:'',
  canRegistration:true,canConsole:false,canRoom:false,isActive:true,...patch,
});
const session=(mode:WorkflowMode):Session=>({
  id:'import-session',companyName:'ITRI',sessionDate:'2026-10-07',status:'active',roomCount:4,workflowMode:mode,
});
const person=(employeeNo:string,patch:Partial<MasterPerson>={}):MasterPerson=>({
  companyName:'ITRI',companyKey:'ITRI',employeeNo,name:`受檢者 ${employeeNo}`,nationalId:'A123456789',
  gender:'男',item:'一般',originalActivity:'一般健檢',extension:'1234',updatedAt:'2026-10-01T00:00:00Z',...patch,
});
const masterReader=vi.mocked(readMasterFile);
const dailyReader=vi.mocked(readDailyFile);
let root:Root;
let container:HTMLDivElement;

function deferred<T>(){
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(accept=>{resolve=accept;});
  return{promise,resolve};
}
async function until(condition:()=>boolean){
  for(let attempt=0;attempt<100;attempt++){
    if(condition())return;
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
  }
  throw new Error('畫面未在預期時間更新。');
}
function button(label:string){
  const element=Array.from(container.querySelectorAll('button')).find(candidate=>candidate.textContent===label);
  if(!element)throw new Error(`找不到按鈕：${label}`);
  return element;
}
async function click(label:string){await act(async()=>{button(label).click();});}
function files(){return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'));}
function expectSameRoster(input:HTMLInputElement){
  expect(input.isConnected).toBe(true);
  expect(files()).toContain(input);
  expect(container.querySelector('h2')?.textContent).toBe('名單管理');
  expect(container.querySelector('[data-checkin-work]')).toBeNull();
  expect(container.textContent).not.toContain('正在確認系統權限');
  expect(remote.unsubscribeSessions).not.toHaveBeenCalled();
  expect(remote.unsubscribeParticipants).not.toHaveBeenCalled();
}
async function mountRoster(mode:WorkflowMode){
  remote.listSessions.mockResolvedValue([session(mode)]);
  await act(async()=>{root.render(<App/>);});
  await until(()=>container.querySelector('[data-checkin-work]')!==null);
  await click('名單管理');
  await until(()=>files().length===(mode==='simple'?1:2));
  // Allow the real IndexedDB reads to finish before starting a file operation.
  await act(async()=>{await database.getCompanyMaster('ITRI');await database.getCompanyMasterLockState('ITRI');});
  await until(()=>files()[0].disabled===false);
  expect(remote.getPermissions).toHaveBeenCalledOnce();
}
async function selectFileAndRefresh(input:HTMLInputElement){
  const file=new File(['excel'],'roster.xlsx');
  Object.defineProperty(input,'files',{value:[file],configurable:true});
  await act(async()=>{
    input.dispatchEvent(new Event('change',{bubbles:true}));
    // Returning from a native file picker can emit this entire routine burst.
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
  });
  expectSameRoster(input);
  await until(()=>remote.getPermissions.mock.calls.length===2);
  expectSameRoster(input);
  expect(remote.getPermissions).toHaveBeenCalledTimes(2);
  expect(remote.listSessions).toHaveBeenCalledOnce();
  expect(remote.listParticipants).toHaveBeenCalledOnce();
  return file;
}

describe('App 權限背景確認不中斷真實名單匯入',()=>{
  beforeEach(async()=>{
    actEnvironment.IS_REACT_ACT_ENVIRONMENT=true;
    localStorage.clear();remote.channels.clear();
    for(const value of Object.values(remote))if(typeof value==='function'&&'mockReset' in value)value.mockReset();
    masterReader.mockReset();dailyReader.mockReset();
    vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
    remote.getSession.mockResolvedValue({data:{session:{user:{id:'import-staff',email:'import@example.test'}}}});
    remote.onAuthStateChange.mockReturnValue({data:{subscription:{unsubscribe:remote.unsubscribeAuth}}});
    remote.getPermissions.mockResolvedValue(staff());
    remote.listParticipants.mockResolvedValue([]);
    remote.subscribeSessions.mockReturnValue(remote.unsubscribeSessions);
    remote.subscribeParticipants.mockReturnValue(remote.unsubscribeParticipants);
    await database.rosterDb.open();
    await database.rosterDb.masterPeople.clear();
    await database.rosterDb.companySettings.clear();
    await database.rosterDb.preparedPeople.clear();
    container=document.createElement('div');document.body.append(container);root=createRoot(container);
  });
  afterEach(async()=>{
    await act(async()=>{root.unmount();});container.remove();localStorage.clear();
    vi.restoreAllMocks();actEnvironment.IS_REACT_ACT_ENVIRONMENT=false;
  });

  it.each(['standard','simple'] as const)('%s 選 Excel 後 focus/visible/online 查詢未完成仍保留同一名單畫面，首次匯入完成並鎖定',async mode=>{
    await mountRoster(mode);
    const input=files()[0];
    const permissionRead=deferred<StaffPermissions|null>();
    const fileRead=deferred<MasterPerson[]>();
    remote.getPermissions.mockReturnValueOnce(permissionRead.promise);
    masterReader.mockReturnValueOnce(fileRead.promise);
    const replace=vi.spyOn(database,'replaceCompanyMaster');
    const file=await selectFileAndRefresh(input);
    await until(()=>masterReader.mock.calls.length===1);
    expect(masterReader).toHaveBeenCalledWith(file,'ITRI');
    expect(input.disabled).toBe(true);
    await act(async()=>{fileRead.resolve([person('00125')]);});
    await until(()=>container.textContent?.includes('已匯入並鎖定保存在本機的大名單，共 1 筆。')??false);
    expectSameRoster(input);
    expect(replace).toHaveBeenCalledOnce();
    expect((await database.getCompanyMaster('ITRI')).map(row=>row.employeeNo)).toEqual(['00125']);
    expect(await database.isCompanyMasterLocked('ITRI')).toBe(true);
    expect(container.textContent).toContain('大名單已鎖定');
    await act(async()=>{permissionRead.resolve(staff());});
    expectSameRoster(input);
    expect(remote.getPermissions).toHaveBeenCalledTimes(2);
    expect(files()).toHaveLength(mode==='simple'?1:2);
  });

  it('已有大名單時背景 focus 不重置更新預覽，確認後執行真正增量更新並顯示結果',async()=>{
    await database.replaceCompanyMaster('ITRI',[person('00125')]);
    await database.setCompanyMasterLocked('ITRI',false);
    await mountRoster('simple');
    await until(()=>container.textContent?.includes('已匯入 1 筆')??false);
    const input=files()[0];
    const permissionRead=deferred<StaffPermissions|null>();
    const fileRead=deferred<MasterPerson[]>();
    remote.getPermissions.mockReturnValueOnce(permissionRead.promise);masterReader.mockReturnValueOnce(fileRead.promise);
    const merge=vi.spyOn(database,'mergeCompanyMaster');
    await selectFileAndRefresh(input);
    await until(()=>masterReader.mock.calls.length===1);
    await act(async()=>{fileRead.resolve([person('00125',{name:'更新姓名'}),person('00126',{nationalId:'B123456789'})]);});
    await until(()=>container.querySelector('[role="dialog"]')!==null);
    expectSameRoster(input);
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('如何更新公司大名單？');
    expect((await database.getCompanyMaster('ITRI')).map(row=>row.name)).toEqual(['受檢者 00125']);
    await click('確認增量更新');
    await until(()=>container.textContent?.includes('大名單增量更新完成：新增 1 人、更新 1 人，目前共 2 人。')??false);
    expectSameRoster(input);
    expect(merge).toHaveBeenCalledOnce();
    expect((await database.getCompanyMaster('ITRI')).map(row=>[row.employeeNo,row.name])).toEqual([['00125','更新姓名'],['00126','受檢者 00126']]);
    expect(await database.isCompanyMasterLocked('ITRI')).toBe(true);
    await act(async()=>{permissionRead.resolve(staff());});
    expectSameRoster(input);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('standard 每日排程選檔後 focus 不取消比對及本機排程保存',async()=>{
    await database.replaceCompanyMaster('ITRI',[person('00125')]);
    await database.setCompanyMasterLocked('ITRI',false);
    await mountRoster('standard');
    await until(()=>files()[1]?.disabled===false);
    const input=files()[1];
    const permissionRead=deferred<StaffPermissions|null>();
    const fileRead=deferred<DailySchedulePerson[]>();
    remote.getPermissions.mockReturnValueOnce(permissionRead.promise);dailyReader.mockReturnValueOnce(fileRead.promise);
    const replace=vi.spyOn(database,'replacePreparedSchedule');
    const file=await selectFileAndRefresh(input);
    await until(()=>dailyReader.mock.calls.length===1);
    expect(dailyReader).toHaveBeenCalledWith(file);
    await act(async()=>{fileRead.resolve([{sourceRow:2,employeeNo:'00125',name:'受檢者 00125',scheduleDate:'2026-10-07',slot:'08:00',activity:'一般健檢',extension:''}]);});
    await until(()=>container.textContent?.includes('每日排程已整理並保存在本機：可用 1 筆，待確認 0 筆。')??false);
    expectSameRoster(input);
    expect(replace).toHaveBeenCalledOnce();
    expect(await database.getPreparedSchedule('import-session')).toMatchObject([{employeeNo:'00125',name:'受檢者 00125',slot:'08:00',item:'一般',issues:[]}]);
    expect(button('預覽完成，下載 Excel').disabled).toBe(false);
    await act(async()=>{permissionRead.resolve(staff());});
    expectSameRoster(input);
  });

  it('focus 背景 DB 確認撤銷唯一 registration 權限後立即卸載名單畫面與工作訂閱',async()=>{
    await mountRoster('standard');
    const input=files()[0];
    const permissionRead=deferred<StaffPermissions|null>();remote.getPermissions.mockReturnValueOnce(permissionRead.promise);
    await act(async()=>{window.dispatchEvent(new Event('focus'));});
    expectSameRoster(input);
    await until(()=>remote.getPermissions.mock.calls.length===2);
    expectSameRoster(input);
    await act(async()=>{permissionRead.resolve(staff({canRegistration:false}));});
    expect(input.isConnected).toBe(false);
    expect(files()).toEqual([]);
    expect(container.textContent).toContain('此帳號目前沒有可使用的工作頁面');
    expect(container.querySelector('nav[aria-label="工作站導覽"]')).toBeNull();
    expect(remote.unsubscribeSessions).toHaveBeenCalledOnce();
    expect(remote.unsubscribeParticipants).toHaveBeenCalledOnce();
  });
});
