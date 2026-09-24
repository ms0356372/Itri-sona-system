-- Treat either persisted check-in field as evidence of an earlier check-in.
-- This protects legacy/inconsistent rows from receiving a new sequence or
-- having their workflow status and timestamps reset by a repeated RPC call.
create or replace function public.check_in_participant(p_participant_id uuid)
returns public.participants
language plpgsql
security definer
set search_path = ''
as $$
declare
  participant public.participants;
  next_number integer;
begin
  select * into participant
  from public.participants
  where id = p_participant_id
  for update;

  if not found then raise exception 'participant_not_found'; end if;
  if not public.can_access_session(participant.session_id) then raise exception 'not_authorized'; end if;

  if participant.checkin_no is not null or participant.checked_in_at is not null then
    return participant;
  end if;

  insert into public.group_counters (session_id, group_code, last_value)
  values (participant.session_id, participant.group_code, 1)
  on conflict (session_id, group_code) do update
    set last_value = public.group_counters.last_value + 1
  returning last_value into next_number;

  update public.participants
  set checkin_sequence = next_number,
      checkin_no = participant.group_code || next_number,
      checked_in_at = now(),
      status = '等候中'
  where id = participant.id
  returning * into participant;

  return participant;
end;
$$;
