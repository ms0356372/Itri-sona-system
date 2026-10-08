import type {PreparedPerson} from './types';

/** Compare schedule content, excluding local IDs, validation flags and read order. */
export function preparedScheduleSignature(rows:PreparedPerson[]):string {
  const content=rows.map(row=>JSON.stringify({
    sequence:row.sequence,
    employeeNo:row.employeeNo,
    name:row.name,
    gender:row.gender,
    scheduleDate:row.scheduleDate,
    slot:row.slot,
    item:row.item,
    extension:row.extension,
    nationalId:row.nationalId,
    originalActivity:row.originalActivity,
    dailyActivity:row.dailyActivity,
  }));
  return JSON.stringify(content.sort());
}
