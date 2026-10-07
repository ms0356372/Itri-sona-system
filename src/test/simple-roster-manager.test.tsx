import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Session} from '../types';
import {RosterManager} from '../features/roster/RosterManager';
import * as roster from '../features/roster/db';
import type {MasterPerson} from '../features/roster/types';

(globalThis as Record<string,unknown>).IS_REACT_ACT_ENVIRONMENT=true;

const person:MasterPerson={companyName:'ITRI',companyKey:'ITRI',employeeNo:'00125',name:'王小明',nationalId:'A123456789',gender:'男',originalActivity:'一般健檢',item:'一般',extension:'1234',updatedAt:'2026-01-01T00:00:00Z'};
const base:Session={id:'roster-session',companyName:'ITRI',sessionDate:'2026-10-07',status:'active',roomCount:4};
let container:HTMLDivElement;let root:Root;
const loaded=async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});};
const render=async(current:Session)=>{await act(async()=>{root.render(<RosterManager current={current} participants={[]} onUploaded={async()=>{}} setNotice={()=>{}}/>);});await loaded();};

describe('簡易模式沿用 Company Master 管理',()=>{
  beforeEach(async()=>{
    await roster.rosterDb.open();await roster.rosterDb.masterPeople.clear();await roster.rosterDb.companySettings.clear();await roster.rosterDb.preparedPeople.clear();
    await roster.replaceCompanyMaster('ITRI',[person]);container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
  });
  afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.restoreAllMocks();});

  it('simple只顯示大名單管理，不載入或呈現每日/整理後/上傳/下載排程',async()=>{
    const prepared=vi.spyOn(roster,'getPreparedSchedule');await render({...base,workflowMode:'simple'});
    expect(container.textContent).toContain('公司大名單管理');expect(container.textContent).toContain('已匯入 1 筆');
    expect(container.querySelector('input[type=file]')).not.toBeNull();
    for(const label of ['每日排程','我們整理後的排程','確認並上傳今日排程','預覽完成，下載 Excel','新增全新人員'])expect(container.textContent).not.toContain(label);
    expect(prepared).not.toHaveBeenCalled();expect(await roster.isCompanyMasterLocked('ITRI')).toBe(true);
  });

  it('舊場次缺mode與明確standard的UI相同，完整標準步驟繼續存在',async()=>{
    const prepared=vi.spyOn(roster,'getPreparedSchedule');await render(base);
    for(const label of ['名單整理與上傳','廠商提供資料（每日排程）','我們整理後的排程','確認並上傳今日排程','預覽完成，下載 Excel'])expect(container.textContent).toContain(label);
    expect(prepared).toHaveBeenCalledWith(base.id);const original=container.innerHTML;
    await render({...base,workflowMode:'standard'});expect(container.innerHTML).toBe(original);
  });

  it('simple解鎖仍保留同一份名單，且解鎖說明不引導每日排程',async()=>{
    await render({...base,workflowMode:'simple'});
    const unlock=container.querySelector<HTMLButtonElement>('button[aria-label="解鎖公司大名單"]')!;
    await act(async()=>unlock.click());expect(container.textContent).not.toContain('每日排程');
    const confirm=Array.from(container.querySelectorAll('button')).filter(button=>button.textContent==='確認解鎖')[0];
    await act(async()=>confirm.click());await loaded();expect(await roster.isCompanyMasterLocked('itri')).toBe(false);
    expect(await roster.getCompanyMaster('ＩＴＲＩ')).toHaveLength(1);
    expect(container.querySelector<HTMLInputElement>('input[type=file]')?.disabled).toBe(false);
  });
});
