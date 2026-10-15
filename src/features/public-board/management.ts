import {requireSupabase} from '../../lib/supabase';

export interface PublicBoardSettingsData {enabled:boolean;token:string|null}

function readSettings(value:unknown):PublicBoardSettingsData{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('公開看板設定格式不正確，請重新讀取。');
  const row=value as Record<string,unknown>;
  const tokenValid=typeof row.token==='string'&&/^[a-f0-9]{64}$/.test(row.token);
  if(typeof row.enabled!=='boolean'||(row.token!==null&&!tokenValid)||(row.enabled&&!tokenValid))throw new Error('公開看板設定格式不正確，請重新讀取。');
  return{enabled:row.enabled,token:row.enabled?row.token as string:null};
}

/** These authenticated RPCs keep public tokens out of normal session queries. */
export async function getPublicBoardSettings(sessionId:string):Promise<PublicBoardSettingsData>{
  const{data,error}=await requireSupabase().rpc('get_public_board_settings',{p_session_id:sessionId});
  if(error)throw error;
  return readSettings(data);
}

export async function setPublicBoardEnabled(sessionId:string,enabled:boolean):Promise<PublicBoardSettingsData>{
  const{data,error}=await requireSupabase().rpc('set_public_board_enabled',{p_session_id:sessionId,p_enabled:enabled});
  if(error)throw error;
  const settings=readSettings(data);
  if(settings.enabled!==enabled)throw new Error('公開看板設定未更新，請重新讀取。');
  return settings;
}
