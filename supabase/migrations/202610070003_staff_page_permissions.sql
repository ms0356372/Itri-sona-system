-- Independent staff page permissions replace authenticated = trusted staff.
-- Browser clients never receive privileged keys or permission management access.
create table if not exists public.staff_permissions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  login_email text,
  display_name text not null default '',
  can_registration boolean not null default false,
  can_console boolean not null default false,
  can_room boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.is_active_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff_permissions
    where user_id = auth.uid() and is_active
  );
$$;

create or replace function public.can_use_registration()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff_permissions
    where user_id = auth.uid() and is_active and can_registration
  );
$$;

create or replace function public.can_use_console()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff_permissions
    where user_id = auth.uid() and is_active and can_console
  );
$$;

create or replace function public.can_use_room()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff_permissions
    where user_id = auth.uid() and is_active and can_room
  );
$$;

-- This helper permits shared reads, never a particular mutation. Every exposed
-- mutation RPC below separately checks its own page permission first.
create or replace function public.can_access_session(p_session_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select (public.can_use_registration() or public.can_use_console() or public.can_use_room())
    and exists (select 1 from public.health_sessions where id = p_session_id);
$$;

-- Read only actual Auth columns: untrusted user metadata cannot grant access.
-- An email edit updates only the label, preserving every permission and flag.
create or replace function public.sync_staff_permissions_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.staff_permissions (
      user_id, login_email, can_registration, can_console, can_room, is_active
    ) values (new.id, new.email, false, false, false, true)
    on conflict (user_id) do nothing;
  elsif new.email is distinct from old.email then
    update public.staff_permissions set login_email = new.email where user_id = new.id;
  end if;
  return new;
end;
$$;

-- Lock account creation for the trigger/backfill transaction, so a concurrently
-- added account cannot be mistaken for a pre-migration account. This DO block
-- is atomic even in tools which execute SQL statements without an outer BEGIN.
do $$ begin
  lock table auth.users in share row exclusive mode;
  drop trigger if exists auth_users_create_staff_permissions on auth.users;
  create trigger auth_users_create_staff_permissions
    after insert on auth.users
    for each row execute function public.sync_staff_permissions_auth_user();
  drop trigger if exists auth_users_sync_staff_email on auth.users;
  create trigger auth_users_sync_staff_email
    after update of email on auth.users
    for each row execute function public.sync_staff_permissions_auth_user();

  insert into public.staff_permissions (
    user_id, login_email, can_registration, can_console, can_room, is_active
  ) select id, email, true, true, true, true from auth.users
  on conflict (user_id) do nothing;
end $$;

drop trigger if exists staff_permissions_touch on public.staff_permissions;
create trigger staff_permissions_touch
  before update on public.staff_permissions
  for each row execute function public.touch_updated_at();

alter table public.staff_permissions enable row level security;
drop policy if exists staff_read_own_permissions on public.staff_permissions;
create policy staff_read_own_permissions
  on public.staff_permissions for select to authenticated
  using (user_id = (select auth.uid()));

-- Reading one's flags stays possible while inactive or unauthorized, allowing
-- the UI to explain the denial. There are deliberately no write policies.
revoke all on public.staff_permissions from public, anon, authenticated;
grant select on public.staff_permissions to authenticated;
-- Dashboard/Table Editor remains the only administration surface. This is a
-- database grant to Supabase's existing server role, never a browser key.
grant all on public.staff_permissions to service_role;

-- Replace every former broad policy; permissive policies otherwise OR together.
drop policy if exists staff_all_health_sessions on public.health_sessions;
drop policy if exists staff_read_health_sessions on public.health_sessions;
drop policy if exists registration_insert_health_sessions on public.health_sessions;
drop policy if exists registration_update_health_sessions on public.health_sessions;
create policy staff_read_health_sessions
  on public.health_sessions for select to authenticated
  -- Do not re-read this same table via a STABLE helper: a newly inserted row
  -- is not visible in that helper's statement snapshot during INSERT RETURNING.
  using (public.can_use_registration() or public.can_use_console() or public.can_use_room());
create policy registration_insert_health_sessions
  on public.health_sessions for insert to authenticated
  with check (public.can_use_registration() and created_by = auth.uid());
create policy registration_update_health_sessions
  on public.health_sessions for update to authenticated
  using (public.can_use_registration() and public.can_access_session(id))
  with check (public.can_use_registration() and public.can_access_session(id));

-- A session starts with defaults; status transitions/deletion and later room
-- count edits are RPC-only. Column grants stop a registration client from
-- bypassing the transactional room-count and clearance workflows.
revoke all on public.health_sessions from public, anon, authenticated;
grant select on public.health_sessions to authenticated;
grant insert (session_date, company_name, created_by, room_count)
  on public.health_sessions to authenticated;
grant update (session_date, company_name) on public.health_sessions to authenticated;

drop policy if exists staff_all_participants on public.participants;
drop policy if exists staff_read_participants on public.participants;
drop policy if exists registration_insert_participants on public.participants;
drop policy if exists registration_update_participants on public.participants;
drop policy if exists registration_delete_participants on public.participants;
create policy staff_read_participants
  on public.participants for select to authenticated
  using (public.can_access_session(session_id));
create policy registration_insert_participants
  on public.participants for insert to authenticated
  with check (public.can_use_registration() and public.can_access_session(session_id));
create policy registration_update_participants
  on public.participants for update to authenticated
  using (public.can_use_registration() and public.can_access_session(session_id))
  with check (public.can_use_registration() and public.can_access_session(session_id));
create policy registration_delete_participants
  on public.participants for delete to authenticated
  using (public.can_use_registration() and public.can_access_session(session_id));

-- Direct clients may manage schedule fields, not workflow state, check-in
-- numbering/timestamps, called_at, or a participant's identity/session keys.
revoke all on public.participants from public, anon, authenticated;
grant select, delete on public.participants to authenticated;
grant insert (session_id, sequence_no, employee_no, full_name, gender,
  schedule_slot, group_code, planned_items, note)
  on public.participants to authenticated;
grant update (sequence_no, employee_no, full_name, gender, schedule_slot,
  group_code, planned_items, note) on public.participants to authenticated;

drop policy if exists staff_all_examinations on public.examinations;
drop policy if exists staff_read_examinations on public.examinations;
create policy staff_read_examinations
  on public.examinations for select to authenticated
  using (exists (
    select 1 from public.participants
    where participants.id = examinations.participant_id
      and public.can_access_session(participants.session_id)
  ));
revoke all on public.examinations from public, anon, authenticated;
grant select on public.examinations to authenticated;

drop policy if exists staff_read_rooms on public.rooms;
create policy staff_read_rooms
  on public.rooms for select to authenticated
  using (public.can_access_session(session_id));
revoke all on public.rooms from public, anon, authenticated;
grant select on public.rooms to authenticated;

-- Counters remain private to the authorized check-in RPC. The item catalog is
-- only read by the current UI; no browser catalog mutation is needed.
revoke all on public.group_counters from public, anon, authenticated;
drop policy if exists staff_all_ultrasound_items on public.ultrasound_items;
drop policy if exists staff_read_ultrasound_items on public.ultrasound_items;
create policy staff_read_ultrasound_items
  on public.ultrasound_items for select to authenticated
  using (public.can_use_registration() or public.can_use_console() or public.can_use_room());
revoke all on public.ultrasound_items from public, anon, authenticated;
grant select on public.ultrasound_items to authenticated;

drop policy if exists staff_all_registered_devices on public.registered_devices;
drop policy if exists staff_read_own_registered_devices on public.registered_devices;
drop policy if exists registration_insert_own_devices on public.registered_devices;
drop policy if exists registration_update_own_devices on public.registered_devices;
drop policy if exists registration_delete_own_devices on public.registered_devices;
create policy staff_read_own_registered_devices
  on public.registered_devices for select to authenticated
  using (owner_id = auth.uid() and
    (public.can_use_registration() or public.can_use_console() or public.can_use_room()));
create policy registration_insert_own_devices
  on public.registered_devices for insert to authenticated
  with check (public.can_use_registration() and owner_id = auth.uid());
create policy registration_update_own_devices
  on public.registered_devices for update to authenticated
  using (public.can_use_registration() and owner_id = auth.uid())
  with check (public.can_use_registration() and owner_id = auth.uid());
create policy registration_delete_own_devices
  on public.registered_devices for delete to authenticated
  using (public.can_use_registration() and owner_id = auth.uid());
revoke all on public.registered_devices from public, anon, authenticated;
grant select, delete on public.registered_devices to authenticated;
grant insert (id, display_name, owner_id) on public.registered_devices to authenticated;
grant update (display_name, revoked_at, last_seen_at)
  on public.registered_devices to authenticated;

drop policy if exists staff_all_clearance_requests on public.clearance_requests;
drop policy if exists staff_read_clearance_requests on public.clearance_requests;
drop policy if exists registration_insert_clearance_requests on public.clearance_requests;
drop policy if exists registration_delete_clearance_requests on public.clearance_requests;
create policy staff_read_clearance_requests
  on public.clearance_requests for select to authenticated
  using (public.can_access_session(session_id));
create policy registration_insert_clearance_requests
  on public.clearance_requests for insert to authenticated
  with check (public.can_use_registration() and public.can_access_session(session_id));
create policy registration_delete_clearance_requests
  on public.clearance_requests for delete to authenticated
  using (public.can_use_registration() and public.can_access_session(session_id));
revoke all on public.clearance_requests from public, anon, authenticated;
grant select, delete on public.clearance_requests to authenticated;
grant insert (session_id, device_id) on public.clearance_requests to authenticated;

-- Realtime INSERT/UPDATE respects own-row SELECT RLS. DELETE carries only the
-- primary-key UUID with the default replica identity. Clients filter by their
-- user_id and refetch on events; no wider SELECT or full old-row payload is granted.
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'staff_permissions'
  ) then
    alter publication supabase_realtime add table public.staff_permissions;
  end if;
