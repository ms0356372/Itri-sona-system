-- Room availability and browser ownership are separate state machines.
-- A public device UUID is not a credential: every lease operation also proves
-- possession of an independent 256-bit secret, stored only as a SHA-256 hash.
alter table public.rooms
  add column if not exists claimed_by_device_id text,
  add column if not exists claimed_by_user_id uuid references auth.users(id) on delete set null,
  add column if not exists claimed_at timestamptz,
  add column if not exists claim_expires_at timestamptz,
  add column if not exists claim_secret_hash text;

-- Deleting an Auth account preserves the room and its status. A NULL user on an
-- otherwise complete lease remains occupied until expiry, but cannot renew it.
alter table public.rooms drop constraint if exists rooms_claim_complete;
alter table public.rooms add constraint rooms_claim_complete check (
  (claimed_by_device_id is null and claimed_by_user_id is null
    and claimed_at is null and claim_expires_at is null and claim_secret_hash is null)
  or
  (claimed_by_device_id is not null and length(trim(claimed_by_device_id)) > 0
    and claimed_at is not null and claim_expires_at is not null
    and claim_expires_at > claimed_at and claim_secret_hash is not null
    and claim_secret_hash ~ '^[0-9a-f]{64}$')
);
create index if not exists rooms_claim_device_idx
  on public.rooms(session_id, claimed_by_device_id)
  where claimed_by_device_id is not null;
create index if not exists rooms_claim_expiry_idx
  on public.rooms(session_id, claim_expires_at)
  where claimed_by_device_id is not null;

create or replace function public.room_claim_ttl_seconds()
returns integer language sql immutable set search_path = '' as $$ select 180; $$;

-- Native PostgreSQL SHA-256 avoids assuming where Supabase installed pgcrypto.
-- A captured hash cannot be replayed as a secret: it is hashed again and fails
-- comparison. The browser generates 32 random bytes and encodes them as hex.
create or replace function public.room_claim_secret_hash(p_device_id text, p_device_secret text)
returns text language plpgsql immutable set search_path = '' as $$
begin
  if p_device_id is null or p_device_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or p_device_secret is null or p_device_secret !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_device';
  end if;
  return pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_device_secret, 'UTF8')), 'hex');
end;
$$;

create or replace function public.room_claim_payload(
  p_room public.rooms, p_device_id text, p_secret_hash text, p_server_now timestamptz
)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'session_id', p_room.session_id,
    'room_id', p_room.room_id,
    'is_mine', coalesce(p_room.claimed_by_device_id = p_device_id
      and p_room.claimed_by_user_id = auth.uid() and p_room.claim_secret_hash = p_secret_hash
      and p_room.claim_expires_at > p_server_now, false),
    'is_claimed', coalesce(p_room.claimed_by_device_id is not null
      and p_room.claim_expires_at > p_server_now, false),
    'claimed_at', p_room.claimed_at,
    'claim_expires_at', p_room.claim_expires_at,
    'server_now', p_server_now
  );
$$;

-- This is private and is called only while the authorized RPC owns the room
-- mutex. clock_timestamp() is intentionally evaluated AFTER waiting for locks.
create or replace function public.require_own_room_claim(
  p_room public.rooms, p_device_id text, p_device_secret text
)
returns void language plpgsql set search_path = '' as $$
declare secret_hash text;
begin
  secret_hash := public.room_claim_secret_hash(p_device_id, p_device_secret);
  if p_room.claimed_by_device_id is distinct from p_device_id
      or p_room.claimed_by_user_id is distinct from auth.uid()
      or p_room.claim_secret_hash is distinct from secret_hash
      or p_room.claim_expires_at is null
      or p_room.claim_expires_at <= clock_timestamp() then
    raise exception 'room_claim_lost';
  end if;
end;
$$;

-- Keep updated_at's room-status meaning: renewing/selecting a device lease must
-- not look like a room availability change or reset an away/in_progress status.
create or replace function public.touch_room_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    new.updated_at := clock_timestamp();
  else
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;

