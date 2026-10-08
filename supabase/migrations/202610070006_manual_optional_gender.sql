-- Manual registration may leave gender blank. Its existing normalization
-- already converts NULL/whitespace to ''. Only the nonempty-gender guard is
-- removed; signature, identity checks, counter, timestamps and ACL stay intact.
-- CREATE OR REPLACE preserves the deployed function's ownership and grants.
create or replace function public.simple_check_in_participant(
  p_session_id uuid,
  p_employee_no text,
  p_full_name text,
  p_gender text,
  p_item text,
  p_extension text default ''
)
returns public.participants
language plpgsql security definer set search_path = '' as $$
declare
  session public.health_sessions;
  participant public.participants;
  ticket_number integer;
  employee_value text := trim(coalesce(p_employee_no, ''));
  name_value text := trim(coalesce(p_full_name, ''));
  gender_value text := trim(coalesce(p_gender, ''));
  item_value text := trim(coalesce(p_item, ''));
  extension_value text := trim(coalesce(p_extension, ''));
  checked_at timestamptz;
begin
  if not public.can_use_registration() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if employee_value = '' or name_value = '' or item_value = '' then
    raise exception 'invalid_simple_participant';
  end if;

  select * into session from public.health_sessions
  where id = p_session_id for share;
  if not found then raise exception 'session_not_found'; end if;
  if session.workflow_mode <> 'simple' then
    raise exception 'invalid_workflow_mode';
  end if;
  if session.status <> 'active' then raise exception 'session_not_active'; end if;

  -- Normally this creates an empty session's counter at 1. max() also safely
  -- recovers a missing counter without reissuing an existing ticket.
  insert into public.simple_queue_counters(session_id, next_number)
  select p_session_id, coalesce(max(participants.queue_number), 0) + 1
  from public.participants where participants.session_id = p_session_id
  on conflict (session_id) do nothing;
  select next_number into ticket_number
  from public.simple_queue_counters where session_id = p_session_id for update;

  select * into participant from public.participants
  where participants.session_id = p_session_id
    and participants.employee_no = employee_value
  for update;
  if found then
    if participant.full_name is distinct from name_value
        or participant.gender is distinct from gender_value then
      raise exception 'simple_identity_conflict';
    end if;
    return participant;
  end if;

  update public.simple_queue_counters set next_number = ticket_number + 1
  where session_id = p_session_id;
  checked_at := clock_timestamp();
  insert into public.participants (
    session_id, sequence_no, employee_no, full_name, gender,
    schedule_slot, group_code, planned_items, checkin_sequence, checkin_no,
    checked_in_at, note, status, updated_at, queue_number
  ) values (
    p_session_id, ticket_number, employee_value, name_value, gender_value,
    null, null, array[item_value], null, ticket_number::text,
    checked_at, case when extension_value = '' then '' else '院內分機：' || extension_value end,
    '等候中', checked_at, ticket_number
  ) returning * into participant;
  return participant;
end;
$$;
