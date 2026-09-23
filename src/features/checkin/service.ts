import {requireSupabase} from '../../lib/supabase';
export interface CheckinPort {checkIn(participantId:string):Promise<{checkin_no:string;status:string}>}
export class SupabaseCheckinService implements CheckinPort {async checkIn(participantId:string){const {data,error}=await requireSupabase().rpc('check_in_participant',{p_participant_id:participantId}).single();if(error)throw error;return data as {checkin_no:string;status:string};}}
