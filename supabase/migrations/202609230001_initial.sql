-- Initial production schema. This migration intentionally contains no secrets.
-- Access model: every Supabase Auth user is a trusted staff member. Anonymous
-- clients cannot read or mutate operational or identity data.

create extension if not exists pgcrypto;

create type public.session_status as enum ('active', 'closing', 'closed');
create type public.work_status as enum (
  '未報到',
  '等候中',
  '已叫號',
  '上廁所',
  '心電圖',
  '先做其他',
  '檢查中',
  '已完成'
);
create type public.examination_status as enum ('in_progress', 'completed');

create table public.health_sessions (
  id uuid primary key default gen_random_uuid(),
  session_date date not null,
  company_name text not null check (length(trim(company_name)) > 0),
  status public.session_status not null default 'active',
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  unique (session_date, company_name)
);

create table public.participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.health_sessions (id) on delete cascade,
  sequence_no integer not null check (sequence_no > 0),
  national_id text not null check (length(trim(national_id)) > 0),
  employee_no text not null check (length(trim(employee_no)) > 0),
  full_name text not null check (length(trim(full_name)) > 0),
  gender text not null default '',
  schedule_slot text not null,
  group_code text not null check (group_code in ('A', 'B', 'C', 'D', 'E', 'F', 'G')),
  planned_items text[] not null default '{}',
  checkin_sequence integer,
  checkin_no text,
  checked_in_at timestamptz,
  called_at timestamptz,
  note text not null default '',
  status public.work_status not null default '未報到',
  updated_at timestamptz not null default now(),
  unique (session_id, employee_no),
  unique (session_id, checkin_no),
  unique (session_id, group_code, checkin_sequence)
);

create index participants_session_national_idx
  on public.participants (session_id, national_id);

create table public.group_counters (
  session_id uuid references public.health_sessions (id) on delete cascade,
  group_code text check (group_code in ('A', 'B', 'C', 'D', 'E', 'F', 'G')),
  last_value integer not null default 0 check (last_value >= 0),
  primary key (session_id, group_code)
);

create table public.ultrasound_items (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(trim(name)) > 0),
  active boolean not null default true,
  sort_order integer not null default 0
);

insert into public.ultrasound_items (name, sort_order)
values
  ('腹部超音波', 10),
  ('甲狀腺超音波', 20),
  ('頸動脈超音波', 30),
  ('乳房超音波', 40),
  ('其他超音波', 50);

create table public.examinations (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null unique references public.participants (id) on delete cascade,
  room_id text not null check (length(trim(room_id)) > 0),
  started_at timestamptz not null,
  completed_at timestamptz,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  actual_items text[] not null default '{}',
  item_count integer not null default 0 check (item_count >= 0),
  status public.examination_status not null default 'in_progress',
  updated_at timestamptz not null default now(),
  check (
    (status = 'in_progress' and completed_at is null and duration_seconds is null)
    or (status = 'completed' and completed_at is not null and duration_seconds is not null)
  )
);

create table public.registered_devices (
  id text primary key check (length(trim(id)) > 0),
  display_name text not null check (length(trim(display_name)) > 0),
  owner_id uuid not null references auth.users (id),
  revoked_at timestamptz,
  last_seen_at timestamptz not null default now()
);

create table public.clearance_requests (
  session_id uuid references public.health_sessions (id) on delete cascade,
  device_id text references public.registered_devices (id) on delete cascade,
  requested_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  primary key (session_id, device_id)
);

create or replace function public.can_access_session(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.health_sessions as sessions
      where sessions.id = p_session_id
    );
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger participants_touch
before update on public.participants
for each row execute function public.touch_updated_at();

create trigger examinations_touch
before update on public.examinations
for each row execute function public.touch_updated_at();

-- The counter row is locked by the upsert, so concurrent devices cannot receive
-- the same group number. Repeated check-in returns the original number.
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
  select *
  into participant
  from public.participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'participant_not_found';
  end if;
  if not public.can_access_session(participant.session_id) then
    raise exception 'not_authorized';
  end if;
  if participant.checkin_no is not null then
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

