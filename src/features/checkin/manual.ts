import {normalizeNationalId} from '../../lib/privacy';
import {isCompleteNationalId} from './lookup';

export const DEFAULT_MANUAL_ITEM='一般';
type ManualFields={employeeNo:string;name:string;gender:string;item:string;extension:string};

/** These defaults belong to a new manual person, never to an existing roster row. */
export function normalizeManualFields<T extends ManualFields>(source:T):T{
  return {...source,employeeNo:source.employeeNo.trim(),name:source.name.trim(),
    gender:source.gender.trim(),item:source.item.trim()||DEFAULT_MANUAL_ITEM,extension:source.extension.trim()};
}

export function manualIdentityError(person:{nationalId:string;name:string;employeeNo:string}):string{
  if(!isCompleteNationalId(normalizeNationalId(person.nationalId)))return '請確認完整且格式正確的身分證。';
  if(!person.name.trim())return '請輸入姓名。';
  if(!person.employeeNo.trim())return '請輸入工號。';
  return '';
}
