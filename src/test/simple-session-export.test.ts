import {describe,expect,it} from 'vitest';
import * as XLSX from 'xlsx';
import type {Examination,Participant,Session} from '../types';
import {buildCheckinWorkbook,buildUltrasoundWorkbook} from '../features/export/sessionExport';
import {buildCheckinReport,buildSimpleCheckinReport,buildUltrasoundSummary} from '../features/export/statistics';

const session=(workflowMode:Session['workflowMode']='simple'):Session=>({id:'simple-session',companyName:'ITRI',sessionDate:'2026-10-07',status:'active',workflowMode});
const person=(queue:number,patch:Partial<Participant>={}):Participant=>({
  id:`person-${queue}`,sessionId:'simple-session',sequence:queue,employeeNo:String(queue).padStart(5,'0'),name:`受檢者 ${queue}`,gender:'男',
  slot:null,groupCode:null,queueNumber:queue,plannedItems:['一般'],checkinNo:String(queue),status:'等候中',
  checkedInAt:'2026-10-07T00:30:00Z',calledAt:null,note:'',updatedAt:'2026-10-07T00:30:00Z',...patch,
});
const examination=(patch:Partial<Examination>={}):Examination=>({
  id:'exam-1',participantId:'person-1',roundNo:1,roomId:'診間 1',startedAt:'2026-10-07T00:30:00Z',completedAt:'2026-10-07T00:40:00Z',
  durationSeconds:600,selectedItems:['腹部超音波','甲狀腺超音波'],actualItems:['腹部超音波','甲狀腺超音波'],itemCount:2,status:'completed',...patch,
});
const rows=(sheet:XLSX.WorkSheet)=>XLSX.utils.sheet_to_json<(string|number)[]>(sheet,{header:1,defval:''});

describe('簡易模式報到 Excel',()=>{
  it('只輸出今日已報到、數值號碼順序與七欄，不建立排程或未報到資料',()=>{
    const people=[person(10,{status:'已完成'}),person(2),person(1,{status:'已叫號'}),person(99,{checkedInAt:null,checkinNo:null,queueNumber:null,status:'未報到'})];
    const original=[...people];const workbook=buildCheckinWorkbook(people,session());
    expect(workbook.SheetNames).toEqual(['今日已報到']);
    const sheet=workbook.Sheets['今日已報到'];const data=rows(sheet);
    expect(data[0]).toEqual(['號碼','工號','姓名','性別','健檢項目','報到時間','目前狀態']);
    expect(data.slice(1).map(row=>row[0])).toEqual([1,2,10]);
    expect(data.slice(1).map(row=>row[4])).toEqual(['一般','一般','一般']);
    expect(data[1][5]).toBe('08:30:00');expect(data[3][6]).toBe('已完成');
    expect(sheet.A2).toMatchObject({t:'n',v:1});expect(sheet.B2).toMatchObject({t:'s',v:'00001'});
    expect(sheet['!autofilter']).toEqual({ref:'A1:G4'});
    expect(data.flat()).not.toContain('組別');expect(data.flat()).not.toContain('排程時段');
    expect(data.flat()).not.toContain('受檢者 99');expect(people).toEqual(original);
  });

  it('尚無人到場時只有已報到空表頭，不假造應報到或未報到名單',()=>{
    const workbook=buildCheckinWorkbook([],session());
    expect(workbook.SheetNames).toEqual(['今日已報到']);expect(rows(workbook.Sheets['今日已報到'])).toHaveLength(1);
  });

  it('沿用共用取號 helper 支援 queueNumber 及純數字 checkinNo，簡易報表不產生 notCheckedIn 清單',()=>{
    const people=[person(10,{queueNumber:undefined}),person(2,{queueNumber:undefined}),person(1,{queueNumber:undefined})];
    const report=buildSimpleCheckinReport(people);
    expect(report.checkedIn.map(item=>item.checkinNo)).toEqual(['1','2','10']);expect(report).not.toHaveProperty('notCheckedIn');
    expect(rows(buildCheckinWorkbook(people,session()).Sheets['今日已報到']).slice(1).map(row=>row[0])).toEqual([1,2,10]);
  });
});

