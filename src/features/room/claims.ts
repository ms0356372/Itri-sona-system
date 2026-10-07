import {requireSupabase} from '../../lib/supabase';
import {formatError} from '../../lib/errors';
import {getDeviceIdentity} from './device';
import {normalizeRoomId} from './status';

export type RoomClaim={
  sessionId:string;roomId:string;isMine:boolean;isClaimed:boolean;
  claimedAt:string|null;claimExpiresAt:string|null;serverNow:string;
};
type ClaimRow={session_id?:unknown;room_id?:unknown;is_mine?:unknown;is_claimed?:unknown;claimed_at?:unknown;claim_expires_at?:unknown;server_now?:unknown};

function mapClaim(value:unknown,sessionId:string):RoomClaim{
  const row=value as ClaimRow|null;
  if(!row||row.session_id!==sessionId||typeof row.room_id!=='string'||typeof row.is_mine!=='boolean'||typeof row.is_claimed!=='boolean'||typeof row.server_now!=='string'||!Number.isFinite(Date.parse(row.server_now)))throw new Error('invalid_room_claim');
  const claimedAt=typeof row.claimed_at==='string'?row.claimed_at:null;
  const claimExpiresAt=typeof row.claim_expires_at==='string'?row.claim_expires_at:null;
  if(row.is_mine&&!row.is_claimed||row.is_claimed&&(!claimedAt||!claimExpiresAt||!Number.isFinite(Date.parse(claimedAt))||!Number.isFinite(Date.parse(claimExpiresAt))))throw new Error('invalid_room_claim');
  return{sessionId,roomId:normalizeRoomId(row.room_id),isMine:row.is_mine,isClaimed:row.is_claimed,claimedAt,claimExpiresAt,serverNow:row.server_now};
}

function credentials(){
  const {deviceId,claimSecret}=getDeviceIdentity();
  return{p_device_id:deviceId,p_device_secret:claimSecret};
}

export async function getRoomClaims(sessionId:string):Promise<RoomClaim[]>{
  const {data,error}=await requireSupabase().rpc('list_room_claims',{p_session_id:sessionId,...credentials()});
  if(error)throw error;
  if(!Array.isArray(data))throw new Error('invalid_room_claim');
  return data.map(row=>mapClaim(row,sessionId));
}

async function mutate(name:string,sessionId:string,parameters:Record<string,string>):Promise<RoomClaim>{
  const {data,error}=await requireSupabase().rpc(name,{p_session_id:sessionId,...parameters,...credentials()});
  if(error)throw error;
  return mapClaim(data,sessionId);
}
export const claimRoom=(sessionId:string,roomId:string)=>mutate('claim_room',sessionId,{p_room_id:normalizeRoomId(roomId)});
export const switchRoomClaim=(sessionId:string,fromRoomId:string,toRoomId:string)=>mutate('switch_room_claim',sessionId,{p_from_room_id:normalizeRoomId(fromRoomId),p_to_room_id:normalizeRoomId(toRoomId)});
export const heartbeatRoomClaim=(sessionId:string,roomId:string)=>mutate('heartbeat_room_claim',sessionId,{p_room_id:normalizeRoomId(roomId)});
export const releaseRoomClaim=(sessionId:string,roomId:string,expectedClaimedAt?:string|null)=>mutate('release_room_claim',sessionId,{
  p_room_id:normalizeRoomId(roomId),...(expectedClaimedAt?{p_expected_claimed_at:expectedClaimedAt}:{}),
});

export function formatRoomClaimError(error:unknown):string{
  const message=formatError(error);
  if(message==='此帳號沒有執行此功能的權限。')return '此帳號沒有使用超音波診間的權限。';
  if(message.includes('room_claim_lost'))return '本機已失去此診間的使用權，請重新選擇診間。';
  if(message.includes('room_claim_in_progress'))return '此診間正在檢查中，請先完成檢查後再切換或釋放診間。';
  if(message.includes('room_claim_switch_required'))return '此裝置已占用其他診間，請使用診間選擇器切換。';
  const blocked=message.match(/room_count_claimed:\s*([^\n]+)/);
  if(blocked)return `無法減少診間數量：${normalizeRoomId(blocked[1]).replace(' ','')}目前由裝置使用中。`;
  if(message.includes('room_claimed'))return '此診間目前正在其他設備使用中。';
  if(message.includes('invalid_device'))return '無法確認此裝置的診間使用權，請重新開啟系統。';
  if(message.includes('invalid_room'))return '此場次沒有這個診間。';
  if(message.includes('session_not_found'))return '找不到此場次，請重新選擇場次。';
  if(message.includes('session_read_only'))return '此場次目前為唯讀，無法使用超音波診間。';
  if(/heartbeat_failed|failed to fetch|network|timeout/i.test(message))return '診間連線暫時異常，系統將自動重試。';
  return message;
}

export function isRoomClaimDenied(error:unknown):boolean{
  const message=formatError(error);
  return message==='此帳號沒有執行此功能的權限。'||/room_claim_lost|invalid_device|invalid_room|session_not_found|session_read_only/.test(message);
}
