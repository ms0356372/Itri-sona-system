import type {MasterPerson} from './types';

export interface MasterUpdateSummary {
  inserted:number;
  updated:number;
  retained:number;
  total:number;
}

type ImportIdentity=Pick<MasterPerson,'employeeNo'|'name'>&{sourceRow?:number};

/** Reject ambiguous imports before any local data or lock state is changed. */
export function assertUniqueImportedEmployees(people:ImportIdentity[]):void {
  const grouped=new Map<string,{name:string;sourceRow:number}[]>();
  people.forEach((person,index)=>{
    const entries=grouped.get(person.employeeNo)??[];
    entries.push({name:person.name,sourceRow:person.sourceRow??index+2});
    grouped.set(person.employeeNo,entries);
  });
  const duplicates=[...grouped].filter(([,entries])=>entries.length>1);
  if(!duplicates.length)return;
  const numbers=duplicates.map(([employeeNo])=>employeeNo).join('、');
  const details=duplicates.map(([employeeNo,entries])=>`${employeeNo}：${entries.map(entry=>`${entry.name||'未填姓名'}（Excel 第 ${entry.sourceRow} 列）`).join('、')}`).join('；');
  throw new Error(`本次匯入檔案有重複工號：${numbers}，請確認檔案後重新匯入。\n${details}`);
}

const requiredFields={employeeNo:'工號',name:'姓名',nationalId:'身分證',gender:'性別',originalActivity:'活動項目(原始)',item:'項目'} as const;

export function assertCompleteImportedPeople(people:(MasterPerson&{sourceRow?:number})[]):void {
  const errors:string[]=[];
  people.forEach((person,index)=>{
    const missing=(Object.keys(requiredFields) as (keyof typeof requiredFields)[]).filter(key=>!person[key].trim());
    if(!missing.length)return;
    const employee=person.employeeNo.trim()?`工號 ${person.employeeNo.trim()}`:'工號未填';
    const name=person.name.trim()||'姓名未填';
    errors.push(`第 ${person.sourceRow??index+2} 列｜${employee}｜${name}｜缺少：${missing.map(key=>requiredFields[key]).join('、')}`);
  });
  if(errors.length)throw new Error(`本次匯入檔案有 ${errors.length} 筆資料不完整，請確認後重新匯入。\n\n${errors.join('\n')}`);
}

/** Exact employee numbers are intentional: 00125 and 125 are separate people. */
export function previewCompanyMasterUpdate(existing:MasterPerson[],incoming:MasterPerson[]):MasterUpdateSummary {
  assertUniqueImportedEmployees(incoming);
  const currentEmployees=new Set(existing.map(person=>person.employeeNo));
  const updated=incoming.filter(person=>currentEmployees.has(person.employeeNo)).length;
  const inserted=incoming.length-updated;
  return{inserted,updated,retained:existing.length-updated,total:existing.length+inserted};
}
