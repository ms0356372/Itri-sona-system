import {createClient} from '@supabase/supabase-js';
const url=import.meta.env.VITE_SUPABASE_URL as string|undefined; const key=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string|undefined;
export const isSupabaseConfigured=Boolean(url&&key);
export const supabase=isSupabaseConfigured?createClient(url!,key!,{auth:{persistSession:true,autoRefreshToken:true}}):null;
export function requireSupabase(){if(!supabase) throw new Error('尚未設定 Supabase 環境變數'); return supabase;}