describe('簡易模式超音波 Excel 與標準模式相容',()=>{
  it('共用 examination 統計、保留多輪與各診間，號碼維持數值且不顯示虛構排程',()=>{
    const people=[person(1,{status:'已完成'}),person(2,{status:'已完成'}),person(3,{status:'檢查中'})];
    const exams=[
      examination(),
      examination({id:'round-2',roundNo:2,roomId:'診間 2',startedAt:'2026-10-07T00:41:00Z',completedAt:'2026-10-07T00:46:00Z',durationSeconds:300,selectedItems:['乳房超音波'],actualItems:['乳房超音波'],itemCount:1}),
      examination({id:'person-2-round-1',participantId:'person-2',startedAt:'2026-10-07T00:47:00Z',completedAt:'2026-10-07T00:51:00Z',durationSeconds:240,selectedItems:['甲狀腺超音波'],actualItems:['甲狀腺超音波'],itemCount:1}),
      examination({id:'in-progress',participantId:'person-3',roomId:'診間 2',startedAt:'2026-10-07T00:52:00Z',completedAt:null,durationSeconds:null,status:'in_progress',actualItems:[],itemCount:0}),
    ];
    const summary=buildUltrasoundSummary(people,exams);
    expect(summary.overall).toMatchObject({completedPeople:2,completedItems:4,totalSeconds:1140,inProgressPeople:1});
    expect(summary.overall.items['甲狀腺超音波']).toMatchObject({count:2,estimatedSeconds:540});
    const workbook=buildUltrasoundWorkbook(session(),people,exams);
    expect(workbook.SheetNames).toEqual(['總覽','診間統計','檢查者明細','診間1明細','診間2明細']);
    const overview=rows(workbook.Sheets['總覽']);
    expect(overview).toContainEqual(['今日已報到人數',3,'','']);
    expect(overview).toContainEqual(['超音波已完成人數',2,'','']);
    expect(overview).toContainEqual(['超音波完成總件數',4,'','']);
    expect(overview.some(row=>row[0]==='今日排程人數'||row[0]==='今日未報到人數')).toBe(false);
    const detail=XLSX.utils.sheet_to_json<Record<string,string|number>>(workbook.Sheets['檢查者明細']);
    expect(detail.map(row=>row['號碼'])).toEqual([1,1,2,3]);
    expect(detail.map(row=>row['檢查輪次'])).toEqual(['第1輪','第2輪','第1輪','第1輪']);
    expect(detail.map(row=>row['總檢查秒數'])).toEqual([600,300,240,'']);
    expect(detail.every(row=>!('組別' in row)&&!('排程時段' in row)&&!('報到編號' in row))).toBe(true);
    expect(workbook.Sheets['檢查者明細'].B2).toMatchObject({t:'n',v:1});
    expect(workbook.Sheets['檢查者明細'].C2).toMatchObject({t:'s',v:'00001'});
    expect(XLSX.utils.sheet_to_json(workbook.Sheets['診間1明細'])).toHaveLength(2);
    expect(XLSX.utils.sheet_to_json(workbook.Sheets['診間2明細'])).toHaveLength(2);
    const standardPeople=people.map(item=>({...item,slot:'08:00',groupCode:'A' as const,queueNumber:null,checkinNo:`A${item.queueNumber}`}));
    const standard=buildUltrasoundWorkbook(session('standard'),standardPeople,exams);
    expect(workbook.Sheets['診間統計']).toEqual(standard.Sheets['診間統計']);
    expect(buildUltrasoundSummary(standardPeople,exams).overall).toEqual(summary.overall);
  });

  it.each([undefined,null,'standard'] as const)('workflowMode=%s 仍完整輸出標準 A～G、時段與未報到資料',workflowMode=>{
    const people=[
      person(1,{slot:'08:30',groupCode:'B',queueNumber:null,checkinNo:'B1'}),
      person(2,{slot:'08:00',groupCode:'A',queueNumber:null,checkinNo:'A2'}),
      person(3,{slot:'08:00',groupCode:'A',queueNumber:null,checkinNo:'A1'}),
      person(4,{slot:'09:00',groupCode:'C',queueNumber:null,checkinNo:null,checkedInAt:null,status:'未報到'}),
    ];
    const context=session(workflowMode);if(workflowMode===undefined)delete context.workflowMode;
    const workbook=buildCheckinWorkbook(people,context);
    expect(workbook).toEqual(buildCheckinWorkbook(people));
    expect(workbook.SheetNames).toEqual(['今日已報到','今日應報到未報到']);
    const checked=rows(workbook.Sheets['今日已報到']);
    expect(checked[0]).toEqual(['序號','報到編號','工號','姓名','性別','排程時段','健檢項目','報到時間','目前狀態']);
    expect(checked.slice(1).map(row=>row[1])).toEqual(['A1','A2','B1']);
    expect(checked.slice(1).map(row=>row[5])).toEqual(['08:00','08:00','08:30']);
    expect(workbook.Sheets['今日已報到'].B2).toMatchObject({t:'s',v:'A1'});
    expect(rows(workbook.Sheets['今日應報到未報到'])).toHaveLength(2);
    expect(buildCheckinReport(people).notCheckedIn).toHaveLength(1);
    const ultrasound=buildUltrasoundWorkbook(context,people,[examination()]);
    expect(rows(ultrasound.Sheets['總覽']).some(row=>row[0]==='今日排程人數'&&row[1]===4)).toBe(true);
    expect(rows(ultrasound.Sheets['總覽']).some(row=>row[0]==='今日未報到人數'&&row[1]===1)).toBe(true);
    expect(rows(ultrasound.Sheets['檢查者明細'])[0]).toContain('排程時段');
  });
});
