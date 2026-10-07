import {normalizeCompanyName} from '../../lib/company';
import {formatError} from '../../lib/errors';
import {normalizeNationalId} from '../../lib/privacy';
import type {Participant,Session} from '../../types';
import {addPreparedPerson} from '../roster/db';
import type {MasterPerson,PreparedPerson} from '../roster/types';
import {groupForSlot,normalizeSlot} from '../schedule/rules';
import {assertPreparedParticipantIdentity,findParticipant,preparedCloudRow,upsertPreparedParticipant} from '../schedule/service';
import {isAlreadyCheckedIn} from './lookup';
import {SupabaseCheckinService} from './service';
import {manualIdentityError} from './manual';

const errorDetail=(error:unknown)=>formatError(error).normalize('NFKC').replace(/[A-Z][\s-]*(?:[1289](?:[\s-]*\d){8}|[A-D](?:[\s-]*\d){8})/gi,'[身分證已隱藏]');

/** Carries the exact local row so the modal can freeze a safe retry immediately. */
export class WalkInRegistrationError extends Error {
  readonly retained:PreparedPerson;
  constructor(message:string,retained:PreparedPerson){
    super(message);
    this.name='WalkInRegistrationError';
    this.retained=retained;
  }
}

function validateWalkin(session:Session,person:PreparedPerson):PreparedPerson{
  if(!session.id||!normalizeCompanyName(session.companyName)||session.status!=='active')throw new Error('請先選擇可報到的有效場次。');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(session.sessionDate)||Number.isNaN(Date.parse(session.sessionDate))||new Date(session.sessionDate).toISOString().slice(0,10)!==session.sessionDate)throw new Error('目前場次日期不正確，請重新選擇場次。');
  if(person.scheduleDate!==session.sessionDate)throw new Error('排程日期必須使用目前場次日期。');
  const prepared:PreparedPerson={...person,localId:person.localId||crypto.randomUUID(),nationalId:normalizeNationalId(person.nationalId),employeeNo:person.employeeNo.trim(),name:person.name.trim(),gender:person.gender.trim(),item:person.item.trim(),extension:person.extension.trim(),slot:normalizeSlot(person.slot),issues:[],confirmed:true};
  const identityError=manualIdentityError(prepared);
  if(identityError)throw new Error(identityError);
  if(!prepared.item)throw new Error('請確認檢查項目。');
  if(!groupForSlot(prepared.slot))throw new Error('請選擇有效的排程時段。');
  // Validate privacy before committing any local or remote changes.
  preparedCloudRow(session.id,prepared,0);
  return prepared;
}

/** Local writes and cloud insertion are retained on failure for a deliberate, safe retry. */
export async function registerAndCheckIn(session:Session,person:PreparedPerson,addToMaster:boolean):Promise<Participant>{
  const prepared=validateWalkin(session,person);
  const master:MasterPerson|undefined=addToMaster?{
    companyName:session.companyName,companyKey:normalizeCompanyName(session.companyName),employeeNo:prepared.employeeNo,name:prepared.name,nationalId:prepared.nationalId,gender:prepared.gender,originalActivity:prepared.originalActivity.trim()||prepared.item,item:prepared.item,extension:prepared.extension,updatedAt:new Date().toISOString(),
  }:undefined;
  let stored:PreparedPerson;
  try{stored=await addPreparedPerson(session.id,prepared,master);}
  catch(error){throw new Error(`本機排程新增失敗：${errorDetail(error)}`);}
  let participant:Participant;
  try{participant=await upsertPreparedParticipant(session.id,stored);}
  catch(error){throw new WalkInRegistrationError(`本機排程已保留，但雲端新增未完成，尚未執行報到。請確認後重試：${errorDetail(error)}`,stored);}
  if(!isAlreadyCheckedIn(participant)){
    try{await new SupabaseCheckinService().checkIn(participant.id);}
    catch(error){throw new WalkInRegistrationError(`今日排程已保留，但尚無法確認報到結果。請重試，系統會沿用既有報到編號：${errorDetail(error)}`,stored);}
  }
  try{
    const latest=await findParticipant(session.id,stored.employeeNo);
    if(!latest||latest.id!==participant.id||!isAlreadyCheckedIn(latest))throw new Error('尚無法取得已報到的最新受檢者資料。');
    return assertPreparedParticipantIdentity(latest,session.id,stored);
  }catch(error){
    // Never roll back a committed RPC or manufacture a success from its response.
    throw new WalkInRegistrationError(`尚無法確認最新報到資料；今日排程已保留，請重試，系統會沿用既有編號與狀態：${errorDetail(error)}`,stored);
  }
}
