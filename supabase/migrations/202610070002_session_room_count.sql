-- A session owns its enabled-room count; retained room rows own availability.
-- Keep the database limits in one place, matching src/features/room/config.ts.
create or replace function public.min_room_count()
returns integer language sql immutable set search_path = '' as $$ select 1; $$;
create or replace function public.max_room_count()
returns integer language sql immutable set search_path = '' as $$ select 8; $$;
create or replace function public.default_room_count()
returns integer language sql immutable set search_path = '' as $$ select 4; $$;
revoke all on function public.min_room_count(), public.max_room_count(), public.default_room_count() from public, anon;
grant execute on function public.min_room_count(), public.max_room_count(), public.default_room_count() to authenticated;

alter table public.health_sessions
  add column room_count integer not null default public.default_room_count(),
  add constraint health_sessions_room_count_range
    check (room_count between public.min_room_count() and public.max_room_count());

-- Preserve the existing 診間 1 keys and accept the existing unspaced aliases.
-- Parsing is independent of today's upper limit so historical keys stay usable.
create or replace function public.room_number(p_room_id text)
returns integer language sql immutable strict set search_path = '' as $$
  select case when trim(p_room_id) ~ '^(診間[[:space:]]*|room_)[1-9][0-9]{0,8}$'
    then substring(trim(p_room_id) from '[0-9]+$')::integer end;
$$;
create or replace function public.normalize_room_id(p_room_id text)
returns text language sql immutable strict set search_path = '' as $$
  select case when public.room_number(p_room_id) is not null
    then '診間 ' || public.room_number(p_room_id)::text else trim(p_room_id) end;
$$;
revoke all on function public.room_number(text), public.normalize_room_id(text) from public, anon, authenticated;

-- Older RPCs accepted arbitrary room keys above the old four-room limit.
-- Consolidate only current-state aliases, keeping the most restrictive state
-- and latest timestamp. Examinations retain their original historical room_id;
-- retained inactive canonical rooms are never deleted. This DO statement is one
-- transaction, including trigger suspension, so partial merges cannot escape.
do $$ begin
  alter table public.rooms disable trigger rooms_touch;
  insert into public.rooms (session_id, room_id, status, updated_at)
  select session_id, '診間 ' || public.room_number(room_id)::text,
    case when bool_or(status = 'away') then 'away'::public.room_status
      when bool_or(status = 'in_progress') then 'in_progress'::public.room_status
      else 'idle'::public.room_status end,
    max(updated_at)
  from public.rooms
  where public.room_number(room_id) is not null
  group by session_id, public.room_number(room_id)
  on conflict (session_id, room_id) do update
    set status = excluded.status, updated_at = excluded.updated_at
    where rooms.status <> excluded.status or rooms.updated_at < excluded.updated_at;
  delete from public.rooms
  where public.room_number(room_id) is not null
    and room_id <> public.normalize_room_id(room_id);
  alter table public.rooms enable trigger rooms_touch;
end $$;

-- Called after taking the session SHARE lock, so validity cannot change before
-- the caller commits. Noncanonical/unknown/out-of-range room IDs never create rows.
create or replace function public.require_enabled_room(p_session_id uuid, p_room_id text)
returns text language plpgsql set search_path = '' as $$
declare enabled_count integer; room_no integer;
begin
  select room_count into enabled_count from public.health_sessions where id = p_session_id;
  room_no := public.room_number(p_room_id);
  if enabled_count is null or room_no is null
      or room_no < public.min_room_count() or room_no > enabled_count then
    raise exception 'invalid_room';
  end if;
  return public.normalize_room_id(p_room_id);
end;
$$;
revoke all on function public.require_enabled_room(uuid, text) from public, anon, authenticated;

