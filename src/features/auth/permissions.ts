import {requireSupabase} from '../../lib/supabase';
import type {StaffPermissions} from '../../types';

export type WorkPage='registration'|'console'|'room';

const pageOrder:WorkPage[]=['registration','console','room'];
const pagePermission:Record<WorkPage,'canRegistration'|'canConsole'|'canRoom'>={
  registration:'canRegistration',console:'canConsole',room:'canRoom',
};

export async function getStaffPermissions(userId:string):Promise<StaffPermissions|null>{
  if(!userId)return null;
  // Query only the signed-in account. RLS independently enforces auth.uid().
  const {data,error}=await requireSupabase().from('staff_permissions')
    .select('user_id,login_email,display_name,can_registration,can_console,can_room,is_active')
    .eq('user_id',userId).maybeSingle();
  if(error)throw error;
  if(!data||data.user_id!==userId)return null;
  return{
    userId:data.user_id,
    loginEmail:typeof data.login_email==='string'?data.login_email:null,
    displayName:typeof data.display_name==='string'?data.display_name:'',
    canRegistration:data.can_registration===true,
    canConsole:data.can_console===true,
    canRoom:data.can_room===true,
    isActive:data.is_active===true,
  };
}

export function canUsePage(permissions:StaffPermissions|null|undefined,page:WorkPage):boolean{
  return permissions?.isActive===true&&permissions[pagePermission[page]]===true;
}

export function getAllowedPages(permissions:StaffPermissions|null|undefined):WorkPage[]{
  return pageOrder.filter(page=>canUsePage(permissions,page));
}

export function firstAllowedPage(permissions:StaffPermissions|null|undefined):WorkPage|null{
  return getAllowedPages(permissions)[0]??null;
}

export function permissionAccessMessage(permissions:StaffPermissions|null|undefined):string{
  if(!permissions)return '此帳號尚未設定系統權限，請洽管理員。';
  if(!permissions.isActive)return '此帳號目前已停用，請洽管理員。';
  if(!getAllowedPages(permissions).length)return '此帳號目前沒有可使用的工作頁面，請洽管理員。';
  return '';
}
