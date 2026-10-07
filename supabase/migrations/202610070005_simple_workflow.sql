-- Standard sessions retain their existing schedule, group counters, and ticket
-- numbers. Only people who actually check in are uploaded for a simple session.
alter table public.health_sessions
  add column if not exists workflow_mode text not null default 'standard';
alter table public.health_sessions
  drop constraint if exists health_sessions_workflow_mode_check;
alter table public.health_sessions
  add constraint health_sessions_workflow_mode_check
  check (workflow_mode in ('standard', 'simple'));

-- Adding a defaulted column does not update any existing participant data.
-- Simple tickets have no group, time slot, or per-group check-in sequence.
alter table public.participants
  alter column group_code drop not null,
  alter column schedule_slot drop not null,
  add column if not exists queue_number integer;
alter table public.participants
  drop constraint if exists participants_queue_number_check;
alter table public.participants
  add constraint participants_queue_number_check
  check (queue_number is null or queue_number > 0);
create unique index if not exists participants_session_queue_number_idx
  on public.participants(session_id, queue_number);

-- next_number is the NEXT ticket, not the most recently issued ticket. The
-- session FK also makes deletion use the existing cascading cleanup workflow.
create table if not exists public.simple_queue_counters (
  session_id uuid primary key references public.health_sessions(id) on delete cascade,
  next_number integer not null default 1 check (next_number > 0)
);
alter table public.simple_queue_counters enable row level security;
revoke all on public.simple_queue_counters from public, anon, authenticated;
grant all on public.simple_queue_counters to service_role;

-- The first version deliberately fixes the mode at creation, including for an
-- empty session. Browser UPDATE grants do not include workflow_mode either.
create or replace function public.guard_session_workflow_mode()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.workflow_mode is distinct from old.workflow_mode then
    raise exception 'workflow_mode_immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists health_sessions_guard_workflow_mode on public.health_sessions;
create trigger health_sessions_guard_workflow_mode
before update of workflow_mode on public.health_sessions
for each row execute function public.guard_session_workflow_mode();

-- Cross-table validation keeps the two numbering models distinct. Existing
-- standard rows are never rewritten or revalidated for an unrelated status
-- update: historic slot formats continue to use the existing workflow.
create or replace function public.guard_participant_workflow()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  mode text;
  validate_standard_schedule boolean;
begin
  select workflow_mode into mode
  from public.health_sessions where id = new.session_id;
  if not found then
    raise exception 'session_not_found';
  end if;

  if mode = 'standard' then
    if new.queue_number is not null then
      raise exception 'invalid_standard_participant';
    end if;
    validate_standard_schedule := tg_op = 'INSERT';
    if tg_op = 'UPDATE' then
      validate_standard_schedule := new.session_id is distinct from old.session_id
        or new.group_code is distinct from old.group_code
        or new.schedule_slot is distinct from old.schedule_slot;
    end if;
    if validate_standard_schedule and (
        new.group_code is null
        or new.group_code not in ('A', 'B', 'C', 'D', 'E', 'F', 'G')
        or new.schedule_slot is null or length(trim(new.schedule_slot)) = 0
    ) then
      raise exception 'invalid_standard_participant';
    end if;
  elsif mode = 'simple' then
    if new.queue_number is null or new.queue_number <= 0
        or new.sequence_no is distinct from new.queue_number
        or new.checkin_no is distinct from new.queue_number::text
        or new.group_code is not null or new.schedule_slot is not null
        or new.checkin_sequence is not null or new.checked_in_at is null
        or new.status = '未報到' then
      raise exception 'invalid_simple_participant';
    end if;
    if tg_op = 'INSERT' then
      if new.status <> '等候中' then
        raise exception 'invalid_simple_participant';
      end if;
    elsif new.session_id is distinct from old.session_id
        or new.queue_number is distinct from old.queue_number
        or new.sequence_no is distinct from old.sequence_no
        or new.checkin_no is distinct from old.checkin_no
        or new.checked_in_at is distinct from old.checked_in_at then
      raise exception 'invalid_simple_participant';
    end if;
  else
    raise exception 'invalid_workflow_mode';
  end if;
  return new;