-- Session UPDATE locks serialize claim operations for one session, ensuring a
-- device cannot obtain two different rooms by racing requests. Existing exam
-- workflows take session SHARE -> participant -> room, so the order is shared.
create or replace function public.claim_room(
  p_session_id uuid, p_room_id text, p_device_id text, p_device_secret text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare session public.health_sessions; room public.rooms; canonical_room text;
  secret_hash text; server_now timestamptz;
begin
  if not public.can_use_room() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  secret_hash := public.room_claim_secret_hash(p_device_id, p_device_secret);
  select * into session from public.health_sessions where id = p_session_id for update;
  if not found then raise exception 'session_not_found'; end if;
  if session.status <> 'active'
      or session.session_date < (clock_timestamp() at time zone 'Asia/Taipei')::date then
    raise exception 'session_read_only';
  end if;
  canonical_room := public.require_enabled_room(p_session_id, p_room_id);
  insert into public.rooms(session_id, room_id) values(p_session_id, canonical_room)
    on conflict(session_id, room_id) do nothing;
  select * into room from public.rooms
    where session_id = p_session_id and room_id = canonical_room for update;
  server_now := clock_timestamp();
  if room.claimed_by_device_id is not null and room.claim_expires_at > server_now
      and (room.claimed_by_device_id is distinct from p_device_id
        or room.claimed_by_user_id is distinct from auth.uid()
        or room.claim_secret_hash is distinct from secret_hash) then
    raise exception 'room_claimed';
  end if;
  if exists(select 1 from public.rooms
      where session_id = p_session_id and room_id <> canonical_room
        and claimed_by_device_id = p_device_id and claim_expires_at > server_now) then
    raise exception 'room_claim_switch_required';
  end if;
  -- Expired leases may be taken over, including an unfinished visit. The room
  -- status and every examination remain intact for the new device to recover.
  update public.rooms set claimed_by_device_id = p_device_id,
      claimed_by_user_id = auth.uid(), claim_secret_hash = secret_hash,
      claimed_at = server_now,
      claim_expires_at = server_now + make_interval(secs => public.room_claim_ttl_seconds())
    where session_id = p_session_id and room_id = canonical_room returning * into room;
  return public.room_claim_payload(room, p_device_id, secret_hash, server_now);
end;
$$;

create or replace function public.switch_room_claim(
  p_session_id uuid, p_from_room_id text, p_to_room_id text,
  p_device_id text, p_device_secret text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare session public.health_sessions; source public.rooms; target public.rooms;
  from_room text; to_room text; secret_hash text; server_now timestamptz;
begin
  if not public.can_use_room() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  secret_hash := public.room_claim_secret_hash(p_device_id, p_device_secret);
  select * into session from public.health_sessions where id = p_session_id for update;
  if not found then raise exception 'session_not_found'; end if;
  if session.status <> 'active'
      or session.session_date < (clock_timestamp() at time zone 'Asia/Taipei')::date then
    raise exception 'session_read_only';
  end if;
  from_room := public.require_enabled_room(p_session_id, p_from_room_id);
  to_room := public.require_enabled_room(p_session_id, p_to_room_id);
  insert into public.rooms(session_id, room_id)
    select p_session_id, room_id from (select from_room as room_id union select to_room) candidates
    on conflict(session_id, room_id) do nothing;
  -- Deterministic room order also agrees with the participant-delete trigger.
  perform 1 from public.rooms where session_id = p_session_id and room_id in(from_room, to_room)
    order by public.room_number(room_id), room_id for update;
  select * into source from public.rooms where session_id = p_session_id and room_id = from_room;
  select * into target from public.rooms where session_id = p_session_id and room_id = to_room;
  perform public.require_own_room_claim(source, p_device_id, p_device_secret);
  server_now := clock_timestamp();
  if from_room = to_room then
    update public.rooms set claim_expires_at = server_now + make_interval(secs => public.room_claim_ttl_seconds())
      where session_id = p_session_id and room_id = from_room returning * into target;
    return public.room_claim_payload(target, p_device_id, secret_hash, server_now);
  end if;
  if source.status = 'in_progress' or exists(
      select 1 from public.examinations join public.participants on participants.id = examinations.participant_id
      where participants.session_id = p_session_id
        and public.normalize_room_id(examinations.room_id) = from_room
        and examinations.status <> 'completed') then
    raise exception 'room_claim_in_progress';
  end if;
  if target.claimed_by_device_id is not null and target.claim_expires_at > server_now
      and (target.claimed_by_device_id is distinct from p_device_id
        or target.claimed_by_user_id is distinct from auth.uid()
        or target.claim_secret_hash is distinct from secret_hash) then
    raise exception 'room_claimed';
  end if;
  if exists(select 1 from public.rooms
      where session_id = p_session_id and room_id not in(from_room, to_room)
        and claimed_by_device_id = p_device_id and claim_expires_at > server_now) then
    raise exception 'room_claim_switch_required';
  end if;
  -- Both writes commit together. A failure above leaves the original lease
  -- entirely unchanged; successful switching never changes either room status.
  update public.rooms set claimed_by_device_id = p_device_id,
      claimed_by_user_id = auth.uid(), claim_secret_hash = secret_hash,
      claimed_at = server_now,
      claim_expires_at = server_now + make_interval(secs => public.room_claim_ttl_seconds())
    where session_id = p_session_id and room_id = to_room returning * into target;
  update public.rooms set claimed_by_device_id = null, claimed_by_user_id = null,
      claimed_at = null, claim_expires_at = null, claim_secret_hash = null
    where session_id = p_session_id and room_id = from_room;
  return public.room_claim_payload(target, p_device_id, secret_hash, server_now);
end;
$$;

create or replace function public.heartbeat_room_claim(
  p_session_id uuid, p_room_id text, p_device_id text, p_device_secret text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare session public.health_sessions; room public.rooms; canonical_room text;
  secret_hash text; server_now timestamptz;
begin
  if not public.can_use_room() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  secret_hash := public.room_claim_secret_hash(p_device_id, p_device_secret);
  select * into session from public.health_sessions where id = p_session_id for update;
  if not found then raise exception 'session_not_found'; end if;
  if session.status <> 'active'
      or session.session_date < (clock_timestamp() at time zone 'Asia/Taipei')::date then
    raise exception 'session_read_only';
  end if;
  canonical_room := public.require_enabled_room(p_session_id, p_room_id);
  select * into room from public.rooms
    where session_id = p_session_id and room_id = canonical_room for update;
  if not found then raise exception 'room_claim_lost'; end if;
  perform public.require_own_room_claim(room, p_device_id, p_device_secret);
  server_now := clock_timestamp();
  update public.rooms set claim_expires_at = server_now + make_interval(secs => public.room_claim_ttl_seconds())
    where session_id = p_session_id and room_id = canonical_room returning * into room;
  return public.room_claim_payload(room, p_device_id, secret_hash, server_now);
end;
$$;

drop function if exists public.release_room_claim(uuid, text, text, text);
create or replace function public.release_room_claim(
  p_session_id uuid, p_room_id text, p_device_id text, p_device_secret text,
  p_expected_claimed_at timestamptz default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare room public.rooms; canonical_room text; secret_hash text; server_now timestamptz;
begin
  if not public.can_use_room() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  secret_hash := public.room_claim_secret_hash(p_device_id, p_device_secret);
  perform 1 from public.health_sessions where id = p_session_id for update;
  if not found then raise exception 'session_not_found'; end if;
  canonical_room := public.require_enabled_room(p_session_id, p_room_id);
  select * into room from public.rooms
    where session_id = p_session_id and room_id = canonical_room for update;
  if not found then raise exception 'room_claim_lost'; end if;
  server_now := clock_timestamp();
  -- Fence an older cleanup request against a newer acquisition from the same
  -- device (including requests that outlive a browser reload). Heartbeats keep
  -- claimed_at unchanged, so ordinary release still matches its acquisition.
  if p_expected_claimed_at is not null
      and room.claimed_at is distinct from p_expected_claimed_at then
    raise exception 'room_claim_lost';
  end if;
  -- Repeated normal cleanup is a harmless no-op once no lease exists.
  if room.claimed_by_device_id is null then
    return public.room_claim_payload(room, p_device_id, secret_hash, server_now);
  end if;
  perform public.require_own_room_claim(room, p_device_id, p_device_secret);
  if room.status = 'in_progress' or exists(
      select 1 from public.examinations join public.participants on participants.id = examinations.participant_id
      where participants.session_id = p_session_id
        and public.normalize_room_id(examinations.room_id) = canonical_room
        and examinations.status <> 'completed') then
    raise exception 'room_claim_in_progress';
  end if;
  update public.rooms set claimed_by_device_id = null, claimed_by_user_id = null,
      claimed_at = null, claim_expires_at = null, claim_secret_hash = null
    where session_id = p_session_id and room_id = canonical_room returning * into room;
  return public.room_claim_payload(room, p_device_id, secret_hash, clock_timestamp());
end;
$$;

create or replace function public.list_room_claims(
  p_session_id uuid, p_device_id text, p_device_secret text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare session public.health_sessions; secret_hash text; server_now timestamptz; claims jsonb;
begin
  if not public.can_use_room() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  secret_hash := public.room_claim_secret_hash(p_device_id, p_device_secret);
  select * into session from public.health_sessions where id = p_session_id;
  if not found then raise exception 'session_not_found'; end if;
  server_now := clock_timestamp();
  -- Generate the enabled range instead of trusting retained inactive room rows.
  -- No device/user UUID or credential hash is returned to the page selector.
  select coalesce(jsonb_agg(jsonb_build_object(
      'session_id', p_session_id,
      'room_id', '診間 ' || enabled.room_no::text,
      'is_mine', coalesce(rooms.claimed_by_device_id = p_device_id
        and rooms.claimed_by_user_id = auth.uid() and rooms.claim_secret_hash = secret_hash
        and rooms.claim_expires_at > server_now, false),
      'is_claimed', coalesce(rooms.claimed_by_device_id is not null and rooms.claim_expires_at > server_now, false),
      'claimed_at', rooms.claimed_at,
      'claim_expires_at', rooms.claim_expires_at,
      'server_now', server_now
    ) order by enabled.room_no), '[]'::jsonb) into claims
    from generate_series(public.min_room_count(), session.room_count) enabled(room_no)
    left join public.rooms on rooms.session_id = p_session_id
      and rooms.room_id = '診間 ' || enabled.room_no::text;
  return claims;
end;
$$;

-- A safe count decrease must not disable a currently claimed idle room.
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
      if room.claimed_by_device_id is not null and room.claim_expires_at > clock_timestamp() then
        raise exception 'room_count_claimed:%', room.room_id;
      end if;
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

-- Retire uncredentialed and legacy timestamp RPC overloads. No old client or
-- direct API can mutate room/examination state without proving a valid lease.
drop function if exists public.set_room_away(uuid, text, boolean);
drop function if exists public.start_examination(uuid, text, text[]);
drop function if exists public.complete_examination(uuid, text, text[]);
drop function if exists public.start_examination(uuid, text, timestamptz);
drop function if exists public.complete_examination(uuid, text, timestamptz, timestamptz, text[]);

create or replace function public.set_room_away(
  p_session_id uuid,
  p_room_id text,
  p_away boolean,
  p_device_id text,
  p_device_secret text
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
  perform public.require_own_room_claim(room, p_device_id, p_device_secret);

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
  p_selected_items text[],
  p_device_id text,
  p_device_secret text
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
  perform public.require_own_room_claim(room, p_device_id, p_device_secret);
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
  p_actual_items text[],
  p_device_id text,
  p_device_secret text
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

  -- Even a completion retry must prove current ownership. History remains
  -- readable through SELECT; completion is never an uncredentialed bypass.
  perform public.require_enabled_room(locked_session_id, p_room_id);

  insert into public.rooms (session_id, room_id)
  values (participant.session_id, public.normalize_room_id(p_room_id))
  on conflict (session_id, room_id) do nothing;
  select * into room from public.rooms
  where session_id = participant.session_id and room_id = public.normalize_room_id(p_room_id)
  for update;
  perform public.require_own_room_claim(room, p_device_id, p_device_secret);
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

-- Preserve the existing state-read RLS and Realtime publication, while keeping
-- every lease/status write RPC-only. PostgreSQL UPDATE events include new claim
-- fields; clients refetch list_room_claims rather than trusting event payloads.
alter table public.rooms enable row level security;
revoke all on public.rooms from public, anon, authenticated;
grant select on public.rooms to authenticated;

revoke all on function
  public.claim_room(uuid, text, text, text),
  public.switch_room_claim(uuid, text, text, text, text),
  public.heartbeat_room_claim(uuid, text, text, text),
  public.release_room_claim(uuid, text, text, text, timestamptz),
  public.list_room_claims(uuid, text, text),
  public.set_room_away(uuid, text, boolean, text, text),
  public.start_examination(uuid, text, text[], text, text),
  public.complete_examination(uuid, text, text[], text, text)
from public, anon, authenticated;
grant execute on function
  public.claim_room(uuid, text, text, text),
  public.switch_room_claim(uuid, text, text, text, text),
  public.heartbeat_room_claim(uuid, text, text, text),
  public.release_room_claim(uuid, text, text, text, timestamptz),
  public.list_room_claims(uuid, text, text),
  public.set_room_away(uuid, text, boolean, text, text),
  public.start_examination(uuid, text, text[], text, text),
  public.complete_examination(uuid, text, text[], text, text)
to authenticated;

-- Internal primitives are never callable by browser roles; a hash alone cannot
-- be passed to a state-mutating helper or used to acquire/renew someone else's lease.
revoke all on function
  public.room_claim_ttl_seconds(),
  public.room_claim_secret_hash(text, text),
  public.room_claim_payload(public.rooms, text, text, timestamptz),
  public.require_own_room_claim(public.rooms, text, text),
  public.touch_room_updated_at(),
  public.guard_session_room_count()
from public, anon, authenticated;
