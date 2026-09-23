import type {GroupCode} from '../../types';
export const SLOT_GROUP:Record<string,GroupCode>={'07:30~08:00':'A','08:00~08:30':'B','08:30~09:00':'C','09:00~09:30':'D','09:30~10:00':'E','10:00~10:30':'F','10:30~11:00':'G'};
export const normalizeSlot=(v:unknown)=>String(v??'').trim().replace(/[～〜－—–-]/g,'~').replace(/\s/g,'');
export const groupForSlot=(v:unknown)=>SLOT_GROUP[normalizeSlot(v)]??null;