end;
$$;
drop trigger if exists participants_guard_workflow on public.participants;
create trigger participants_guard_workflow
before insert or update on public.participants
for each row execute function public.guard_participant_workflow();

-- The existing INSERT RLS still requires an active registration account and
-- created_by = auth.uid(). Operational ticket/status columns stay RPC-only.
grant insert (workflow_mode) on public.health_sessions to authenticated;
revoke insert (queue_number), update (queue_number)
  on public.participants from public, anon, authenticated;

-- The session SHARE lock coordinates with clear/close/delete and mode is
-- immutable. A counter lock serializes every arrival in this session, including
-- concurrent requests for the same employee. The duplicate check happens after
-- obtaining the mutex, so a retry returns the committed original participant.
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
  if employee_value = '' or name_value = '' or gender_value = '' or item_value = '' then
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

-- Standard check-in is the deployed implementation with only a mode guard.
-- In particular, its lock order, per-group counter, idempotence, server time,
-- and status transition remain unchanged.
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
  if not public.can_use_registration() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  select * into participant
  from public.participants
  where id = p_participant_id
  for update;

  if not found then raise exception 'participant_not_found'; end if;
  if not public.can_access_session(participant.session_id) then raise exception 'not_authorized'; end if;
  if (select workflow_mode from public.health_sessions where id = participant.session_id) <> 'standard' then
    raise exception 'invalid_workflow_mode';
  end if;

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

-- Preserve standard cleanup exactly. For simple sessions, also discard room
-- leases and the queue counter. The next arrival starts again at ticket 1, and
-- the existing claim RPC lazily recreates the enabled room rows when needed.
create or replace function public.clear_session_schedule(p_session_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.can_use_registration() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if auth.uid() is null or not public.can_access_session(p_session_id) then raise exception 'not_authorized'; end if;
  perform 1 from public.health_sessions where id = p_session_id for update;
  if not found then raise exception 'session_not_found'; end if;
  delete from public.participants where session_id = p_session_id;
  delete from public.group_counters where session_id = p_session_id;
  delete from public.clearance_requests where session_id = p_session_id;
  if (select workflow_mode from public.health_sessions where id = p_session_id) = 'simple' then
    delete from public.simple_queue_counters where session_id = p_session_id;
    delete from public.rooms where session_id = p_session_id;
  end if;
end;
$$;

create or replace function public.close_health_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pending integer;
begin
  if not public.can_use_registration() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if not public.can_access_session(p_session_id) then
    raise exception 'not_authorized';
  end if;

  update public.health_sessions set status = 'closing' where id = p_session_id;

  select count(*)
  into pending
  from public.clearance_requests
  where session_id = p_session_id and acknowledged_at is null;

  if pending > 0 then
    return jsonb_build_object('cloud_deleted', false, 'pending_devices', pending);
  end if;

  delete from public.participants where session_id = p_session_id;
  if (select workflow_mode from public.health_sessions where id = p_session_id) = 'simple' then
    delete from public.simple_queue_counters where session_id = p_session_id;
    delete from public.rooms where session_id = p_session_id;
    delete from public.group_counters where session_id = p_session_id;
    delete from public.clearance_requests where session_id = p_session_id;
  end if;
  update public.health_sessions set status = 'closed' where id = p_session_id;
  return jsonb_build_object('cloud_deleted', true, 'pending_devices', 0);
end;
$$;

revoke all on function
  public.guard_session_workflow_mode(),
  public.guard_participant_workflow()
from public, anon, authenticated;
revoke all on function
  public.simple_check_in_participant(uuid, text, text, text, text, text),
  public.check_in_participant(uuid),
  public.clear_session_schedule(uuid),
  public.close_health_session(uuid)
from public, anon, authenticated;
grant execute on function
  public.simple_check_in_participant(uuid, text, text, text, text, text),
  public.check_in_participant(uuid),
  public.clear_session_schedule(uuid),
  public.close_health_session(uuid)
to authenticated;

-- Existing health_sessions/participants/examinations/rooms Realtime publication
-- and SELECT RLS automatically cover their new fields. The private counter has
-- no browser policy or publication and introduces no extra polling/channel.