end $$;

-- Copy the current RPC implementations unchanged except for the first
-- authorization check. Existing session/participant/room locks, retry behavior,
-- server timestamps, additional rounds, and history retention stay intact.
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
  if not public.can_use_console() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
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
  if not public.can_use_console() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
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

create or replace function public.set_room_away(
  p_session_id uuid,
  p_room_id text,
  p_away boolean
)
returns public.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  room public.rooms;
  next_status public.room_status;
begin
  if not public.can_use_room() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_room_id is null or length(trim(p_room_id)) = 0 or p_away is null then
    raise exception 'invalid_room';
  end if;
  if not public.can_access_session(p_session_id) then
    raise exception 'not_authorized';
  end if;
  -- Prevent changes racing session closure/deletion, and retain the same
  -- active/today boundary used by the existing examination start RPC.
  perform 1 from public.health_sessions
  where id = p_session_id and status = 'active'
    and session_date = (clock_timestamp() at time zone 'Asia/Taipei')::date
  for share;
  if not found then raise exception 'not_today_session'; end if;
  perform public.require_enabled_room(p_session_id, p_room_id);

  insert into public.rooms (session_id, room_id)
  values (p_session_id, public.normalize_room_id(p_room_id))
  on conflict (session_id, room_id) do nothing;
  select * into room from public.rooms
  where session_id = p_session_id and room_id = public.normalize_room_id(p_room_id)
  for update;

  if p_away then
    next_status := 'away';
  elsif exists (
    select 1 from public.examinations
    join public.participants on participants.id = examinations.participant_id
    where participants.session_id = p_session_id
      and public.normalize_room_id(examinations.room_id) = room.room_id
      and examinations.status = 'in_progress'
  ) then
    next_status := 'in_progress';
  else
    next_status := 'idle';
  end if;

  -- Retry-safe: repeating the same desired state does not create another
  -- transition or overwrite any examination/draft data.
  if room.status <> next_status then
    update public.rooms set status = next_status
    where session_id = p_session_id and room_id = room.room_id
    returning * into room;
  end if;
  return room;
