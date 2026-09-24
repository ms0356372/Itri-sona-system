import * as XLSX from 'xlsx';
import type {HistoricalRecord,UltrasoundItemName} from '../../types';

const aliases={
  name:['姓名'],employeeNo:['工號'],nationalId:['身份證號碼','身分證號碼','身份證','身分證'],date:['開單日'],
  abdomen:['腹部超音波'],liver:['腹部超音波(肝)'],gallbladder:['腹部超音波(膽)'],pancreas:['腹部超音波(胰)'],spleen:['腹部超音波(脾)'],kidney:['腹部超音波(腎)'],other:['腹部超音波(其它)','腹部超音波(其他)'],
  hbsag:['HBsAg'],antihbs:['Anti-HBs'],antihcv:['Anti-HCV'],thyroid:['甲狀腺超音波'],thyroidComment:['甲狀腺超音波評語'],prostate:['前列腺超音波'],prostateComment:['前列腺超音波評語'],gynecology:['婦產科超音波'],gynecologyComment:['婦產科超音波評語'],breast:['乳房超音波'],breastCategory:['乳房超音波結果分類'],breastLeft:['乳房超音波(左)'],breastRight:['乳房超音波(右)'],
} as const;
type Field=keyof typeof aliases;
const required:Field[]=['name','employeeNo','nationalId','date','abdomen','liver','gallbladder','pancreas','spleen','kidney','other','hbsag','antihbs','antihcv','thyroid','thyroidComment','prostate','prostateComment','gynecology','gynecologyComment','breast','breastCategory','breastLeft','breastRight'];
export const normalizeHeader=(value:unknown)=>String(value??'').trim().replace(/^\*\s*/,'').replace(/[（]/g,'(').replace(/[）]/g,')').replace(/\s+/g,'').toLowerCase();
const text=(value:unknown)=>value===null||value===undefined?'':String(value).trim(); // numeric 0 deliberately remains "0"
const excelDate=(value:unknown)=>{if(value instanceof Date&&!Number.isNaN(value.valueOf()))return value.toISOString().slice(0,10);if(typeof value==='number'){const parsed=XLSX.SSF.parse_date_code(value);if(parsed)return `${parsed.y}-${String(parsed.m).padStart(2,'0')}-${String(parsed.d).padStart(2,'0')}`;}const raw=text(value);const match=raw.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);return match?`${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`:raw;};
export interface ParsedHistoryFile{records:Omit<HistoricalRecord,'id'|'fingerprint'>[];missing:string[];failed:number}

export function parseHistorySheet(sheet:XLSX.WorkSheet,sourceFile:string):ParsedHistoryFile{
  const matrix=XLSX.utils.sheet_to_json<unknown[]>(sheet,{header:1,raw:true,defval:''});
  const headers=(matrix[0]??[]).map(normalizeHeader);const columns={} as Partial<Record<Field,number>>;
  for(const field of required){const wanted=aliases[field].map(normalizeHeader);const index=headers.findIndex(header=>wanted.includes(header));if(index>=0)columns[field]=index;}
  const missing=required.filter(field=>columns[field]===undefined).map(field=>aliases[field][0]);if(missing.length)return{records:[],missing,failed:0};
  const records:Omit<HistoricalRecord,'id'|'fingerprint'>[]=[];let failed=0;
  for(const row of matrix.slice(1)){
    const get=(field:Field)=>text(row[columns[field]!]);const date=excelDate(row[columns.date!]);const name=get('name');const employeeNo=get('employeeNo');const nationalId=get('nationalId').toUpperCase();
    if(!name&&!employeeNo&&!nationalId&&!date)continue;if(!name||!date||(!employeeNo&&!nationalId)){failed++;continue;}
    const base={nationalId,employeeNo,name,date,year:Number(date.slice(0,4))||0,sourceFile};
    const add=(type:UltrasoundItemName,values:Record<string,string>,examFields:string[])=>{if(examFields.some(key=>values[key]!==''))records.push({...base,type,values});};
    const abdominal={整體結果:get('abdomen'),肝臟:get('liver'),膽囊:get('gallbladder'),胰臟:get('pancreas'),脾臟:get('spleen'),腎臟:get('kidney'),其他:get('other'),HBsAg:get('hbsag'),'Anti-HBs':get('antihbs'),'Anti-HCV':get('antihcv')};
    add('腹部超音波',abdominal,['整體結果','肝臟','膽囊','胰臟','脾臟','腎臟','其他']);
    add('甲狀腺超音波',{結果:get('thyroid'),評語:get('thyroidComment')},['結果','評語']);add('前列腺超音波',{結果:get('prostate'),評語:get('prostateComment')},['結果','評語']);add('婦科超音波',{結果:get('gynecology'),評語:get('gynecologyComment')},['結果','評語']);add('乳房超音波',{結果:get('breast'),結果分類:get('breastCategory'),左側:get('breastLeft'),右側:get('breastRight')},['結果','結果分類','左側','右側']);
  }
  return{records,missing,failed};
}
export async function parseHistoryFile(file:File){const workbook=XLSX.read(await file.arrayBuffer(),{type:'array',cellDates:true});const sheet=workbook.Sheets[workbook.SheetNames[0]];if(!sheet)throw new Error('Excel 沒有可讀取的工作表。');return parseHistorySheet(sheet,file.name);}
export const isNormalUltrasoundResult=(value:string)=>['無明顯異樣','未見明顯異常','無明顯異常','無異樣'].includes(value.trim());
export const displayUltrasoundResult=(value:string)=>isNormalUltrasoundResult(value)?'':value;
