export type GroupCode='A'|'B'|'C'|'D'|'E'|'F'|'G';
export type WorkStatus='未報到'|'等候中'|'已叫號'|'上廁所'|'心電圖'|'先做其他'|'檢查中'|'已完成';
export interface Session {id:string;sessionDate:string;companyName:string;status:'active'|'closing'|'closed'}
export interface Participant {id:string;sessionId:string;sequence:number;nationalId:string;employeeNo:string;name:string;gender:string;slot:string;groupCode:GroupCode;plannedItems:string[];checkinNo:string|null;status:WorkStatus;checkedInAt:string|null;calledAt:string|null;note:string;updatedAt:string}
export interface HistoricalRecord {id?:number;fingerprint:string;nationalId:string;employeeNo:string;name:string;year:number;date:string;type:string;result:string;sourceFile:string}
export interface Examination {id:string;participantId:string;roomId:string;startedAt:string;completedAt:string|null;durationSeconds:number|null;actualItems:string[];itemCount:number;status:'in_progress'|'completed'}
