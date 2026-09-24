import {beforeEach,describe,expect,it} from 'vitest';
import {clearPreparedSchedule,getCompanyMaster,getPreparedSchedule,replaceCompanyMaster,replacePreparedSchedule,rosterDb} from '../features/roster/db';
import type {PreparedPerson} from '../features/roster/types';

const prepared=(localId:string,employeeNo:string):PreparedPerson=>({localId,sequence:1,employeeNo,name:'測試人員',gender:'女',scheduleDate:'2026-09-24',slot:'07:30~08:00',item:'一般',extension:'',nationalId:'A123456789',originalActivity:'一般',dailyActivity:'一般',issues:[],confirmed:true});

describe('IndexedDB daily schedule lifecycle',()=>{
  beforeEach(async()=>{await rosterDb.preparedPeople.clear();await rosterDb.masterPeople.clear();await rosterDb.companySettings.clear();});
  it('restores a fully written schedule after state is discarded',async()=>{await replacePreparedSchedule('session-a',[prepared('a','00125')]);expect(await getPreparedSchedule('session-a')).toEqual([prepared('a','00125')]);});
  it('clears only the selected session and preserves company master data',async()=>{await replaceCompanyMaster('測試公司',[{companyName:'測試公司',employeeNo:'00125',name:'測試人員',nationalId:'A123456789',gender:'女',originalActivity:'一般',item:'一般',extension:'',updatedAt:'2026-09-24T00:00:00Z'}]);await replacePreparedSchedule('session-a',[prepared('a','00125')]);await replacePreparedSchedule('session-b',[prepared('b','00126')]);await clearPreparedSchedule('session-a');expect(await getPreparedSchedule('session-a')).toEqual([]);expect(await getPreparedSchedule('session-b')).toHaveLength(1);expect(await getCompanyMaster('測試公司')).toHaveLength(1);});
});
