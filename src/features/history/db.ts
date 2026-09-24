import Dexie,{type EntityTable} from 'dexie';
import type {HistoricalRecord,HistoryImport,HistoryImportSummary,PendingHistoryRecord} from '../../types';

export class ClinicDatabase extends Dexie {
  history!:EntityTable<HistoricalRecord,'id'>;historyImports!:EntityTable<HistoryImport,'id'>;pendingHistory!:EntityTable<PendingHistoryRecord,'id'>;drafts!:EntityTable<{participantId:string;roomId:string;startedAt:string|null;items:string[]},'participantId'>;
  constructor(){
    super('ultrasound-clinic-local');
    this.version(1).stores({history:'++id,&fingerprint,nationalId,employeeNo,year,date',drafts:'&participantId,roomId'});
    this.version(2).stores({history:'++id,&fingerprint,employeeNo,year,date',drafts:'&participantId,roomId'}).upgrade(transaction=>transaction.table('history').toCollection().modify(record=>{delete record.nationalId;}));
    // v3 restores nationalId locally only. Existing v2 rows remain intact and are not assigned guessed identities.
    this.version(3).stores({history:'++id,&fingerprint,nationalId,employeeNo,year,date,type,[nationalId+date+type]',historyImports:'++id,importedAt,fileName',pendingHistory:'++id,identity,date,type',drafts:'&participantId,roomId'}).upgrade(transaction=>transaction.table('history').toCollection().modify(record=>{if(!record.values)record.values={結果:String(record.result??'')};delete record.result;}));
    this.version(4).stores({history:'++id,&fingerprint,nationalId,employeeNo,year,date,type,[nationalId+date+type],[employeeNo+date+type]',historyImports:'++id,importedAt,fileName,status',pendingHistory:'++id,incomingFingerprint,identity,date,type',drafts:'&participantId,roomId'}).upgrade(transaction=>transaction.table('pendingHistory').toCollection().modify(record=>{record.incomingFingerprint=record.incoming?.fingerprint??`${record.identity}|${record.date}|${record.type}|legacy-${record.id}`; }));
  }
}
export const db=new ClinicDatabase();

