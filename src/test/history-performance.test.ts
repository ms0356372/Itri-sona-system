import * as XLSX from 'xlsx';
import {beforeEach,describe,expect,it} from 'vitest';
import {db,importHistory} from '../features/history/db';
import {parseHistoryFile,parseHistorySheet} from '../features/history/excel';

const headers=['代碼','公司','姓名','流水號','類別','廠別','部門','課別','輪班別','工號','出生年月','開單日','性別','身份證號碼','到職日','理學檢查','HBsAg','Anti-HBs','Anti-HCV','*腹部超音波','*腹部超音波(肝)','*腹部超音波(膽)','*腹部超音波(胰)','*腹部超音波(脾)','*腹部超音波(腎)','*腹部超音波(其它)','*甲狀腺超音波','*甲狀腺超音波評語','*前列腺超音波','*前列腺超音波評語','*婦產科超音波','*婦產科超音波評語','*乳房超音波','*乳房超音波結果分類','*乳房超音波(左)','*乳房超音波(右)'];
function syntheticData(count:number,reorder=false){
  const data=[[...headers],...Array.from({length:count},(_,index)=>{const row=Array<string>(36).fill('');row[0]='C';row[1]='虛構公司';row[2]=`虛構人員${index}`;row[9]=`E${String(index).padStart(6,'0')}`;row[11]='2025/09/24';row[16]='陰性';row[19]='無明顯異樣';row[20]=index%7?'':`虛構結果${index}`;return row;})];
  if(reorder)data.forEach(row=>row.reverse());return data;
}
function syntheticFile(count:number,reorder=false){
  const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet(syntheticData(count,reorder)),'歷年資料');const bytes=XLSX.write(workbook,{type:'array',bookType:'xlsx'}) as ArrayBuffer;return{name:`synthetic-${count}.xlsx`,arrayBuffer:async()=>bytes} as File;
}

describe('large synthetic history workbooks',()=>{
  beforeEach(async()=>{await db.open();await Promise.all([db.history.clear(),db.historyImports.clear(),db.pendingHistory.clear()]);});
  for(const count of [500,5_000,10_000])it(`parses and imports ${count.toLocaleString()} rows with bounded indexed batches`,async()=>{
    const started=performance.now();const parsed=count===500?await parseHistoryFile(syntheticFile(count,true)):parseHistorySheet(XLSX.utils.aoa_to_sheet(syntheticData(count)),`synthetic-${count}.xlsx`);const parsedAt=performance.now();expect(parsed.missing).toEqual([]);expect(parsed.records).toHaveLength(count);
    const updates:number[]=[];const first=await importHistory(parsed.records,`synthetic-${count}.xlsx`,{batchSize:300,sourceRows:count,onProgress:value=>updates.push(value.processed)});const importedAt=performance.now();expect(first.inserted).toBe(count);expect(updates.at(-1)).toBe(count);
    const repeat=await importHistory(parsed.records,`synthetic-${count}.xlsx`,{batchSize:300});expect(repeat.skipped).toBe(count);expect(await db.history.count()).toBe(count);
    console.info(`[history benchmark] ${count} rows: parse ${Math.round(parsedAt-started)} ms; first import ${Math.round(importedAt-parsedAt)} ms; including repeat ${Math.round(performance.now()-started)} ms`);
  },60_000);
});
