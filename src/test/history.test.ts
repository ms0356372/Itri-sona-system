import * as XLSX from 'xlsx';
import {beforeEach,describe,expect,it} from 'vitest';
import {db,findHistoryByNationalId,importHistory} from '../features/history/db';
import {displayUltrasoundResult,parseHistoryFile,parseHistorySheet} from '../features/history/excel';

const headers=['姓名','工號','身份證號碼','開單日','*腹部超音波 ','*腹部超音波（肝）','*腹部超音波(膽)','*腹部超音波(胰)','*腹部超音波(脾)','*腹部超音波(腎)','*腹部超音波(其它)','HBsAg','Anti-HBs','Anti-HCV','*甲狀腺超音波','*甲狀腺超音波評語','*前列腺超音波','*前列腺超音波評語','*婦產科超音波','*婦產科超音波評語','*乳房超音波','*乳房超音波結果分類','*乳房超音波(左)','*乳房超音波(右)'];
const row=(date:string,abdomen:unknown,liver:unknown,thyroid:unknown='')=>['測試人員','00125',' a123456789 ',date,abdomen,liver,'無明顯異樣','','','','','陰性','陽性 100','陰性',thyroid,'','','','','','','','',''];
const sheet=()=>XLSX.utils.aoa_to_sheet([headers,row('2025/09/10','無明顯異樣','輕度脂肪肝'),row('2025/03/15','未見明顯異常',''),row('2024/08/20',0,'', '右葉結節'),row('2024/02/01','無異樣','')]);

describe('formal history Excel',()=>{
  beforeEach(async()=>{await db.open();await Promise.all([db.history.clear(),db.historyImports.clear(),db.pendingHistory.clear()]);});
  it('matches real headers, preserves blank versus numeric zero, labs, and same-year visits',()=>{const parsed=parseHistorySheet(sheet(),'synthetic.xlsx');expect(parsed.missing).toEqual([]);const abdomen=parsed.records.filter(record=>record.type==='腹部超音波');expect(abdomen).toHaveLength(4);expect(abdomen[0].nationalId).toBe('A123456789');expect(abdomen[0].employeeNo).toBe('00125');expect(abdomen[0].values.胰臟).toBe('');expect(abdomen[2].values.整體結果).toBe('0');expect(abdomen[0].values.HBsAg).toBe('陰性');expect(abdomen.slice(0,2).map(record=>record.date)).toEqual(['2025-09-10','2025-03-15']);});
  it('reads an actual xlsx buffer through SheetJS without exposing string-table indexes',async()=>{const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,sheet(),'工作表1');const bytes=XLSX.write(workbook,{type:'array',bookType:'xlsx',bookSST:true}) as ArrayBuffer;const file={name:'超音波歷年資料.xlsx',arrayBuffer:async()=>bytes} as File;const parsed=await parseHistoryFile(file);expect(parsed.records[0].values.胰臟).toBe('');expect(parsed.records.find(record=>record.date==='2024-08-20'&&record.type==='腹部超音波')?.values.整體結果).toBe('0');});
  it('only hides exact confirmed normal phrases in the UI',()=>{expect(displayUltrasoundResult(' 無明顯異樣 ')).toBe('');expect(displayUltrasoundResult('未見明顯異常，建議追蹤')).toBe('未見明顯異常，建議追蹤');expect(displayUltrasoundResult('輕度脂肪肝，其餘未見明顯異常')).toContain('輕度脂肪肝');expect(displayUltrasoundResult('0')).toBe('0');});
  it('deduplicates identical imports, keeps identity lookup local, and queues conflicts',async()=>{const parsed=parseHistorySheet(sheet(),'one.xlsx');const first=await importHistory(parsed.records,'one.xlsx');const second=await importHistory(parsed.records,'one.xlsx');expect(first.inserted).toBe(parsed.records.length);expect(second.skipped).toBe(parsed.records.length);expect(await findHistoryByNationalId('a123456789')).toHaveLength(parsed.records.length);const changed={...parsed.records[0],values:{...parsed.records[0].values,肝臟:'不同內容'}};expect((await importHistory([changed],'conflict.xlsx')).pending).toBe(1);expect(await db.history.count()).toBe(parsed.records.length);});
  it('accepts reordered and partial ultrasound columns but reports required headers and bad rows',()=>{
    const partial=XLSX.utils.aoa_to_sheet([[' 開單日 ','*腹部超音波(肝)',' 身份證號碼 ','姓名','工號'],['2025-02-29','脂肪肝','A123456789','測試人員',''],['2024-02-29','脂肪肝','','測試人員','001']]);
    const parsed=parseHistorySheet(partial,'partial.xlsx','歷年');expect(parsed.missing).toEqual([]);expect(parsed.records).toHaveLength(1);expect(parsed.rowErrors).toEqual([{row:2,reason:'開單日格式錯誤。'}]);
    const invalid=parseHistorySheet(XLSX.utils.aoa_to_sheet([['姓名','工號','身份證號碼','腹部超音波'],['甲','1','','正常']]),'bad.xlsx','Sheet1');expect(invalid.missing).toContain('開單日');expect(invalid.headers).toContain('姓名');
    const noExam=parseHistorySheet(XLSX.utils.aoa_to_sheet([['姓名','工號','身份證號碼','開單日','HBsAg']]),'bad.xlsx');expect(noExam.missing).toContain('可辨識的超音波結果欄位');
  });
});