const stable=(value:unknown):string=>value&&typeof value==='object'?`{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${stable(item)}`).join(',')}}`:JSON.stringify(value);
export const historyFingerprint=(r:Omit<HistoricalRecord,'fingerprint'|'id'>)=>[r.nationalId,r.employeeNo,r.date,r.type,stable(r.values)].join('|');
const identityOf=(r:Pick<HistoricalRecord,'nationalId'|'employeeNo'>)=>r.nationalId||`EMP:${r.employeeNo}`;
const visitKeys=(r:Pick<HistoricalRecord,'nationalId'|'employeeNo'|'date'|'type'>)=>[r.nationalId&&`ID:${r.nationalId}|${r.date}|${r.type}`,r.employeeNo&&`EMP:${r.employeeNo}|${r.date}|${r.type}`].filter(Boolean) as string[];
export interface HistoryImportProgress{batch:number;batches:number;processed:number;total:number;summary:HistoryImportSummary}
export interface ImportHistoryOptions{batchSize?:number;sourceRows?:number;onProgress?:(progress:HistoryImportProgress)=>void}
const storageMessage=(error:unknown)=>error instanceof DOMException&&(['QuotaExceededError','UnknownError'].includes(error.name))?'瀏覽器儲存空間不足，無法繼續寫入。':`IndexedDB 寫入或交易失敗：${error instanceof Error?error.message:'未知錯誤'}`;

export async function importHistory(rows:Omit<HistoricalRecord,'fingerprint'|'id'>[],fileName:string,options:ImportHistoryOptions={}):Promise<HistoryImportSummary>{
  const summary:HistoryImportSummary={inserted:0,skipped:0,pending:0,failed:0};const batchSize=options.batchSize??300;
  const nationalIds=[...new Set(rows.map(row=>row.nationalId).filter(Boolean))];const employeeNos=[...new Set(rows.map(row=>row.employeeNo).filter(Boolean))];
  const nationalIdSet=new Set(nationalIds);const employeeNoSet=new Set(employeeNos);
  // Indexed lookups replace the former per-row Collection.filter full-table scan.
  const usePreloadedIndex=nationalIds.length+employeeNos.length>500;
  const [byId,byEmployee,pendingRecords]=await Promise.all([
    usePreloadedIndex?db.history.toArray():nationalIds.length?db.history.where('nationalId').anyOf(nationalIds).toArray():[],usePreloadedIndex?Promise.resolve([]):employeeNos.length?db.history.where('employeeNo').anyOf(employeeNos).toArray():[],db.pendingHistory.toArray(),
  ]);
  // Large imports scan once and build in-memory hash indexes; small imports use IndexedDB indexes directly.
  const relevant=(record:HistoricalRecord)=>nationalIdSet.has(record.nationalId)||employeeNoSet.has(record.employeeNo);
  const existing=[...new Map([...byId,...byEmployee].filter(record=>!usePreloadedIndex||relevant(record)).map(record=>[record.fingerprint,record])).values()];const fingerprints=new Set(existing.map(record=>record.fingerprint));const pendingSet=new Set(pendingRecords.map(record=>record.incomingFingerprint));const visits=new Map<string,HistoricalRecord>();
  for(const record of existing)for(const key of visitKeys(record))if(!visits.has(key))visits.set(key,record);
  const batches=Math.ceil(rows.length/batchSize);
  try{
    for(let offset=0;offset<rows.length;offset+=batchSize){
      const additions:HistoricalRecord[]=[];const pendings:PendingHistoryRecord[]=[];
      for(const raw of rows.slice(offset,offset+batchSize)){
        const record:HistoricalRecord={...raw,fingerprint:historyFingerprint(raw)};
        if(fingerprints.has(record.fingerprint)){summary.skipped++;continue;}
        if(pendingSet.has(record.fingerprint)){summary.skipped++;continue;}
        const conflict=visitKeys(record).map(key=>visits.get(key)).find(Boolean);
        if(conflict&&stable(conflict.values)===stable(record.values)){fingerprints.add(record.fingerprint);summary.skipped++;continue;}
        if(conflict){pendings.push({identity:identityOf(record),date:record.date,type:record.type,existingFingerprint:conflict.fingerprint,incomingFingerprint:record.fingerprint,incoming:record,sourceFile:fileName,createdAt:new Date().toISOString()});pendingSet.add(record.fingerprint);summary.pending++;continue;}
        additions.push(record);fingerprints.add(record.fingerprint);for(const key of visitKeys(record))visits.set(key,record);summary.inserted++;
      }
      await db.transaction('rw',db.history,db.pendingHistory,async()=>{if(additions.length)await db.history.bulkAdd(additions);if(pendings.length)await db.pendingHistory.bulkAdd(pendings);});
      options.onProgress?.({batch:Math.floor(offset/batchSize)+1,batches,processed:Math.min(offset+batchSize,rows.length),total:rows.length,summary:{...summary}});
      await new Promise<void>(resolve=>setTimeout(resolve,0));
    }
    await db.historyImports.add({fileName,importedAt:new Date().toISOString(),status:'completed',sourceRows:options.sourceRows,...summary});
    return summary;
  }catch(error){
    // Earlier committed batches intentionally remain; their fingerprints make retry idempotent.
    summary.failed+=rows.length-summary.inserted-summary.skipped-summary.pending;
    try{await db.historyImports.add({fileName,importedAt:new Date().toISOString(),status:'partial',sourceRows:options.sourceRows,...summary});}catch(saveError){console.error('Unable to save sanitized partial import status',saveError instanceof Error?saveError.name:'database error');}
    throw new Error(`${storageMessage(error)} 已成功新增 ${summary.inserted} 筆、略過 ${summary.skipped} 筆、待確認 ${summary.pending} 筆。`);
  }
}

export async function findHistoryByNationalId(nationalId:string){return db.history.where('nationalId').equals(nationalId.trim().toUpperCase()).reverse().sortBy('date');}
export async function findHistoryByEmployeeNo(employeeNo:string){return db.history.where('employeeNo').equals(employeeNo.trim()).reverse().sortBy('date');}
export async function historyStats(){const imports=await db.historyImports.toArray();const records=await db.history.toArray();const pending=await db.pendingHistory.count();return{fileCount:imports.length,recordCount:records.length,years:[...new Set(records.map(r=>r.year))].sort(),lastImportAt:imports.sort((a,b)=>b.importedAt.localeCompare(a.importedAt))[0]?.importedAt??'',pending,lastSummary:imports.at(-1)};}
export async function clearHistory(){await db.transaction('rw',db.history,db.historyImports,db.pendingHistory,async()=>{await Promise.all([db.history.clear(),db.historyImports.clear(),db.pendingHistory.clear()]);});}
