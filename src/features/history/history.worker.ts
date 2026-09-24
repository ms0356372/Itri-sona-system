/// <reference lib="webworker" />
import * as XLSX from 'xlsx';
import {parseHistorySheet} from './excel';

self.onmessage=(event:MessageEvent<{buffer:ArrayBuffer;fileName:string}>)=>{
  try{
    const workbook=XLSX.read(event.data.buffer,{type:'array',cellDates:true});const sheetName=workbook.SheetNames[0];const sheet=sheetName?workbook.Sheets[sheetName]:undefined;
    if(!sheet)throw new Error('Excel 沒有可讀取的工作表。');
    const parsed=parseHistorySheet(sheet,event.data.fileName,sheetName,(processed,total)=>self.postMessage({kind:'progress',processed,total}));self.postMessage({kind:'result',parsed});
  }catch(error){self.postMessage({kind:'error',message:error instanceof Error?error.message:'檔案損壞或不是可讀取的 Excel。'});}
};
