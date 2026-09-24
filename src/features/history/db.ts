import Dexie,{type EntityTable} from 'dexie';
import type {HistoricalRecord,HistoryImport,HistoryImportSummary,PendingHistoryRecord} from '../../types';

export class ClinicDatabase extends Dexie {
  history!:EntityTable<HistoricalRecord,'id'>;
  historyImports!:EntityTable<HistoryImport,'id'>;
  pendingHistory!:EntityTable<PendingHistoryRecord,'id'>;
  drafts!:EntityTable<{participantId:string;roomId:string;startedAt:string|null;items:string[]},'participantId'>;
  constructor(){
    super('ultrasound-clinic-local');
    this.version(1).stores({history:'++id,&fingerprint,nationalId,employeeNo,year,date',drafts:'&participantId,roomId'});
    this.version(2).stores({history:'++id,&fingerprint,employeeNo,year,date',drafts:'&participantId,roomId'}).upgrade(transaction=>transaction.table('history').toCollection().modify(record=>{delete record.nationalId;}));
    // v3 restores nationalId locally only. Existing v2 rows remain intact and are not assigned guessed identities.
    this.version(3).stores({history:'++id,&fingerprint,nationalId,employeeNo,year,date,type,[nationalId+date+type]',historyImports:'++id,importedAt,fileName',pendingHistory:'++id,identity,date,type',drafts:'&participantId,roomId'}).upgrade(transaction=>transaction.table('history').toCollection().modify(record=>{if(!record.values)record.values={結果:String(record.result??'')};delete record.result;}));
  }
}
export const db=new ClinicDatabase();

const stable=(value:unknown):string=>value&&typeof value==='object'?`{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${stable(item)}`).join(',')}}`:JSON.stringify(value);
export const historyFingerprint=(r:Omit<HistoricalRecord,'fingerprint'|'id'>)=>[r.nationalId,r.employeeNo,r.date,r.type,stable(r.values)].join('|');
const identityOf=(r:Pick<HistoricalRecord,'nationalId'|'employeeNo'>)=>r.nationalId||`EMP:${r.employeeNo}`;

export async function importHistory(rows:Omit<HistoricalRecord,'fingerprint'|'id'>[],fileName:string):Promise<HistoryImportSummary>{
  const summary:HistoryImportSummary={inserted:0,skipped:0,pending:0,failed:0};
  await db.transaction('rw',db.history,db.pendingHistory,db.historyImports,async()=>{
    for(const raw of rows){
      try{
        const record={...raw,fingerprint:historyFingerprint(raw)};
        if(await db.history.where('fingerprint').equals(record.fingerprint).first()){summary.skipped++;continue;}
        const identity=identityOf(record);
        const sameVisit=await db.history.filter(existing=>identityOf(existing)===identity&&existing.date===record.date&&existing.type===record.type).first();
        if(sameVisit){await db.pendingHistory.add({identity,date:record.date,type:record.type,existingFingerprint:sameVisit.fingerprint,incoming:record,sourceFile:fileName,createdAt:new Date().toISOString()});summary.pending++;continue;}
        await db.history.add(record);summary.inserted++;
      }catch{summary.failed++;}
    }
    await db.historyImports.add({fileName,importedAt:new Date().toISOString(),...summary});
  });
  return summary;
}

export async function findHistoryByNationalId(nationalId:string){return db.history.where('nationalId').equals(nationalId.trim().toUpperCase()).reverse().sortBy('date');}
export async function findHistoryByEmployeeNo(employeeNo:string){return db.history.where('employeeNo').equals(employeeNo.trim()).reverse().sortBy('date');}
export async function historyStats(){const imports=await db.historyImports.toArray();const records=await db.history.toArray();const pending=await db.pendingHistory.count();return{fileCount:imports.length,recordCount:records.length,years:[...new Set(records.map(r=>r.year))].sort(),lastImportAt:imports.sort((a,b)=>b.importedAt.localeCompare(a.importedAt))[0]?.importedAt??'',pending,lastSummary:imports.at(-1)};}
export async function clearHistory(){await db.transaction('rw',db.history,db.historyImports,db.pendingHistory,async()=>{await Promise.all([db.history.clear(),db.historyImports.clear(),db.pendingHistory.clear()]);});}
