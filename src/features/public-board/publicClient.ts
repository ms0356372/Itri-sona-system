import {createClient,type SupabaseClient} from '@supabase/supabase-js';

let client:SupabaseClient|null=null;

/** Public requests never load or refresh the workstation's stored Auth session. */
export function getPublicBoardClient():SupabaseClient{
  if(client)return client;
  const url=import.meta.env.VITE_SUPABASE_URL as string|undefined;
  const key=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string|undefined;
  if(!url||!key)throw new Error('public_board_unavailable');
  client=createClient(url,key,{auth:{storageKey:'itri-public-board-anonymous',persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  return client;
}