end;
$$;

create or replace function public.start_examination(
  p_participant_id uuid,
  p_room_id text,
  p_selected_items text[]
)
returns public.examinations
language plpgsql
security definer
set search_path = ''
as $$
declare
  participant public.participants;
  examination public.examinations;
  room public.rooms;
  next_round integer;
  locked_session_id uuid;
begin
  if not public.can_use_room() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_room_id is null or length(trim(p_room_id)) = 0
     or coalesce(cardinality(p_selected_items), 0) = 0
     or cardinality(p_selected_items) <> (select count(distinct item) from unnest(p_selected_items) item)
     or exists (select 1 from unnest(p_selected_items) item where item is null or item not in ('腹部超音波', '甲狀腺超音波', '婦科超音波', '前列腺超音波', '乳房超音波')) then
    raise exception 'invalid_examination';
  end if;
  select * into participant from public.participants where id = p_participant_id;
  if not found then raise exception 'participant_not_found'; end if;
  if not public.can_access_session(participant.session_id) then raise exception 'not_authorized'; end if;
  locked_session_id := participant.session_id;
  perform 1 from public.health_sessions
  where id = participant.session_id and status = 'active'
    and session_date = (clock_timestamp() at time zone 'Asia/Taipei')::date
  for share;
  if not found then raise exception 'not_today_session'; end if;
  perform public.require_enabled_room(locked_session_id, p_room_id);
  select * into participant from public.participants
  where id = p_participant_id for update;
  if not found then raise exception 'participant_not_found'; end if;
  if participant.session_id <> locked_session_id then raise exception 'participant_changed'; end if;
  if participant.checked_in_at is null or participant.checkin_no is null then raise exception 'not_checked_in'; end if;

  -- This row is the per-session/per-room mutex. Starts, completions, and away
  -- transitions all lock it before reading or changing room availability.
  insert into public.rooms (session_id, room_id)
  values (participant.session_id, public.normalize_room_id(p_room_id))
  on conflict (session_id, room_id) do nothing;
  select * into room from public.rooms
  where session_id = participant.session_id and room_id = public.normalize_room_id(p_room_id)
  for update;
  if room.status = 'away' then raise exception 'room_away'; end if;

  select * into examination from public.examinations
  where participant_id = p_participant_id and status = 'in_progress' for update;
  if found then
    if public.normalize_room_id(examination.room_id) <> room.room_id then raise exception 'examination_in_other_room:%', examination.room_id; end if;
    return examination;
  end if;
  -- Idle is the only allocatable status, including inconsistent legacy rows.
  -- The participant's own active-visit retry above remains idempotent.
  if room.status <> 'idle' then raise exception 'room_occupied'; end if;
  if exists (
    select 1 from public.examinations
    join public.participants on participants.id = examinations.participant_id
    where participants.session_id = participant.session_id
      and public.normalize_room_id(examinations.room_id) = room.room_id
      and examinations.status = 'in_progress'
  ) then raise exception 'room_occupied'; end if;

  -- Preserve additional-round queueing and the server's examination clock.
  select * into examination from public.examinations
  where participant_id = p_participant_id and status = 'waiting' for update;
  if found then
    update public.examinations
    set room_id = room.room_id, started_at = clock_timestamp(), status = 'in_progress'
    where id = examination.id returning * into examination;
  else
    if participant.status not in ('等候中', '已叫號', '上廁所', '心電圖', '先做其他') then raise exception 'invalid_state'; end if;
    select coalesce(max(round_no), 0) + 1 into next_round
    from public.examinations where participant_id = p_participant_id;
    insert into public.examinations (participant_id, round_no, room_id, started_at, selected_items, status)
    values (p_participant_id, next_round, room.room_id, clock_timestamp(), p_selected_items, 'in_progress')
    returning * into examination;
  end if;
  update public.participants set status = '檢查中' where id = p_participant_id;
  update public.rooms set status = 'in_progress'
  where session_id = participant.session_id and room_id = room.room_id;
  return examination;
