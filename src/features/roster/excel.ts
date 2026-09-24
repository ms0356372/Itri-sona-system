import * as XLSX from 'xlsx';
import {normalizeNationalId} from '../../lib/privacy';
import {normalizeSlot} from '../schedule/rules';
import type {DailySchedulePerson,MasterPerson,PreparedPerson} from './types';

const normalizeHeader=(value:string)=>value.trim().replace(/[\s\u3000_\uFF3F]/g,'').replace(/[（]/g,'(').replace(/[）]/g,')').toLowerCase();
const masterAliases={employeeNo:['工號','人員工號','員工編號','員工工號'],name:['姓名','人員姓名','員工姓名'],nationalId:['身分證','身份證','身分證號','身份證號','身分證字號','身份證字號','id'],gender:['性別'],originalActivity:['活動項目(原始)','原始活動項目','活動項目原始'],item:['項目','檢查項目'],extension:['院內分機','分機','分機號碼']} as const;
const dailyAliases={employeeNo:['人員工號','工號','員工編號','員工工號'],name:['人員姓名','姓名','員工姓名'],scheduleDate:['排程日期','健檢日期','日期'],slot:['排程時段','時段','預約時段'],activity:['活動項目','健檢活動項目'],extension:['院內分機','分機','分機號碼']} as const;

function headerMap<T extends Record<string,readonly string[]>>(headers:string[],aliases:T){const result:Partial<Record<keyof T,string>>={};for(const[key,names]of Object.entries(aliases) as [keyof T,readonly string[]][]){const accepted=names.map(normalizeHeader);const hit=headers.find(header=>accepted.includes(normalizeHeader(header)));if(hit)result[key]=hit;}return result;}
const text=(row:Record<string,unknown>,key:string|undefined)=>String(key?row[key]??'':'').trim();
export const normalizeScheduleDate=(value:string)=>{const match=value.trim().match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);return match?`${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`:value.trim();};
function sheetRows(bytes:ArrayBuffer){const workbook=XLSX.read(bytes,{type:'array',cellText:true,cellDates:false});return XLSX.utils.sheet_to_json<Record<string,unknown>>(workbook.Sheets[workbook.SheetNames[0]],{raw:false,defval:''});}

export function parseMasterRows(raw:Record<string,unknown>[],companyName:string){
  const map=headerMap(Object.keys(raw[0]??{}),masterAliases);const missing=(['employeeNo','name','nationalId','gender','originalActivity','item'] as const).filter(k=>!map[k]);if(missing.length)throw new Error(`大名單缺少必要欄位：${missing.map(k=>masterAliases[k][0]).join('、')}`);
  const now=new Date().toISOString();return raw.filter(row=>Object.values(row).some(Boolean)).map((row,index):MasterPerson=>{const person={companyName,employeeNo:text(row,map.employeeNo),name:text(row,map.name),nationalId:normalizeNationalId(text(row,map.nationalId)),gender:text(row,map.gender),originalActivity:text(row,map.originalActivity),item:text(row,map.item),extension:text(row,map.extension),updatedAt:now};if(!person.employeeNo||!person.name)throw new Error(`大名單第 ${index+2} 列缺少工號或姓名`);return person;});
}
export function parseDailyRows(raw:Record<string,unknown>[]){
  const map=headerMap(Object.keys(raw[0]??{}),dailyAliases);const missing=(['employeeNo','name','scheduleDate','slot','activity'] as const).filter(k=>!map[k]);if(missing.length)throw new Error(`每日排程缺少必要欄位：${missing.map(k=>dailyAliases[k][0]).join('、')}`);
  return raw.filter(row=>Object.values(row).some(Boolean)).map((row,index):DailySchedulePerson=>({sourceRow:index+2,employeeNo:text(row,map.employeeNo),name:text(row,map.name),scheduleDate:normalizeScheduleDate(text(row,map.scheduleDate)),slot:normalizeSlot(text(row,map.slot)),activity:text(row,map.activity),extension:text(row,map.extension)}));
}
export async function readMasterFile(file:File,companyName:string){return parseMasterRows(sheetRows(await file.arrayBuffer()),companyName);}
export async function readDailyFile(file:File){return parseDailyRows(sheetRows(await file.arrayBuffer()));}

export function preparedRosterWorkbook(rows:PreparedPerson[]){
  const data=rows.map((row,index)=>({'序號':index+1,'工號':row.employeeNo,'姓名':row.name,'性別':row.gender,'排程日期':row.scheduleDate,'排程時段':row.slot,'項目':row.item,'院內分機':row.extension,'身分證':row.nationalId}));
  const sheet=XLSX.utils.json_to_sheet(data);sheet['!cols']=[6,14,12,8,14,16,20,14,16].map(w=>({wch:w}));const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,sheet,'整理後排程');return workbook;
}
export function exportPreparedRoster(rows:PreparedPerson[],companyName:string,date:string){XLSX.writeFile(preparedRosterWorkbook(rows),`${companyName}_${date}_排程.xlsx`);}
