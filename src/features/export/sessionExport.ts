import * as XLSX from 'xlsx';
import type {Examination,Participant,Session} from '../../types';
import {ultrasoundItemNames} from '../../types';
import {buildCheckinReport,buildUltrasoundSummary,calculateEstimatedItemDurations,formatDuration,validActualItems} from './statistics';

const formatTaiwanTime=(iso:string|null)=>iso?new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(iso)):'';
const safeFilePart=(value:string)=>value.replace(/[\\/:*?"<>|]/g,'_');
const text=(value:string|null|undefined)=>value??'';

function sheetFromRows(rows:(string|number)[][],widths:number[],filter=true){
  const sheet=XLSX.utils.aoa_to_sheet(rows);sheet['!cols']=widths.map(wch=>({wch}));
  if(filter&&rows.length&&rows[0].length)sheet['!autofilter']={ref:XLSX.utils.encode_range({s:{r:0,c:0},e:{r:Math.max(0,rows.length-1),c:rows[0].length-1}})};
  return sheet;
}

function forceTextColumns(sheet:XLSX.WorkSheet,columns:number[]){
  const range=sheet['!ref']?XLSX.utils.decode_range(sheet['!ref']):null;if(!range)return;
  for(let row=1;row<=range.e.r;row++)for(const column of columns){const cell=sheet[XLSX.utils.encode_cell({r:row,c:column})];if(cell){cell.t='s';cell.v=String(cell.v??'');}}
}

export function buildCheckinWorkbook(participants:Participant[]){
  const report=buildCheckinReport(participants);const workbook=XLSX.utils.book_new();
  const checkedRows=[['序號','報到編號','工號','姓名','性別','排程時段','健檢項目','報到時間','目前狀態'],...report.checkedIn.map(person=>[person.sequence,text(person.checkinNo),text(person.employeeNo),person.name,person.gender,person.slot,person.plannedItems.join('、'),formatTaiwanTime(person.checkedInAt),person.status])];
  const missingRows=[['序號','工號','姓名','性別','排程時段','健檢項目','目前狀態'],...report.notCheckedIn.map(person=>[person.sequence,text(person.employeeNo),person.name,person.gender,person.slot,person.plannedItems.join('、'),person.status])];
  const checkedSheet=sheetFromRows(checkedRows,[8,12,16,14,8,14,30,12,12]);const missingSheet=sheetFromRows(missingRows,[8,16,14,8,14,30,12]);forceTextColumns(checkedSheet,[1,2]);forceTextColumns(missingSheet,[1]);
  XLSX.utils.book_append_sheet(workbook,checkedSheet,'今日已報到');XLSX.utils.book_append_sheet(workbook,missingSheet,'今日應報到未報到');return workbook;
}

const detailHeaders=['序號','報到編號','工號','姓名','性別','排程時段','診間','檢查狀態','開始時間','完成時間','總檢查時間','總檢查秒數','實際完成項目','完成件數',...ultrasoundItemNames.map(item=>`${item}估算時間`)];
function detailRow(examination:Examination,participant:Participant|undefined):(string|number)[]{
  const completed=examination.status==='completed'&&examination.completedAt!==null&&examination.durationSeconds!==null;const estimates=completed?calculateEstimatedItemDurations(examination):{};const items=completed?validActualItems(examination):[];
  return[participant?.sequence??'',text(participant?.checkinNo),text(participant?.employeeNo),participant?.name??'',participant?.gender??'',participant?.slot??'',examination.roomId,examination.status,formatTaiwanTime(examination.startedAt),completed?formatTaiwanTime(examination.completedAt):'',completed?formatDuration(examination.durationSeconds):'',completed?examination.durationSeconds!:'',items.join('、'),items.length,...ultrasoundItemNames.map(item=>estimates[item]===undefined?'':formatDuration(estimates[item]))];
}

export function buildUltrasoundWorkbook(session:Session,participants:Participant[],examinations:Examination[]){
  const summary=buildUltrasoundSummary(participants,examinations);const workbook=XLSX.utils.book_new();
  const overview:(string|number)[][]=[['場次超音波統計總覽',''],['公司',session.companyName],['健檢日期',session.sessionDate],['今日排程人數',summary.scheduled],['今日已報到人數',summary.checkedIn],['今日未報到人數',summary.notCheckedIn],['超音波已完成人數',summary.overall.completedPeople],['超音波檢查中人數',summary.overall.inProgressPeople],['超音波完成總件數',summary.overall.completedItems],['報表說明',summary.overall.inProgressPeople?`本報表匯出時仍有 ${summary.overall.inProgressPeople} 人檢查中，完成統計僅計入已完成檢查。`:'完成統計僅計入已完成檢查。'],[],['【全場超音波項目統計】','','',''],['項目','完成人次','估算總檢查時間','平均估算檢查時間'],...ultrasoundItemNames.map(item=>[item,summary.overall.items[item].count,formatDuration(summary.overall.items[item].estimatedSeconds),formatDuration(summary.overall.items[item].averageEstimatedSeconds)]),[],['【全場時間統計】',''],['全部超音波完成人數',summary.overall.completedPeople],['全部超音波完成件數',summary.overall.completedItems],['全部檢查總時間',formatDuration(summary.overall.totalSeconds)],['平均每位受檢者檢查時間',formatDuration(summary.overall.averageSeconds)],['最短檢查時間',formatDuration(summary.overall.minimumSeconds)],['最長檢查時間',formatDuration(summary.overall.maximumSeconds)]];
  XLSX.utils.book_append_sheet(workbook,sheetFromRows(overview,[28,24,22,24],false),'總覽');
  const roomRows:(string|number)[][]=[['【診間總體統計】','','','','','',''],['診間','完成人數','完成件數','總檢查時間','平均每人檢查時間','最短檢查時間','最長檢查時間'],...summary.rooms.map(room=>[room.roomId,room.statistics.completedPeople,room.statistics.completedItems,formatDuration(room.statistics.totalSeconds),formatDuration(room.statistics.averageSeconds),formatDuration(room.statistics.minimumSeconds),formatDuration(room.statistics.maximumSeconds)]),[],['【診間 × 超音波項目】','','','',''],['診間','超音波項目','完成人次','估算總時間','平均估算時間'],...summary.rooms.flatMap(room=>ultrasoundItemNames.map(item=>[room.roomId,item,room.statistics.items[item].count,formatDuration(room.statistics.items[item].estimatedSeconds),formatDuration(room.statistics.items[item].averageEstimatedSeconds)]))];
  XLSX.utils.book_append_sheet(workbook,sheetFromRows(roomRows,[16,20,14,20,22,18,18],false),'診間統計');
  const people=new Map(participants.map(person=>[person.id,person]));const details=[...examinations].sort((a,b)=>a.startedAt.localeCompare(b.startedAt));const detailSheet=sheetFromRows([detailHeaders,...details.map(item=>detailRow(item,people.get(item.participantId)))],[8,12,16,14,8,14,14,14,12,12,16,16,36,12,20,22,20,22,20]);forceTextColumns(detailSheet,[1,2]);XLSX.utils.book_append_sheet(workbook,detailSheet,'檢查者明細');
  for(const room of summary.rooms){const roomSheet=sheetFromRows([detailHeaders,...room.examinations.map(item=>detailRow(item,people.get(item.participantId)))],[8,12,16,14,8,14,14,14,12,12,16,16,36,12,20,22,20,22,20]);forceTextColumns(roomSheet,[1,2]);const name=`${room.roomId.replace(/\s+/g,'')}明細`.slice(0,31);XLSX.utils.book_append_sheet(workbook,roomSheet,name);}
  return workbook;
}

export function downloadCheckinReport(session:Session,participants:Participant[]){XLSX.writeFile(buildCheckinWorkbook(participants),`${safeFilePart(session.companyName)}_${session.sessionDate}_今日報到狀況.xlsx`);}
export function downloadUltrasoundReport(session:Session,participants:Participant[],examinations:Examination[]){XLSX.writeFile(buildUltrasoundWorkbook(session,participants,examinations),`${safeFilePart(session.companyName)}_${session.sessionDate}_今日超音波狀況.xlsx`);}