end;
$$;

create or replace function public.complete_examination(
  p_examination_id uuid,
  p_room_id text,
  p_actual_items text[]
)
returns public.examinations
language plpgsql
security definer
set search_path = ''
as $$
declare
  participant public.participants;
  examination public.examinations;
  room public.rooms;
  finished_at timestamptz;
  locked_session_id uuid;
begin
  if not public.can_use_room() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_room_id is null or length(trim(p_room_id)) = 0
     or coalesce(cardinality(p_actual_items), 0) = 0
     or cardinality(p_actual_items) <> (select count(distinct item) from unnest(p_actual_items) item)
     or exists (select 1 from unnest(p_actual_items) item where item is null or item not in ('腹部超音波', '甲狀腺超音波', '婦科超音波', '前列腺超音波', '乳房超音波')) then
    raise exception 'invalid_examination';
  end if;
  -- Read only to discover the session; then use the same lock order as start
  -- (session -> participant -> room -> examination), also used by closure.
  select * into examination from public.examinations where id = p_examination_id;
  if not found then raise exception 'examination_not_started'; end if;
  select * into participant from public.participants
  where id = examination.participant_id;
  if not found then raise exception 'participant_not_found'; end if;
  if not public.can_access_session(participant.session_id) then raise exception 'not_authorized'; end if;
  locked_session_id := participant.session_id;
  perform 1 from public.health_sessions where id = locked_session_id for share;
  if not found then raise exception 'not_authorized'; end if;
  select * into participant from public.participants
  where id = examination.participant_id for update;
  if not found then raise exception 'participant_not_found'; end if;
  if participant.session_id <> locked_session_id then raise exception 'participant_changed'; end if;
  if public.normalize_room_id(examination.room_id) <> public.normalize_room_id(p_room_id) then raise exception 'examination_in_other_room:%', examination.room_id; end if;

  -- Historical completed rounds remain retry-safe after a safe room decrease.
  -- This read-only return does not create/update a retained inactive room row.
  if examination.status = 'completed' then return examination; end if;
  perform public.require_enabled_room(locked_session_id, p_room_id);

  insert into public.rooms (session_id, room_id)
  values (participant.session_id, public.normalize_room_id(p_room_id))
  on conflict (session_id, room_id) do nothing;
  select * into room from public.rooms
  where session_id = participant.session_id and room_id = public.normalize_room_id(p_room_id)
  for update;
  select * into examination from public.examinations
  where id = p_examination_id for update;
  if not found then raise exception 'examination_not_started'; end if;
  -- A harmless retry of a completed round stays idempotent, even while away.
  if examination.status = 'completed' then return examination; end if;
  if room.status = 'away' then raise exception 'room_away'; end if;
  if examination.status <> 'in_progress' or participant.status <> '檢查中' then raise exception 'invalid_state'; end if;
  if exists (select 1 from unnest(p_actual_items) item where not (item = any(examination.selected_items))) then raise exception 'item_not_selected'; end if;

  finished_at := greatest(clock_timestamp(), examination.started_at);
  update public.examinations
  set completed_at = finished_at,
      duration_seconds = greatest(0, extract(epoch from (finished_at - started_at))::integer),
      actual_items = p_actual_items, item_count = cardinality(p_actual_items), status = 'completed'
  where id = examination.id returning * into examination;
  if not exists (select 1 from public.examinations where participant_id = examination.participant_id and status in ('waiting', 'in_progress')) then
    update public.participants set status = '已完成' where id = examination.participant_id;
  end if;
  -- Preserve any other legacy active visit when restoring the room. The away
  -- guard also protects future callers that might allow finishing while away.
  update public.rooms
  set status = case when exists (
    select 1 from public.examinations
    join public.participants on participants.id = examinations.participant_id
    where participants.session_id = participant.session_id
      and public.normalize_room_id(examinations.room_id) = room.room_id
      and examinations.status = 'in_progress'
  ) then 'in_progress'::public.room_status else 'idle'::public.room_status end
  where session_id = participant.session_id and room_id = room.room_id and status <> 'away';
  return examination;
