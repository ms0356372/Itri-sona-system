-- Roll back fixtures after exercising the actual RPCs as an authenticated
-- staff member. Intended for scripts/test-room-away-db.sh, never production.
begin;
-- Test-only invoker helpers keep legacy workflow assertions on the actual
-- credential-protected RPCs. Each (user, session, canonical room) is a separate
-- simulated browser, so one installation never owns multiple rooms per session.
create temporary table fixture_room_claims (
  session_id uuid not null, room_key text not null, user_id uuid not null,
  primary key (session_id,room_key,user_id)
);
grant select,insert,delete on fixture_room_claims to authenticated;
create function pg_temp.fixture_room_key(p_room_id text)
returns text language sql immutable as $$
  select case when trim(p_room_id) ~ '^(診間[[:space:]]*|room_)[1-9][0-9]{0,8}$'
    then '診間 ' || substring(trim(p_room_id) from '[0-9]+$')::integer::text
    else trim(p_room_id) end;
$$;
create function pg_temp.fixture_device_id(p_session_id uuid,p_room_id text)
returns text language sql stable as $$
  select md5(coalesce(p_session_id::text,'missing-session') || '/' ||
    coalesce(pg_temp.fixture_room_key(p_room_id),'invalid-room') || '/' ||
    coalesce(auth.uid()::text,'missing-user'))::uuid::text;
$$;
create function pg_temp.ensure_fixture_room_claim(p_session_id uuid,p_room_id text)
returns void language plpgsql as $$
begin
  if exists (select 1 from fixture_room_claims
    where session_id=p_session_id and room_key=pg_temp.fixture_room_key(p_room_id) and user_id=auth.uid()) then return; end if;
  perform public.claim_room(p_session_id,p_room_id,
    pg_temp.fixture_device_id(p_session_id,p_room_id),repeat('a',64));
  insert into fixture_room_claims values(p_session_id,pg_temp.fixture_room_key(p_room_id),auth.uid());
end $$;
create function pg_temp.set_room_away(p_session_id uuid,p_room_id text,p_away boolean)
returns public.rooms language plpgsql as $$
begin
  perform pg_temp.ensure_fixture_room_claim(p_session_id,p_room_id);
  return public.set_room_away(p_session_id,p_room_id,p_away,
    pg_temp.fixture_device_id(p_session_id,p_room_id),repeat('a',64));
end $$;
create function pg_temp.start_examination(p_participant_id uuid,p_room_id text,p_items text[])
returns public.examinations language plpgsql as $$
declare session_id uuid;
begin
  select participants.session_id into session_id from public.participants where id=p_participant_id;
  perform pg_temp.ensure_fixture_room_claim(session_id,p_room_id);
  return public.start_examination(p_participant_id,p_room_id,p_items,
    pg_temp.fixture_device_id(session_id,p_room_id),repeat('a',64));
end $$;
create function pg_temp.complete_examination(p_examination_id uuid,p_room_id text,p_items text[])
returns public.examinations language plpgsql as $$
declare session_id uuid;
begin
  select participants.session_id into session_id from public.participants
    join public.examinations on examinations.participant_id=participants.id where examinations.id=p_examination_id;
  perform pg_temp.ensure_fixture_room_claim(session_id,p_room_id);
  return public.complete_examination(p_examination_id,p_room_id,p_items,
    pg_temp.fixture_device_id(session_id,p_room_id),repeat('a',64));
end $$;
create function pg_temp.release_fixture_room_claim(p_session_id uuid,p_room_id text)
returns void language plpgsql as $$
begin
  perform public.release_room_claim(p_session_id,p_room_id,
    pg_temp.fixture_device_id(p_session_id,p_room_id),repeat('a',64));
  delete from fixture_room_claims where session_id=p_session_id
    and room_key=pg_temp.fixture_room_key(p_room_id) and user_id=auth.uid();
end $$;

insert into auth.users(id) values('11111111-1111-1111-1111-111111111111');
update public.staff_permissions set can_registration=true,can_console=true,can_room=true where user_id='11111111-1111-1111-1111-111111111111';
insert into public.health_sessions(id, session_date, company_name, created_by)
values('22222222-2222-2222-2222-222222222222', (clock_timestamp() at time zone 'Asia/Taipei')::date, 'room absence test', '11111111-1111-1111-1111-111111111111'),
      ('22222222-2222-2222-2222-222222222223', (clock_timestamp() at time zone 'Asia/Taipei')::date, 'other room session', '11111111-1111-1111-1111-111111111111'),
      ('22222222-2222-2222-2222-222222222224', (clock_timestamp() at time zone 'Asia/Taipei')::date - 1, 'old room session', '11111111-1111-1111-1111-111111111111');
