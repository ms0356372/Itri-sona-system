-- Room availability is independent of the participant's examination state.
-- Keep only the current state: returning derives idle/in_progress from visits,
-- so there is no second previous-state field that can become stale.
create type public.room_status as enum ('idle', 'in_progress', 'away');

-- Existing consoles accept both 診間1 and 診間 1. Use one key for those
-- aliases so an older device cannot bypass absence using different spacing.
create or replace function public.normalize_room_id(p_room_id text)
returns text language sql immutable strict set search_path = '' as $$
  select case when trim(p_room_id) ~ '^診間[[:space:]]*[1-4]$'
    then regexp_replace(trim(p_room_id), '^診間[[:space:]]*([1-4])$', '診間 \1')
    else trim(p_room_id) end;
$$;
revoke all on function public.normalize_room_id(text) from public, anon, authenticated;

create table public.rooms (
  session_id uuid not null references public.health_sessions (id) on delete cascade,
  room_id text not null check (length(trim(room_id)) > 0),
  status public.room_status not null default 'idle',
  updated_at timestamptz not null default clock_timestamp(),
  primary key (session_id, room_id)
);

create or replace function public.touch_room_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
revoke all on function public.touch_room_updated_at() from public, anon, authenticated;
create trigger rooms_touch
before update on public.rooms
for each row execute function public.touch_room_updated_at();

-- Existing active visits stay active. No participant, visit, timestamps, or
-- selected items are changed by this migration or by temporary absence.
insert into public.rooms (session_id, room_id, status)
select distinct participants.session_id, public.normalize_room_id(examinations.room_id), 'in_progress'::public.room_status
from public.examinations
join public.participants on participants.id = examinations.participant_id
where examinations.status = 'in_progress';

alter table public.rooms enable row level security;
create policy staff_read_rooms
on public.rooms for select to authenticated
using (public.can_access_session(session_id));

-- All formal writes use the RPCs below, including callers of older clients.
revoke all on public.rooms from public, anon, authenticated;
grant select on public.rooms to authenticated;
grant usage on type public.room_status to authenticated;
revoke insert, update, delete on public.examinations from public, anon, authenticated;

alter table public.rooms replica identity full;
alter publication supabase_realtime add table public.rooms;

-- Deleting a participant (including clearing/closing a session) cascades visits.
-- Release only this participant's rooms before the cascade; excluding OLD.id
-- derives the remaining occupancy without locking another session's rooms.
create or replace function public.release_deleted_participant_rooms()
returns trigger language plpgsql security definer set search_path = '' as $$
declare room public.rooms;
begin
  for room in
    select * from public.rooms as rooms
    where rooms.session_id = old.session_id and rooms.status = 'in_progress'
      and exists (
        select 1 from public.examinations
        where participant_id = old.id and status = 'in_progress'
          and public.normalize_room_id(room_id) = rooms.room_id
      )
    order by room_id for update
  loop
    if not exists (
      select 1 from public.examinations
      join public.participants on participants.id = examinations.participant_id
      where participants.session_id = room.session_id
        and participants.id <> old.id
        and public.normalize_room_id(examinations.room_id) = room.room_id
        and examinations.status = 'in_progress'
    ) then
      update public.rooms set status = 'idle'
      where session_id = room.session_id and room_id = room.room_id and status <> 'away';
    end if;
  end loop;
  return old;
end;
$$;
revoke all on function public.release_deleted_participant_rooms() from public, anon, authenticated;
create trigger participants_release_rooms_before_delete
before delete on public.participants
for each row execute function public.release_deleted_participant_rooms();

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

revoke all on function public.set_room_away(uuid, text, boolean),
  public.start_examination(uuid, text, text[]),
  public.complete_examination(uuid, text, text[]) from public, anon;
grant execute on function public.set_room_away(uuid, text, boolean),
  public.start_examination(uuid, text, text[]),
  public.complete_examination(uuid, text, text[]) to authenticated;