end;
$$;

create or replace function public.enqueue_additional_examination(p_participant_id uuid,p_selected_items text[])
returns public.examinations language plpgsql security definer set search_path='' as $$
declare participant public.participants; examination public.examinations; next_round integer;
begin
  if not public.can_use_room() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_selected_items),0)=0
     or cardinality(p_selected_items)<>(select count(distinct item) from unnest(p_selected_items) item)
     or exists(select 1 from unnest(p_selected_items) item where item not in ('腹部超音波','甲狀腺超音波','婦科超音波','前列腺超音波','乳房超音波')) then raise exception 'invalid_examination'; end if;
  select * into participant from public.participants where id=p_participant_id for update;
  if not found then raise exception 'participant_not_found'; end if;
  if not public.can_access_session(participant.session_id) then raise exception 'not_authorized'; end if;
  if participant.checked_in_at is null or participant.checkin_no is null then raise exception 'not_checked_in'; end if;
  if exists(select 1 from public.examinations where participant_id=p_participant_id and status='in_progress') then raise exception 'examination_in_progress'; end if;
  if exists(select 1 from public.examinations where participant_id=p_participant_id and status='waiting') then raise exception 'additional_examination_already_waiting'; end if;
  if participant.status<>'已完成' then raise exception 'invalid_state'; end if;
  select coalesce(max(round_no),0)+1 into next_round from public.examinations where participant_id=p_participant_id;
  insert into public.examinations(participant_id,round_no,room_id,started_at,selected_items,status)
    values(p_participant_id,next_round,null,null,p_selected_items,'waiting') returning * into examination;
  -- Deliberately keep check-in number/time/group untouched; this is not another check-in.
  update public.participants set status='等候中' where id=p_participant_id;
  return examination;