insert into public.participants(id,session_id,sequence_no,employee_no,full_name,schedule_slot,group_code,status,checkin_no,checked_in_at)
values('33333333-3333-3333-3333-333333333331','22222222-2222-2222-2222-222222222222',1,'1','A','08:00','A','等候中','A1',clock_timestamp()),
      ('33333333-3333-3333-3333-333333333332','22222222-2222-2222-2222-222222222222',2,'2','B','08:00','A','等候中','A2',clock_timestamp()),
      ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',3,'3','C','08:00','A','等候中','A3',clock_timestamp()),
      ('33333333-3333-3333-3333-333333333334','22222222-2222-2222-2222-222222222223',1,'4','D','08:00','A','等候中','A1',clock_timestamp());

set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set local role authenticated;
do $$
declare
  room public.rooms;
  first_visit public.examinations;
  visit public.examinations;
  additional_visit public.examinations;
  failed boolean;
begin
  if has_table_privilege(current_user, 'public.rooms', 'INSERT,UPDATE,DELETE') then raise exception 'rooms must be RPC-only'; end if;
  if has_table_privilege(current_user, 'public.examinations', 'INSERT,UPDATE,DELETE') then raise exception 'examinations must be RPC-only'; end if;
  if has_function_privilege('anon', 'public.set_room_away(uuid,text,boolean,text,text)', 'EXECUTE') then raise exception 'anon must not change room status'; end if;

  room := pg_temp.set_room_away('22222222-2222-2222-2222-222222222222', '診間 1', true);
  if room.status <> 'away' then raise exception 'empty room did not become away'; end if;
  if (select status from public.rooms where session_id=room.session_id and room_id=room.room_id) <> 'away' then raise exception 'away was not persisted'; end if;
  if pg_temp.set_room_away(room.session_id, '診間1', true) <> room then raise exception 'away retry was not idempotent'; end if;
  failed := false;
  begin
    perform pg_temp.start_examination('33333333-3333-3333-3333-333333333331', '診間1', array['腹部超音波']);
  exception when raise_exception then
    if sqlerrm <> 'room_away' then raise; end if;
    failed := true;
  end;
  if not failed then raise exception 'start accepted an away room alias'; end if;
  room := pg_temp.set_room_away(room.session_id, room.room_id, false);
  if room.status <> 'idle' then raise exception 'empty room did not return idle'; end if;

  first_visit := pg_temp.start_examination('33333333-3333-3333-3333-333333333331', '診間1', array['腹部超音波', '甲狀腺超音波']);
  if first_visit.room_id <> '診間 1' then raise exception 'room alias was not normalized'; end if;
  if (select status from public.rooms where session_id=room.session_id and room_id=room.room_id) <> 'in_progress' then raise exception 'start did not update room'; end if;
  visit := pg_temp.start_examination(first_visit.participant_id, '診間 1', array['腹部超音波']);
  if visit <> first_visit then raise exception 'start retry changed the active examination'; end if;
  room := pg_temp.set_room_away(room.session_id, room.room_id, true);
  select * into visit from public.examinations where id=first_visit.id;
  if visit <> first_visit then raise exception 'away changed examination data'; end if;
  if (select status from public.participants where id=first_visit.participant_id) <> '檢查中' then raise exception 'away changed participant status'; end if;
  failed := false;
  begin
    perform pg_temp.complete_examination(first_visit.id, '診間 1', array['腹部超音波']);
  exception when raise_exception then
    if sqlerrm <> 'room_away' then raise; end if;
    failed := true;
  end;
  if not failed then raise exception 'completion accepted an away room'; end if;

  -- Other rooms and sessions must not share the absent room's state.
  if (pg_temp.set_room_away(room.session_id, '診間 2', false)).status <> 'idle' then raise exception 'room state leaked'; end if;
  if (pg_temp.set_room_away('22222222-2222-2222-2222-222222222223', '診間 1', false)).status <> 'idle' then raise exception 'session state leaked'; end if;
  perform pg_temp.start_examination('33333333-3333-3333-3333-333333333334', '診間 1', array['腹部超音波']);
  room := pg_temp.set_room_away(room.session_id, room.room_id, false);
  if room.status <> 'in_progress' then raise exception 'return failed to restore active visit'; end if;
  failed := false;
  begin
    perform pg_temp.start_examination('33333333-3333-3333-3333-333333333332', room.room_id, array['腹部超音波']);
  exception when raise_exception then
    if sqlerrm <> 'room_occupied' then raise; end if;
    failed := true;
  end;
  if not failed then raise exception 'occupied room accepted another participant'; end if;

  visit := pg_temp.complete_examination(first_visit.id, room.room_id, array['腹部超音波']);
  if visit.status <> 'completed' or visit.duration_seconds < 0 or visit.item_count <> 1 then raise exception 'normal completion regressed'; end if;
  if (select status from public.rooms where session_id=room.session_id and room_id=room.room_id) <> 'idle' then raise exception 'completion did not release room'; end if;
  room := pg_temp.set_room_away(room.session_id, room.room_id, true);
  if pg_temp.complete_examination(visit.id, room.room_id, array['腹部超音波']) <> visit then raise exception 'completion retry lost idempotency'; end if;
  if (select status from public.rooms where session_id=room.session_id and room_id=room.room_id) <> 'away' then raise exception 'completion retry overwrote away'; end if;
  room := pg_temp.set_room_away(room.session_id, room.room_id, false);

  additional_visit := public.enqueue_additional_examination(first_visit.participant_id, array['甲狀腺超音波']);
  visit := pg_temp.start_examination(first_visit.participant_id, room.room_id, array['腹部超音波']);
  if visit.id <> additional_visit.id or visit.round_no <> 2 or visit.selected_items <> array['甲狀腺超音波'] then raise exception 'additional-round workflow regressed'; end if;
  visit := pg_temp.complete_examination(visit.id, room.room_id, array['甲狀腺超音波']);
  visit := pg_temp.start_examination('33333333-3333-3333-3333-333333333332', room.room_id, array['腹部超音波']);
  if visit.status <> 'in_progress' then raise exception 'returned room cannot receive next participant'; end if;

  failed := false;
  begin
    perform public.set_room_away('22222222-2222-2222-2222-222222222224', '診間 1', true,
      '88888888-8888-8888-8888-888888888888',repeat('a',64));
  exception when raise_exception then
    if sqlerrm <> 'not_today_session' then raise; end if;
    failed := true;
  end;
  if not failed then raise exception 'expired session accepted absence'; end if;
  failed := false;
  begin
    perform pg_temp.set_room_away('22222222-2222-2222-2222-222222222222', null, true);
  exception when raise_exception then
    if sqlerrm <> 'invalid_room' then raise; end if;
    failed := true;
  end;
  if not failed then raise exception 'null room was accepted'; end if;

  -- Staff can already remove roster entries; the cascaded visit deletion must
  -- release an occupied room while schedule clearing must preserve away.
  delete from public.participants where id = '33333333-3333-3333-3333-333333333332';
  if (select status from public.rooms where session_id=room.session_id and room_id=room.room_id) <> 'idle' then raise exception 'participant deletion left an occupied room'; end if;
  if (select status from public.rooms where session_id='22222222-2222-2222-2222-222222222223' and room_id=room.room_id) <> 'in_progress' then raise exception 'participant deletion changed another session room'; end if;
  perform pg_temp.start_examination('33333333-3333-3333-3333-333333333333', room.room_id, array['腹部超音波']);
  room := pg_temp.set_room_away(room.session_id, room.room_id, true);
  perform public.clear_session_schedule(room.session_id);
  if (select status from public.rooms where session_id=room.session_id and room_id=room.room_id) <> 'away' then raise exception 'clearing schedule cancelled away'; end if;
  room := pg_temp.set_room_away(room.session_id, room.room_id, false);
  if room.status <> 'idle' then raise exception 'cleared absent room did not return idle'; end if;

  perform set_config('request.jwt.claim.sub', '', true);
  failed := false;
  begin
    perform pg_temp.set_room_away(room.session_id, room.room_id, true);
  exception when insufficient_privilege then
    if sqlerrm <> 'permission_denied' then raise; end if;
    failed := true;
  end;
  if not failed then raise exception 'missing identity accepted absence'; end if;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
end;
$$;
reset role;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='rooms') then
    raise exception 'rooms missing realtime publication';
  end if;
end $$;
rollback;
\echo 'PASS: persisted away/return, room isolation, RPC permission boundary, retained visits, completion, and additional rounds'
