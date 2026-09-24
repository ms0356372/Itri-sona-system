export type GroupCode='A'|'B'|'C'|'D'|'E'|'F'|'G';
export type WorkStatus='未報到'|'等候中'|'已叫號'|'上廁所'|'心電圖'|'先做其他'|'檢查中'|'已完成';
export interface Session {id:string;sessionDate:string;companyName:string;status:'active'|'closing'|'closed'}
export interface Participant {id:string;sessionId:string;sequence:number;employeeNo:string;name:string;gender:string;slot:string;groupCode:GroupCode;plannedItems:string[];checkinNo:string|null;status:WorkStatus;checkedInAt:string|null;calledAt:string|null;note:string;updatedAt:string}
export const ultrasoundItemNames=['腹部超音波','甲狀腺超音波','婦科超音波','前列腺超音波','乳房超音波'] as const;
export type UltrasoundItemName=typeof ultrasoundItemNames[number];
export interface HistoricalRecord {id?:number;fingerprint:string;nationalId:string;employeeNo:string;name:string;year:number;date:string;type:UltrasoundItemName;values:Record<string,string>;sourceFile:string}
export interface HistoryImportSummary {inserted:number;skipped:number;pending:number;failed:number}
export interface HistoryImport extends HistoryImportSummary{id?:number;fileName:string;importedAt:string}
export interface PendingHistoryRecord{id?:number;identity:string;date:string;type:UltrasoundItemName;existingFingerprint:string;incoming:HistoricalRecord;sourceFile:string;createdAt:string}
export interface Examination {id:string;participantId:string;roomId:string;startedAt:string;completedAt:string|null;durationSeconds:number|null;selectedItems:UltrasoundItemName[];actualItems:UltrasoundItemName[];itemCount:number;status:'in_progress'|'completed'}

export interface ImportResult {inserted:number;skipped:number}