end $$;

create or replace function public.update_session_room_count(p_session_id uuid, p_room_count integer)
returns public.health_sessions language plpgsql security definer set search_path = '' as $$
declare session public.health_sessions;
begin
  if not public.can_use_registration() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if not public.can_access_session(p_session_id) then raise exception 'not_authorized'; end if;
  if p_room_count is null or p_room_count < public.min_room_count()
      or p_room_count > public.max_room_count() then raise exception 'invalid_room_count'; end if;
  select * into session from public.health_sessions where id = p_session_id for update;
  if not found then raise exception 'session_not_found'; end if;
  if session.status <> 'active'
      or session.session_date < (clock_timestamp() at time zone 'Asia/Taipei')::date then
    raise exception 'session_read_only';
  end if;
  update public.health_sessions set room_count = p_room_count where id = p_session_id returning * into session;
  return session;
end;
$$;

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
end;
$$;

create or replace function public.delete_health_session(p_session_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.can_use_registration() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if auth.uid() is null or not public.can_access_session(p_session_id) then
    raise exception 'not_authorized';
  end if;
  delete from public.health_sessions where id = p_session_id;
  if not found then raise exception 'session_not_found'; end if;
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
  update public.health_sessions set status = 'closed' where id = p_session_id;
  return jsonb_build_object('cloud_deleted', true, 'pending_devices', 0);
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
  if not public.can_use_registration() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
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

-- The authoritative clock is used only by the examination room page.
create or replace function public.examination_clock()
returns timestamptz language plpgsql stable security invoker set search_path = '' as $$
begin
  if not public.can_use_room() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  return clock_timestamp();
end;
$$;

-- Retire every legacy timestamp overload explicitly; the current migration
-- chain already drops them, and this prevents a restored old overload surviving.
drop function if exists public.start_examination(uuid, text, timestamptz);
drop function if exists public.complete_examination(uuid, text, timestamptz, timestamptz, text[]);

-- Explicit inventory of every exposed RPC/helper and every internal trigger.
-- No SECURITY DEFINER mutation inherits PUBLIC's default EXECUTE privilege.
revoke all on function
  public.is_active_staff(),
  public.can_use_registration(),
  public.can_use_console(),
  public.can_use_room(),
  public.can_access_session(uuid),
  public.check_in_participant(uuid),
  public.set_waiting_status(uuid, public.work_status),
  public.call_participant(uuid),
  public.set_room_away(uuid, text, boolean),
  public.start_examination(uuid, text, text[]),
  public.complete_examination(uuid, text, text[]),
  public.enqueue_additional_examination(uuid, text[]),
  public.update_session_room_count(uuid, integer),
  public.clear_session_schedule(uuid),
  public.delete_health_session(uuid),
  public.close_health_session(uuid),
  public.acknowledge_device_clear(uuid, text),
  public.examination_clock()
from public, anon, authenticated;
grant execute on function
  public.is_active_staff(),
  public.can_use_registration(),
  public.can_use_console(),
  public.can_use_room(),
  public.can_access_session(uuid),
  public.check_in_participant(uuid),
  public.set_waiting_status(uuid, public.work_status),
  public.call_participant(uuid),
  public.set_room_away(uuid, text, boolean),
  public.start_examination(uuid, text, text[]),
  public.complete_examination(uuid, text, text[]),
  public.enqueue_additional_examination(uuid, text[]),
  public.update_session_room_count(uuid, integer),
  public.clear_session_schedule(uuid),
  public.delete_health_session(uuid),
  public.close_health_session(uuid),
  public.acknowledge_device_clear(uuid, text),
  public.examination_clock()
to authenticated;

-- Trigger execution never needs client EXECUTE. Parsing/room validation helpers
-- can be called only from an authorized SECURITY DEFINER workflow.
revoke all on function
  public.sync_staff_permissions_auth_user(),
  public.touch_updated_at(),
  public.touch_room_updated_at(),
  public.release_deleted_participant_rooms(),
  public.guard_session_room_count(),
  public.initialize_session_rooms(),
  public.room_number(text),
  public.normalize_room_id(text),
  public.require_enabled_room(uuid, text)
from public, anon, authenticated;
