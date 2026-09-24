export interface MasterPerson {
  id?: number;
  companyName: string;
  employeeNo: string;
  name: string;
  nationalId: string;
  gender: string;
  originalActivity: string;
  item: string;
  extension: string;
  updatedAt: string;
}

export interface DailySchedulePerson {
  sourceRow: number;
  employeeNo: string;
  name: string;
  scheduleDate: string;
  slot: string;
  activity: string;
  extension: string;
}

export type RosterIssueCode = 'master_not_found'|'name_mismatch'|'activity_mismatch'|'duplicate_master'|'duplicate_daily'|'missing_master_data'|'incomplete_daily';

export interface PreparedPerson {
  localId: string;
  sequence: number;
  employeeNo: string;
  name: string;
  gender: string;
  scheduleDate: string;
  slot: string;
  item: string;
  extension: string;
  nationalId: string;
  originalActivity: string;
  dailyActivity: string;
  issues: RosterIssueCode[];
  confirmed: boolean;
}

export interface MatchResult { ready: PreparedPerson[]; pending: PreparedPerson[] }
