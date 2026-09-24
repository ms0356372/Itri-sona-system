import {describe,expect,it,vi} from 'vitest';
import {findScheduledEmployee,isCompleteNationalId,matchCloudParticipant} from '../features/checkin/lookup';
import type {PreparedPerson} from '../features/roster/types';
import type {Participant} from '../types';

const prepared=(changes:Partial<PreparedPerson>={}):PreparedPerson=>({localId:'local-1',sequence:1,employeeNo:'00125',name:'虛構王小明',gender:'男',scheduleDate:'2026-09-24',slot:'07:30~08:00',item:'一般',extension:'',nationalId:'A123456789',originalActivity:'一般',dailyActivity:'一般',issues:[],confirmed:true,...changes});
const participant=(changes:Partial<Participant>={}):Participant=>({id:'cloud-1',sessionId:'session-1',sequence:1,employeeNo:'00125',name:'虛構王小明',gender:'男',slot:'07:30~08:00',groupCode:'A',plannedItems:['一般'],checkinNo:null,status:'未報到',checkedInAt:null,calledAt:null,note:'',updatedAt:'2026-09-24T00:00:00Z',...changes});

describe('身分證手動報到查詢',()=>{
  it('只有完整支援格式才會啟動自動查詢',()=>{expect(isCompleteNationalId('A123')).toBe(false);expect(isCompleteNationalId('a123456789')).toBe(true);expect(isCompleteNationalId('AB12345678')).toBe(true);});
  it('先從本機今日排程取得保留前導 0 的工號',()=>expect(findScheduledEmployee([prepared()],'a123456789')).toEqual({kind:'found',employeeNo:'00125'}));
  it('查無本機今日排程時禁止進入雲端配對',()=>expect(findScheduledEmployee([],'A123456789')).toEqual({kind:'not_scheduled'}));
  it('同一身分證多筆今日資料回報異常而不自行選擇',()=>expect(findScheduledEmployee([prepared(),prepared({localId:'local-2',employeeNo:'00999'})],'A123456789')).toEqual({kind:'duplicate'}));
  it('只以完整工號配對雲端資料，前導 0 不會遺失',()=>{const cloud=[participant(),participant({id:'cloud-2',employeeNo:'125'})];expect(matchCloudParticipant(cloud,'00125')?.id).toBe('cloud-1');});
  it('查詢介面不需要把身分證交給雲端配對函式',()=>{const spy=vi.fn(matchCloudParticipant);spy([participant()],'00125');expect(spy).toHaveBeenCalledWith(expect.any(Array),'00125');expect(spy).not.toHaveBeenCalledWith(expect.any(Array),'A123456789');});
  it('已報到者保留資料庫既有編號',()=>expect(matchCloudParticipant([participant({status:'等候中',checkinNo:'A7'})],'00125')).toMatchObject({status:'等候中',checkinNo:'A7'}));
});
