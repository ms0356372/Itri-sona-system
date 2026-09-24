import * as XLSX from 'xlsx';
import type {HistoricalRecord,UltrasoundItemName} from '../../types';

const aliases={
  name:['姓名'],employeeNo:['工號'],nationalId:['身份證號碼','身分證號碼','身份證','身分證'],date:['開單日'],
  abdomen:['腹部超音波'],liver:['腹部超音波(肝)'],gallbladder:['腹部超音波(膽)'],pancreas:['腹部超音波(胰)'],spleen:['腹部超音波(脾)'],kidney:['腹部超音波(腎)'],other:['腹部超音波(其它)','腹部超音波(其他)'],
  hbsag:['HBsAg'],antihbs:['Anti-HBs'],antihcv:['Anti-HCV'],thyroid:['甲狀腺超音波'],thyroidComment:['甲狀腺超音波評語'],prostate:['前列腺超音波'],prostateComment:['前列腺超音波評語'],gynecology:['婦產科超音波'],gynecologyComment:['婦產科超音波評語'],breast:['乳房超音波'],breastCategory:['乳房超音波結果分類'],breastLeft:['乳房超音波(左)'],breastRight:['乳房超音波(右)'],
} as const;
type Field=keyof typeof aliases;
const identityFields:Field[]=['name','employeeNo','nationalId','date'];
const resultFields:Field[]=['abdomen','liver','gallbladder','pancreas','spleen','kidney','other','thyroid','thyroidComment','prostate','prostateComment','gynecology','gynecologyComment','breast','breastCategory','breastLeft','breastRight'];
export const normalizeHeader=(value:unknown)=>String(value??'').trim().replace(/^\*\s*/,'').replace(/[（]/g,'(').replace(/[）]/g,')').replace(/\s+/g,'').toLowerCase();
const text=(value:unknown)=>value===null||value===undefined?'':String(value).trim(); // numeric 0 deliberately remains "0"
const excelDate=(value:unknown)=>{
  let result='';
  if(value instanceof Date&&!Number.isNaN(value.valueOf()))result=`${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;
  else if(typeof value==='number'){const parsed=XLSX.SSF.parse_date_code(value);if(parsed)result=`${parsed.y}-${String(parsed.m).padStart(2,'0')}-${String(parsed.d).padStart(2,'0')}`;}
  else {const match=text(value).match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);if(match)result=`${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`;}
  if(!result)return '';
  const [year,month,day]=result.split('-').map(Number);const date=new Date(Date.UTC(year,month-1,day));
  return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day?result:'';
};
export interface HistoryRowError{row:number;reason:string}
export interface ParsedHistoryFile{records:Omit<HistoricalRecord,'id'|'fingerprint'>[];missing:string[];failed:number;rowErrors:HistoryRowError[];headers:string[];sheetName:string;sourceRows:number}
export type ParseProgress=(progress:{stage:'reading'|'headers'|'parsing';processed:number;total:number})=>void;

function columnsFor(headerRow:unknown[]){
  const normalized=headerRow.map(normalizeHeader);const columns={} as Partial<Record<Field,number>>;
  for(const field of Object.keys(aliases) as Field[]){const wanted=aliases[field].map(normalizeHeader);const index=normalized.findIndex(header=>wanted.includes(header));if(index>=0)columns[field]=index;}
  return columns;
}

export function parseHistorySheet(sheet:XLSX.WorkSheet,sourceFile:string,sheetName='第一張工作表',onRows?:(processed:number,total:number)=>void):ParsedHistoryFile{
  const matrix=XLSX.utils.sheet_to_json<unknown[]>(sheet,{header:1,raw:true,defval:''});
  const rawHeaders=matrix[0]??[];const headers=rawHeaders.map(value=>text(value)).filter(Boolean);const columns=columnsFor(rawHeaders);
  const missing:string[]=identityFields.filter(field=>columns[field]===undefined).map(field=>aliases[field][0]);
  if(!resultFields.some(field=>columns[field]!==undefined))missing.push('可辨識的超音波結果欄位');
  const empty:ParsedHistoryFile={records:[],missing,failed:0,rowErrors:[],headers,sheetName,sourceRows:Math.max(0,matrix.length-1)};
  if(missing.length)return empty;
  const records:Omit<HistoricalRecord,'id'|'fingerprint'>[]=[];const rowErrors:HistoryRowError[]=[];
  for(let index=1;index<matrix.length;index++){
    const row=matrix[index];const get=(field:Field)=>columns[field]===undefined?'':text(row[columns[field]]);const populated=row.some(value=>text(value)!=='');if(!populated)continue;
    const rawDate=row[columns.date!];const date=excelDate(rawDate);const name=get('name');const employeeNo=get('employeeNo');const nationalId=get('nationalId').toUpperCase();
    let reason='';if(!name)reason='缺少姓名。';else if(!date)reason=text(rawDate)?'開單日格式錯誤。':'缺少開單日。';else if(!employeeNo&&!nationalId)reason='身分資料不足（工號與身分證皆空白）。';
    if(reason){rowErrors.push({row:index+1,reason});continue;}
    const base={nationalId,employeeNo,name,date,year:Number(date.slice(0,4)),sourceFile};
    const add=(type:UltrasoundItemName,values:Record<string,string>,examFields:string[])=>{if(examFields.some(key=>values[key]!==''))records.push({...base,type,values});};
    const abdominal={整體結果:get('abdomen'),肝臟:get('liver'),膽囊:get('gallbladder'),胰臟:get('pancreas'),脾臟:get('spleen'),腎臟:get('kidney'),其他:get('other'),HBsAg:get('hbsag'),'Anti-HBs':get('antihbs'),'Anti-HCV':get('antihcv')};
    add('腹部超音波',abdominal,['整體結果','肝臟','膽囊','胰臟','脾臟','腎臟','其他']);
    add('甲狀腺超音波',{結果:get('thyroid'),評語:get('thyroidComment')},['結果','評語']);add('前列腺超音波',{結果:get('prostate'),評語:get('prostateComment')},['結果','評語']);add('婦科超音波',{結果:get('gynecology'),評語:get('gynecologyComment')},['結果','評語']);add('乳房超音波',{結果:get('breast'),結果分類:get('breastCategory'),左側:get('breastLeft'),右側:get('breastRight')},['結果','結果分類','左側','右側']);
    if(index%250===0)onRows?.(index,matrix.length-1);
  }
  onRows?.(matrix.length-1,matrix.length-1);
  return{records,missing:[],failed:rowErrors.length,rowErrors,headers,sheetName,sourceRows:Math.max(0,matrix.length-1)};
}

const nextFrame=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
export async function parseHistoryFile(file:File,onProgress?:ParseProgress){
  onProgress?.({stage:'reading',processed:0,total:0});
  const buffer=await file.arrayBuffer();
  if(typeof Worker!=='undefined')return new Promise<ParsedHistoryFile>((resolve,reject)=>{
    const worker=new Worker(new URL('./history.worker.ts',import.meta.url),{type:'module'});
    worker.onmessage=(event:MessageEvent<{kind:'progress';processed:number;total:number}|{kind:'result';parsed:ParsedHistoryFile}|{kind:'error';message:string}>)=>{const data=event.data;if(data.kind==='progress')onProgress?.({stage:'parsing',processed:data.processed,total:data.total});else if(data.kind==='result'){worker.terminate();resolve(data.parsed);}else{worker.terminate();reject(new Error(data.message));}};
    worker.onerror=()=>{worker.terminate();reject(new Error('Excel 解析程序發生錯誤。'));};worker.postMessage({buffer,fileName:file.name},[buffer]);
  });
  let workbook:XLSX.WorkBook;
  try{workbook=XLSX.read(buffer,{type:'array',cellDates:true});}catch{throw new Error('檔案損壞或不是可讀取的 Excel。');}
  const sheetName=workbook.SheetNames[0];const sheet=sheetName?workbook.Sheets[sheetName]:undefined;if(!sheet)throw new Error('Excel 沒有可讀取的工作表。');
  onProgress?.({stage:'headers',processed:0,total:0});await nextFrame();
  const parsed=parseHistorySheet(sheet,file.name,sheetName,(processed,total)=>onProgress?.({stage:'parsing',processed,total}));await nextFrame();return parsed;
}
export const isNormalUltrasoundResult=(value:string)=>['無明顯異樣','未見明顯異常','無明顯異常','無異樣'].includes(value.trim());
export const displayUltrasoundResult=(value:string)=>isNormalUltrasoundResult(value)?'':value;
