import Dexie,{type EntityTable} from 'dexie'; import type {HistoricalRecord} from '../../types';
export class ClinicDatabase extends Dexie {history!:EntityTable<HistoricalRecord,'id'>; drafts!:EntityTable<{participantId:string;roomId:string;startedAt:string;items:string[]},'participantId'>; constructor(){super('ultrasound-clinic-local');this.version(1).stores({history:'++id,&fingerprint,nationalId,employeeNo,year,date',drafts:'&participantId,roomId'});}}
export const db=new ClinicDatabase();
export const historyFingerprint=(r:Omit<HistoricalRecord,'fingerprint'|'id'>)=>[r.nationalId,r.employeeNo,r.date,r.type,r.result].join('|');
export async function saveHistory(rows:Omit<HistoricalRecord,'fingerprint'|'id'>[]){return db.history.bulkPut(rows.map(r=>({...r,fingerprint:historyFingerprint(r)})));}