-- UPDATE already owns the session row lock. Examination/away RPCs take SHARE
-- before participant -> room -> examination, so no such operation can race the
-- safety check. Lock room rows in numeric order; do not lock participants here
-- because direct participant DELETE already owns its participant row first.
create or replace function public.guard_session_room_count()
returns trigger language plpgsql security definer set search_path = '' as $$
declare room public.rooms; room_no integer;
begin
  if new.room_count is null or new.room_count < public.min_room_count()
      or new.room_count > public.max_room_count() then
    raise exception 'invalid_room_count';
  end if;
  if tg_op = 'INSERT' then return new; end if;
  if new.room_count = old.room_count then return new; end if;
  if old.status <> 'active' or new.status <> 'active'
      or old.session_date < (clock_timestamp() at time zone 'Asia/Taipei')::date
      or new.session_date < (clock_timestamp() at time zone 'Asia/Taipei')::date then
    raise exception 'session_read_only';
  end if;
  if new.room_count < old.room_count then
    for room in select * from public.rooms
      where session_id = old.id
        and public.room_number(room_id) > new.room_count
        and public.room_number(room_id) <= old.room_count
      order by public.room_number(room_id), room_id for update
    loop
      if room.status = 'in_progress' then raise exception 'room_count_in_progress:%', room.room_id; end if;
      if room.status = 'away' then raise exception 'room_count_away:%', room.room_id; end if;
    end loop;
    for room_no in new.room_count + 1 .. old.room_count loop
      if exists (
        select 1 from public.examinations
        join public.participants on participants.id = examinations.participant_id
        where participants.session_id = old.id
          and public.room_number(examinations.room_id) = room_no
          and examinations.status <> 'completed'
      ) then raise exception 'room_count_unfinished:%', '診間 ' || room_no::text; end if;
    end loop;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_session_room_count() from public, anon, authenticated;
create trigger health_sessions_guard_room_count
before insert or update of room_count on public.health_sessions
for each row execute function public.guard_session_room_count();

create or replace function public.initialize_session_rooms()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.rooms (session_id, room_id, status)
  select new.id, '診間 ' || room_no::text, 'idle'::public.room_status
  from generate_series(public.min_room_count(), new.room_count) room_no
  on conflict (session_id, room_id) do nothing;
  return new;
end;
$$;
revoke all on function public.initialize_session_rooms() from public, anon, authenticated;
create trigger health_sessions_initialize_rooms
after insert or update of room_count on public.health_sessions
for each row execute function public.initialize_session_rooms();

-- Old sessions get the documented default without touching stored availability,
-- examination history, or closed-session status. Decreasing never deletes rows.
insert into public.rooms (session_id, room_id, status)
select sessions.id, '診間 ' || room_no::text, 'idle'::public.room_status
from public.health_sessions sessions
cross join lateral generate_series(public.min_room_count(), sessions.room_count) room_no
on conflict (session_id, room_id) do nothing;

create or replace function public.update_session_room_count(p_session_id uuid, p_room_count integer)
returns public.health_sessions language plpgsql security definer set search_path = '' as $$
declare session public.health_sessions;
begin
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
revoke all on function public.update_session_room_count(uuid, integer) from public, anon;
grant execute on function public.update_session_room_count(uuid, integer) to authenticated;

-- Schedule clearing follows session -> participant -> room, as do closure,
-- deletion, starting and completion. Direct DELETE's existing room mutex is
-- retained; it cannot make a previously-safe room occupied.
create or replace function public.clear_session_schedule(p_session_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.can_access_session(p_session_id) then raise exception 'not_authorized'; end if;
  perform 1 from public.health_sessions where id = p_session_id for update;
  if not found then raise exception 'session_not_found'; end if;
  delete from public.participants where session_id = p_session_id;
  delete from public.group_counters where session_id = p_session_id;
  delete from public.clearance_requests where session_id = p_session_id;
end;
$$;

-- Session count updates use the same existing staff RLS policy. Realtime must
-- publish sessions as well as rooms so every tablet sees a count-only decrease.
alter table public.health_sessions replica identity full;
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'health_sessions'
  ) then alter publication supabase_realtime add table public.health_sessions; end if;
end $$;

-- Retain the full existing away and multiple-round behavior, validating room
-- membership while the session lock is held before any formal room write.
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
