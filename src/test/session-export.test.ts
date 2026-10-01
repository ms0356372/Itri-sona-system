import {describe,expect,it} from 'vitest';
import * as XLSX from 'xlsx';
import type {Examination,Participant} from '../types';
import {buildCheckinWorkbook,buildUltrasoundWorkbook} from '../features/export/sessionExport';
import {buildCheckinReport,buildUltrasoundSummary,calculateEstimatedItemDurations,formatDuration,groupExaminationsByRoom} from '../features/export/statistics';

const participant=(index:number,overrides:Partial<Participant>={}):Participant=>({id:`p${index}`,sessionId:'s1',sequence:index,employeeNo:String(index).padStart(5,'0'),name:`受檢者${index}`,gender:'男',slot:'08:00',groupCode:'A',plannedItems:['腹部超音波'],checkinNo:null,status:'未報到',checkedInAt:null,calledAt:null,note:'',updatedAt:'2026-09-29T00:00:00Z',...overrides});
const examination=(overrides:Partial<Examination>={}):Examination=>({id:'e1',participantId:'p1',roundNo:1,roomId:'診間 1',startedAt:'2026-09-29T00:00:00Z',completedAt:'2026-09-29T00:10:00Z',durationSeconds:600,selectedItems:['腹部超音波'],actualItems:['腹部超音波'],itemCount:1,status:'completed',...overrides});

describe('場次報到匯出',()=>{
  it('將十人排程正確分成七人已報到與三人未報到',()=>{const people=Array.from({length:10},(_,i)=>participant(i+1,i<7?{checkedInAt:'2026-09-29T00:00:00Z',checkinNo:`A${i+1}`} : {}));const report=buildCheckinReport(people);expect(report.checkedIn).toHaveLength(7);expect(report.notCheckedIn).toHaveLength(3);});
  it('已完成者仍是已報到，有報到號也不列入未報到',()=>{const completed=participant(1,{status:'已完成',checkedInAt:'2026-09-29T00:00:00Z'});const numbered=participant(2,{checkinNo:'A2'});const report=buildCheckinReport([completed,numbered]);expect(report.checkedIn).toHaveLength(2);expect(report.checkedIn).toEqual(expect.arrayContaining([completed,numbered]));expect(report.notCheckedIn).toHaveLength(0);});
  it('Excel 將報到號碼與工號儲存為文字',()=>{const workbook=buildCheckinWorkbook([participant(1,{employeeNo:'00001',checkinNo:'A1',checkedInAt:'2026-09-29T00:00:00Z'})]);const sheet=workbook.Sheets['今日已報到'];expect(sheet.B2.t).toBe('s');expect(sheet.C2.t).toBe('s');expect(sheet.C2.v).toBe('00001');});
});

describe('場次超音波匯出',()=>{
  it.each([[600,['腹部超音波'],600],[600,['腹部超音波','甲狀腺超音波'],300],[900,['腹部超音波','甲狀腺超音波','乳房超音波'],300]] as const)('%i 秒會依實際完成項目平均分攤', (seconds,items,expected)=>{const estimates=calculateEstimatedItemDurations(examination({durationSeconds:seconds,actualItems:[...items]}));for(const item of items)expect(estimates[item]).toBe(expected);});
  it('601 秒除以二保留小數精度且加總仍是 601',()=>{const values=Object.values(calculateEstimatedItemDurations(examination({durationSeconds:601,actualItems:['腹部超音波','甲狀腺超音波']})));expect(values).toEqual([300.5,300.5]);expect(values.reduce((sum,value)=>sum+(value??0),0)).toBe(601);});
  it('區分完成人數與完成件數，並排除非正式項目',()=>{const invalid=examination({actualItems:['腹部超音波','甲狀腺超音波','B、C 肝' as never],itemCount:3});const result=buildUltrasoundSummary([participant(1)], [invalid]).overall;expect(result.completedPeople).toBe(1);expect(result.completedItems).toBe(2);});
  it('不同診間及全場加總正確，進行中不加入正式統計',()=>{const exams=[examination(),examination({id:'e2',participantId:'p2',roomId:'診間 2',durationSeconds:300,actualItems:['甲狀腺超音波']}),examination({id:'e3',participantId:'p3',roomId:'診間 2',status:'in_progress',completedAt:null,durationSeconds:null,actualItems:[]})];const summary=buildUltrasoundSummary([participant(1),participant(2),participant(3)],exams);expect(summary.rooms.map(room=>room.statistics.completedPeople)).toEqual([1,1]);expect(summary.overall.totalSeconds).toBe(900);expect(summary.rooms.reduce((sum,room)=>sum+room.statistics.totalSeconds,0)).toBe(900);expect(summary.overall.inProgressPeople).toBe(1);expect(summary.overall.completedPeople).toBe(2);});
  it('各診間分組只包含自己資料且動態建立診間 5 Sheet',()=>{const exams=[examination(),examination({id:'e5',participantId:'p2',roomId:'診間 5'})];expect(groupExaminationsByRoom(exams).get('診間 5')).toEqual([exams[1]]);const workbook=buildUltrasoundWorkbook({id:'s1',companyName:'ITRI',sessionDate:'2026-09-29',status:'active'},[participant(1),participant(2)],exams);expect(workbook.SheetNames).toContain('診間5明細');expect(XLSX.utils.sheet_to_json(workbook.Sheets['診間5明細'])).toHaveLength(1);});
  it('超過 24 小時不回捲',()=>expect(formatDuration(90000)).toBe('25:00:00'));
});

it('多輪依受檢者去重、件數與時間累加，並保留每輪與診間',()=>{
  const rounds=[examination({id:'r1',roundNo:1,durationSeconds:360}),examination({id:'r2',roundNo:2,roomId:'診間 3',durationSeconds:240,actualItems:['甲狀腺超音波'],selectedItems:['甲狀腺超音波']})];
  const summary=buildUltrasoundSummary([participant(1)],rounds);
  expect(summary.overall).toMatchObject({completedPeople:1,completedItems:2,totalSeconds:600});
  expect(summary.overall.items['腹部超音波'].estimatedSeconds).toBe(360);
  expect(summary.overall.items['甲狀腺超音波'].estimatedSeconds).toBe(240);
  expect(summary.rooms.map(room=>[room.roomId,room.statistics.completedPeople])).toEqual([['診間 1',1],['診間 3',1]]);
  const rows=XLSX.utils.sheet_to_json<Record<string,string>>(buildUltrasoundWorkbook({id:'s',companyName:'ITRI',sessionDate:'2026-10-01',status:'active'},[participant(1)],rounds).Sheets['檢查者明細']);
  expect(rows.map(row=>row['檢查輪次'])).toEqual(['第1輪','第2輪']);
});