create or replace function public.set_waiting_status(
  p_participant_id uuid,
  p_status public.work_status
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_id uuid;
begin
  if p_status not in ('等候中', '上廁所', '心電圖', '先做其他') then
    raise exception 'invalid_transition';
  end if;

  select participants.session_id
  into session_id
  from public.participants
  where id = p_participant_id
    and status not in ('未報到', '檢查中', '已完成')
  for update;

  if not found then
    raise exception 'invalid_state';
  end if;
  if not public.can_access_session(session_id) then
    raise exception 'not_authorized';
  end if;

  update public.participants set status = p_status where id = p_participant_id;
end;
$$;

create or replace function public.call_participant(p_participant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_id uuid;
begin
  select participants.session_id
  into session_id
  from public.participants
  where id = p_participant_id and status = '等候中'
  for update;

  if not found then
    raise exception 'invalid_state';
  end if;
  if not public.can_access_session(session_id) then
    raise exception 'not_authorized';
  end if;

  update public.participants
  set status = '已叫號', called_at = now()
  where id = p_participant_id;
end;
$$;

create or replace function public.start_examination(
  p_participant_id uuid,
  p_room_id text,
  p_started_at timestamptz default now()
)
returns public.examinations
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_id uuid;
  examination public.examinations;
begin
  if length(trim(p_room_id)) = 0 then
    raise exception 'invalid_room';
  end if;

  select participants.session_id
  into session_id
  from public.participants
  where id = p_participant_id and status in ('等候中', '已叫號')
  for update;

  if not found then
    raise exception 'not_checked_in';
  end if;
  if not public.can_access_session(session_id) then
    raise exception 'not_authorized';
  end if;

  insert into public.examinations (participant_id, room_id, started_at)
  values (p_participant_id, p_room_id, p_started_at)
  on conflict (participant_id) do update
    set room_id = excluded.room_id
  where public.examinations.status = 'in_progress'
  returning * into examination;

  if examination.id is null then
    raise exception 'examination_already_completed';
  end if;

  update public.participants set status = '檢查中' where id = p_participant_id;
  return examination;
end;
$$;

-- The participant and examination rows are locked before completion, making a
-- repeated completion call idempotent.
create or replace function public.complete_examination(
  p_participant_id uuid,
  p_room_id text,
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_actual_items text[]
)
returns public.examinations
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_id uuid;
  examination public.examinations;
begin
  if length(trim(p_room_id)) = 0
     or p_completed_at < p_started_at
     or p_actual_items is null then
    raise exception 'invalid_examination';
  end if;

  select participants.session_id
  into session_id
  from public.participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'participant_not_found';
  end if;
  if not public.can_access_session(session_id) then
    raise exception 'not_authorized';
  end if;

  select *
  into examination
  from public.examinations
  where participant_id = p_participant_id
  for update;

  if not found then
    raise exception 'examination_not_started';
  end if;
  if examination.status = 'completed' then
    return examination;
  end if;

  update public.examinations
  set room_id = p_room_id,
      started_at = p_started_at,
      completed_at = p_completed_at,
      duration_seconds = extract(epoch from (p_completed_at - p_started_at))::integer,
      actual_items = p_actual_items,
      item_count = cardinality(p_actual_items),
      status = 'completed'
  where participant_id = p_participant_id
  returning * into examination;

  update public.participants set status = '已完成' where id = p_participant_id;
  return examination;
end;
$$;

create or replace function public.acknowledge_device_clear(
  p_session_id uuid,
  p_device_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.can_access_session(p_session_id) then
    raise exception 'not_authorized';
  end if;

  update public.clearance_requests
  set acknowledged_at = now()
  where session_id = p_session_id and device_id = p_device_id;

  if not found then
    raise exception 'clearance_request_not_found';
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
  update public.health_sessions set status = 'closed' where id = p_session_id;
  return jsonb_build_object('cloud_deleted', true, 'pending_devices', 0);
end;
$$;

alter table public.health_sessions enable row level security;
alter table public.participants enable row level security;
alter table public.group_counters enable row level security;
alter table public.examinations enable row level security;
alter table public.ultrasound_items enable row level security;
alter table public.registered_devices enable row level security;
alter table public.clearance_requests enable row level security;

-- Supabase Auth is the staff authorization boundary. Policies are explicitly
-- scoped to authenticated, so the anon role cannot read today's schedule or IDs.
create policy staff_all_health_sessions
on public.health_sessions for all to authenticated
using (true) with check (true);

create policy staff_all_participants
on public.participants for all to authenticated
using (public.can_access_session(session_id))
with check (public.can_access_session(session_id));

create policy staff_all_examinations
on public.examinations for all to authenticated
using (
  exists (
    select 1
    from public.participants
    where participants.id = examinations.participant_id
      and public.can_access_session(participants.session_id)
  )
)
with check (
  exists (
    select 1
    from public.participants
    where participants.id = examinations.participant_id
      and public.can_access_session(participants.session_id)
  )
);

create policy staff_all_ultrasound_items
on public.ultrasound_items for all to authenticated
using (true) with check (true);

create policy staff_all_registered_devices
on public.registered_devices for all to authenticated
using (true) with check (true);

create policy staff_all_clearance_requests
on public.clearance_requests for all to authenticated
using (public.can_access_session(session_id))
with check (public.can_access_session(session_id));

-- group_counters is intentionally RPC-only; no client policy is defined.

revoke all on all tables in schema public from public, anon;
revoke all on function public.can_access_session(uuid),
  public.touch_updated_at(),
  public.check_in_participant(uuid),
  public.set_waiting_status(uuid, public.work_status),
  public.call_participant(uuid),
  public.start_examination(uuid, text, timestamptz),
  public.complete_examination(uuid, text, timestamptz, timestamptz, text[]),
  public.acknowledge_device_clear(uuid, text),
  public.close_health_session(uuid) from public, anon;

grant usage on schema public to authenticated;
grant usage on type public.session_status,
  public.work_status,
  public.examination_status to authenticated;
grant select, insert, update, delete on public.health_sessions,
  public.participants,
  public.examinations,
  public.ultrasound_items,
  public.registered_devices,
  public.clearance_requests to authenticated;

grant execute on function public.check_in_participant(uuid),
  public.can_access_session(uuid),
  public.set_waiting_status(uuid, public.work_status),
  public.call_participant(uuid),
  public.start_examination(uuid, text, timestamptz),
  public.complete_examination(uuid, text, timestamptz, timestamptz, text[]),
  public.acknowledge_device_clear(uuid, text),
  public.close_health_session(uuid) to authenticated;

alter publication supabase_realtime
  add table public.participants, public.examinations, public.clearance_requests;
