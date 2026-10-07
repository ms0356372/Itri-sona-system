#!/usr/bin/env bash
# Runs only against a disposable local container: no Supabase credentials,
# exposed ports, network, or production DATABASE_URL are used.
set -euo pipefail
cd "$(dirname "$0")/.."
room_test_container="ultrasound-room-away-test-$$"
room_test_work="$(mktemp -d)"
room_test_docker=(env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH docker --host=unix:///var/run/docker.sock)
cleanup() {
  "${room_test_docker[@]}" rm -f "$room_test_container" >/dev/null 2>&1 || true
  rm -rf "$room_test_work"
}
trap cleanup EXIT
"${room_test_docker[@]}" run --detach --rm --network none \
  --name "$room_test_container" -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine \
  -c wal_level=logical >/dev/null
for attempt in {1..30}; do
  if "${room_test_docker[@]}" exec "$room_test_container" sh -c 'test "$(cat /proc/1/comm)" = postgres && pg_isready -U postgres' >/dev/null 2>&1; then break; fi
  sleep 1
done
psql_local() {
  "${room_test_docker[@]}" exec -i "$room_test_container" psql -X -v ON_ERROR_STOP=1 -U postgres "$@"
}

# The production migrations use Supabase's auth roles, auth.uid(), and realtime
# publication. Stub only that platform scaffolding; run the actual SQL unchanged.
psql_local >/dev/null <<'SQL'
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}');
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
create publication supabase_realtime;
SQL
for migration in supabase/migrations/*.sql; do
  if [[ "$migration" == *202610070001_room_away.sql ]]; then
    psql_local >/dev/null <<'SQL'
insert into auth.users(id) values('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
insert into public.health_sessions(id,session_date,company_name,created_by)
values('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',(clock_timestamp() at time zone 'Asia/Taipei')::date,'legacy backfill','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
insert into public.participants(id,session_id,sequence_no,employee_no,full_name,schedule_slot,group_code,status,checkin_no,checked_in_at)
values('cccccccc-cccc-cccc-cccc-cccccccccccc','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',1,'legacy','Legacy','08:00','A','檢查中','A1',clock_timestamp());
insert into public.examinations(id,participant_id,round_no,room_id,started_at,selected_items,status)
values('dddddddd-dddd-dddd-dddd-dddddddddddd','cccccccc-cccc-cccc-cccc-cccccccccccc',1,'診間1',clock_timestamp(),array['腹部超音波'],'in_progress');
SQL
  fi
  if [[ "$migration" == *202610070002_session_room_count.sql ]]; then
    psql_local >/dev/null <<'SQL'
insert into auth.users(id) values('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
insert into public.health_sessions(id,session_date,company_name,created_by)
values('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',(clock_timestamp() at time zone 'Asia/Taipei')::date,'legacy room count','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
insert into public.participants(id,session_id,sequence_no,employee_no,full_name,schedule_slot,group_code,status,checkin_no,checked_in_at)
values('cccccccc-cccc-cccc-cccc-cccccccccccc','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',1,'legacy','Legacy','08:00','A','檢查中','A1',clock_timestamp());
insert into public.examinations(id,participant_id,round_no,room_id,started_at,selected_items,status)
values('dddddddd-dddd-dddd-dddd-dddddddddddd','cccccccc-cccc-cccc-cccc-cccccccccccc',1,'診間1',clock_timestamp(),array['腹部超音波'],'in_progress');
insert into public.rooms(session_id,room_id,status,updated_at)
values('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','診間 1','in_progress','2020-01-01T00:00:00Z'),
      ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','診間 2','away','2020-01-01T00:00:00Z'),
      ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','診間 5','idle','2020-01-02T00:00:00Z'),
      ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','診間5','away','2020-01-03T00:00:00Z'),
      ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','room_6','in_progress','2020-01-04T00:00:00Z');
insert into public.participants(id,session_id,sequence_no,employee_no,full_name,schedule_slot,group_code,status,checkin_no,checked_in_at)
values('cccccccc-cccc-cccc-cccc-cccccccccccd','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',2,'legacy5','Legacy5','08:00','A','檢查中','A2',clock_timestamp());
insert into public.examinations(id,participant_id,round_no,room_id,started_at,selected_items,status)
values('dddddddd-dddd-dddd-dddd-ddddddddddde','cccccccc-cccc-cccc-cccc-cccccccccccd',1,'room_5',clock_timestamp(),array['腹部超音波'],'in_progress');
SQL
  fi
  if [[ "$migration" == *202610070003_staff_page_permissions.sql ]]; then
    # These accounts existed before the migration. Preserve a completed visit
    # and a six-room historical session to prove the permission backfill does
    # not rewrite business or local-history data.
    psql_local >/dev/null <<'SQL'
insert into auth.users(id,email) values
  ('a0000000-0000-0000-0000-000000000001','legacy.staff@itri.example.com'),
  ('a0000000-0000-0000-0000-000000000002',null);
insert into public.health_sessions(id,session_date,company_name,created_by,room_count)
values('a1000000-0000-0000-0000-000000000001',(clock_timestamp() at time zone 'Asia/Taipei')::date-1,'permission legacy history','a0000000-0000-0000-0000-000000000001',6);
insert into public.participants(id,session_id,sequence_no,employee_no,full_name,schedule_slot,group_code,status,checkin_no,checked_in_at)
values('a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001',1,'historic','Historic','08:00','A','已完成','A1','2020-01-01T00:00:00Z');
insert into public.examinations(id,participant_id,round_no,room_id,started_at,completed_at,duration_seconds,selected_items,actual_items,item_count,status)
values('a3000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001',1,'診間 5','2020-01-01T00:00:00Z','2020-01-01T00:01:00Z',60,array['腹部超音波'],array['腹部超音波'],1,'completed');
create table auth.permission_history_snapshot as
select 'sessions' as kind,to_jsonb(s) as record from public.health_sessions s where s.id='a1000000-0000-0000-0000-000000000001'
union all select 'participants',to_jsonb(p) from public.participants p where p.id='a2000000-0000-0000-0000-000000000001'
union all select 'examinations',to_jsonb(e) from public.examinations e where e.id='a3000000-0000-0000-0000-000000000001';
SQL
  fi
  if [[ "$migration" == *202610070004_room_device_claim.sql ]]; then
    psql_local >/dev/null <<'SQL'
insert into public.health_sessions(id,session_date,company_name,created_by,room_count)
values('d2000000-0000-0000-0000-000000000001',(clock_timestamp() at time zone 'Asia/Taipei')::date,'pre-claim workflow','a0000000-0000-0000-0000-000000000001',3);
insert into public.participants(id,session_id,sequence_no,employee_no,full_name,schedule_slot,group_code,status,checkin_no,checked_in_at)
values('d3000000-0000-0000-0000-000000000001','d2000000-0000-0000-0000-000000000001',1,'1','Pre-claim examination','08:00','A','檢查中','A1',clock_timestamp());
insert into public.examinations(id,participant_id,round_no,room_id,started_at,selected_items,status)
values('d4000000-0000-0000-0000-000000000001','d3000000-0000-0000-0000-000000000001',1,'診間 1',clock_timestamp(),array['腹部超音波'],'in_progress');
update public.rooms set status=case room_id when '診間 1' then 'in_progress'::public.room_status when '診間 2' then 'away'::public.room_status else 'idle'::public.room_status end
where session_id='d2000000-0000-0000-0000-000000000001';
create table auth.claim_migration_room_snapshot as select session_id,room_id,to_jsonb(rooms) as record from public.rooms;
create table auth.claim_migration_examination_snapshot as select to_jsonb(examinations) as record from public.examinations where id='d4000000-0000-0000-0000-000000000001';
SQL
  fi
  psql_local < "$migration" > /dev/null
  if [[ "$migration" == *202610070004_room_device_claim.sql ]]; then
    psql_local >/dev/null <<'SQL'
do $$ begin
  if exists(select 1 from auth.claim_migration_room_snapshot old_room join public.rooms current_room using(session_id,room_id)
    where old_room.record is distinct from (to_jsonb(current_room)-array['claimed_by_device_id','claimed_by_user_id','claimed_at','claim_expires_at','claim_secret_hash'])) then
    raise exception 'claim migration changed legacy room state/timestamps';
  end if;
  if exists(select 1 from public.rooms where claimed_by_device_id is not null or claimed_by_user_id is not null or claim_expires_at is not null or claim_secret_hash is not null) then
    raise exception 'migration invented a legacy device claim';
  end if;
  if not exists(select 1 from public.examinations e join auth.claim_migration_examination_snapshot old_examination on old_examination.record=to_jsonb(e)
    where e.id='d4000000-0000-0000-0000-000000000001') then
    raise exception 'claim migration changed existing examination';
  end if;
end $$;
delete from public.health_sessions where id='d2000000-0000-0000-0000-000000000001';
SQL
    echo 'PASS: claim migration preserves existing idle/away/in-progress state and examinations'
  fi
  if [[ "$migration" == *202610070001_room_away.sql ]]; then
    psql_local >/dev/null <<'SQL'
do $$ begin
  if not exists(select 1 from public.rooms where session_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' and room_id='診間 1' and status='in_progress') then
    raise exception 'existing examination was not backfilled into canonical room';
  end if;
  if not exists(select 1 from public.examinations where id='dddddddd-dddd-dddd-dddd-dddddddddddd' and room_id='診間1' and selected_items=array['腹部超音波'] and status='in_progress') then
    raise exception 'backfill modified an existing examination';
  end if;
end $$;
delete from public.health_sessions where id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
delete from auth.users where id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
SQL
  fi
  if [[ "$migration" == *202610070002_session_room_count.sql ]]; then
    psql_local >/dev/null <<'SQL'
do $$ begin
  if not exists(select 1 from public.health_sessions where id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' and room_count=4) then raise exception 'legacy count did not become four'; end if;
  if (select count(*) from public.rooms where session_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')<>6 then raise exception 'backfill did not fill enabled rows or consolidate retained aliases'; end if;
  if not exists(select 1 from public.rooms where session_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' and room_id='診間 1' and status='in_progress') then raise exception 'backfill reset occupied state'; end if;
  if not exists(select 1 from public.rooms where session_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' and room_id='診間 2' and status='away') then raise exception 'backfill reset away state'; end if;
  if not exists(select 1 from public.examinations where id='dddddddd-dddd-dddd-dddd-dddddddddddd' and room_id='診間1' and selected_items=array['腹部超音波'] and status='in_progress') then raise exception 'count backfill modified examination history'; end if;
  if not exists(select 1 from public.rooms where session_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' and room_id='診間 5' and status='away') then raise exception 'alias merge lost away state'; end if;
  if not exists(select 1 from public.rooms where session_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' and room_id='診間 5' and updated_at='2020-01-03T00:00:00Z') then raise exception 'alias merge lost original latest timestamp'; end if;
  if not exists(select 1 from public.rooms where session_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' and room_id='診間 6' and status='in_progress') then raise exception 'alias merge lost occupied state'; end if;
  if exists(select 1 from public.rooms where session_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' and room_id in ('診間5','room_6')) then raise exception 'duplicate current-state alias keys were retained'; end if;
  if not exists(select 1 from public.examinations where id='dddddddd-dddd-dddd-dddd-ddddddddddde' and room_id='room_5') then raise exception 'alias merge changed examination history'; end if;
end $$;
set request.jwt.claim.sub='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
set role authenticated;
select public.update_session_room_count('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',6);
do $$ declare failed boolean := false; begin
  begin perform public.start_examination('cccccccc-cccc-cccc-cccc-cccccccccccc','room_5',array['腹部超音波']);
  exception when raise_exception then if sqlerrm<>'room_away' then raise; end if; failed:=true; end;
  if not failed then raise exception 'new canonical room bypassed old away alias'; end if;
  failed:=false;
  begin perform public.update_session_room_count('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',4);
  exception when raise_exception then if sqlerrm<>'room_count_away:診間 5' then raise; end if; failed:=true; end;
  if not failed then raise exception 'decrease bypassed old away alias'; end if;
  if (public.set_room_away('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','診間5',false)).status<>'in_progress' then raise exception 'return did not find old examination alias'; end if;
  failed:=false;
  begin perform public.update_session_room_count('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',4);
  exception when raise_exception then if sqlerrm<>'room_count_in_progress:診間 5' then raise; end if; failed:=true; end;
  if not failed then raise exception 'decrease bypassed old unfinished examination alias'; end if;
end $$;
reset role;
delete from public.health_sessions where id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
delete from auth.users where id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
SQL
  fi
  if [[ "$migration" == *202610070003_staff_page_permissions.sql ]]; then
    # Re-check in this migration's own phase: later migrations intentionally
    # replace/drop its RPC signatures. Preserve post-deploy account settings.
    psql_local >/dev/null <<'SQL'
insert into auth.users(id,email) values('a0000000-0000-0000-0000-000000000003','postmigration@itri.example.com');
update public.staff_permissions set display_name='Edited after deploy',can_room=true,is_active=false
where user_id='a0000000-0000-0000-0000-000000000003';
SQL
    psql_local < "$migration" >/dev/null
    psql_local >/dev/null <<'SQL'
do $$ begin
  if not exists(select 1 from public.staff_permissions where user_id='a0000000-0000-0000-0000-000000000003'
    and display_name='Edited after deploy' and not can_registration and not can_console and can_room and not is_active) then
    raise exception 'repeat migration overwrote existing permissions';
  end if;
end $$;
SQL
    echo 'PASS: repeated permission migration preserves post-deploy account settings'
  fi
done
for room_test_sql in supabase/tests/room_device_claim.sql supabase/tests/staff_page_permissions.sql supabase/tests/room_away.sql supabase/tests/session_room_count.sql; do
  if ! psql_local < "$room_test_sql" > "$room_test_work/$(basename "$room_test_sql").log" 2>&1; then
    cat "$room_test_work/$(basename "$room_test_sql").log" >&2
    exit 1
  fi
  rg '^PASS:' "$room_test_work/$(basename "$room_test_sql").log"
done

# Exercise true database contention using independent psql connections. The
# first transaction holds the room mutex; the racing start must wait and then
# observe away rather than create an examination from an earlier availability.
psql_local >/dev/null <<'SQL'
insert into auth.users(id) values('11111111-1111-1111-1111-111111111111');
update public.staff_permissions set can_registration=true,can_console=true,can_room=true where user_id='11111111-1111-1111-1111-111111111111';
insert into public.health_sessions(id, session_date, company_name, created_by)
values('22222222-2222-2222-2222-222222222222', (clock_timestamp() at time zone 'Asia/Taipei')::date, 'room concurrency test', '11111111-1111-1111-1111-111111111111');
insert into public.participants(id,session_id,sequence_no,employee_no,full_name,schedule_slot,group_code,status,checkin_no,checked_in_at)
values('33333333-3333-3333-3333-333333333331','22222222-2222-2222-2222-222222222222',1,'1','A','08:00','A','等候中','A1',clock_timestamp()),
      ('33333333-3333-3333-3333-333333333332','22222222-2222-2222-2222-222222222222',2,'2','B','08:00','A','等候中','A2',clock_timestamp());
SQL
psql_local >/dev/null <<'SQL'
set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
set role authenticated;
select public.claim_room('22222222-2222-2222-2222-222222222222','診間1','10111111-1111-1111-1111-111111111111',repeat('c',64));
SQL
cat > "$room_test_work/away-first.sql" <<'SQL'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set role authenticated;
begin;
select public.set_room_away('22222222-2222-2222-2222-222222222222','診間 1',true,'10111111-1111-1111-1111-111111111111',repeat('c',64));
\echo ROOM_LOCK_HELD
select pg_sleep(2);
commit;
SQL
psql_local < "$room_test_work/away-first.sql" > "$room_test_work/away-first.log" 2>&1 &
room_away_pid=$!
for attempt in {1..50}; do
  if rg -q 'ROOM_LOCK_HELD' "$room_test_work/away-first.log"; then break; fi
  sleep 0.1
done
rg -q 'ROOM_LOCK_HELD' "$room_test_work/away-first.log"
if psql_local > "$room_test_work/start-blocked.log" 2>&1 <<'SQL'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set role authenticated;
select public.start_examination('33333333-3333-3333-3333-333333333331','診間1',array['腹部超音波'],'10111111-1111-1111-1111-111111111111',repeat('c',64));
SQL
then
  echo 'FAIL: a concurrent start bypassed an away transition' >&2
  exit 1
fi
wait "$room_away_pid"
if ! rg -q 'room_away' "$room_test_work/start-blocked.log"; then
  cat "$room_test_work/start-blocked.log" >&2
  exit 1
fi
psql_local >/dev/null <<'SQL'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set role authenticated;
select public.set_room_away('22222222-2222-2222-2222-222222222222','診間 1',false,'10111111-1111-1111-1111-111111111111',repeat('c',64));
SQL

# Two distinct participants competing for one room: exactly one start commits.
cat > "$room_test_work/start-first.sql" <<'SQL'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set role authenticated;
begin;
select public.start_examination('33333333-3333-3333-3333-333333333331','診間 1',array['腹部超音波'],'10111111-1111-1111-1111-111111111111',repeat('c',64));
\echo ROOM_LOCK_HELD
select pg_sleep(2);
commit;
SQL
psql_local < "$room_test_work/start-first.sql" > "$room_test_work/start-first.log" 2>&1 &
room_start_pid=$!
for attempt in {1..50}; do
  if rg -q 'ROOM_LOCK_HELD' "$room_test_work/start-first.log"; then break; fi
  sleep 0.1
done
rg -q 'ROOM_LOCK_HELD' "$room_test_work/start-first.log"
if psql_local > "$room_test_work/occupied.log" 2>&1 <<'SQL'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set role authenticated;
select public.start_examination('33333333-3333-3333-3333-333333333332','診間1',array['腹部超音波'],'10111111-1111-1111-1111-111111111111',repeat('c',64));
SQL
then
  echo 'FAIL: two concurrent participants started in one room' >&2
  exit 1
fi
wait "$room_start_pid"
if ! rg -q 'room_occupied' "$room_test_work/occupied.log"; then
  cat "$room_test_work/occupied.log" >&2
  exit 1
fi
psql_local >/dev/null <<'SQL'
do $$ begin
  if (select count(*) from public.examinations e join public.participants p on p.id=e.participant_id where p.session_id='22222222-2222-2222-2222-222222222222' and e.status='in_progress') <> 1 then
    raise exception 'unexpected concurrency result';
  end if;
end $$;
SQL

# Closing the session takes its lock before cascading participant deletion.
# A start racing closure must follow the same order and fail without deadlock.
cat > "$room_test_work/close-first.sql" <<'SQL'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set role authenticated;
begin;
select public.close_health_session('22222222-2222-2222-2222-222222222222');
\echo SESSION_LOCK_HELD
select pg_sleep(2);
commit;
SQL
psql_local < "$room_test_work/close-first.sql" > "$room_test_work/close-first.log" 2>&1 &
room_close_pid=$!
for attempt in {1..50}; do
  if rg -q 'SESSION_LOCK_HELD' "$room_test_work/close-first.log"; then break; fi
  sleep 0.1
done
rg -q 'SESSION_LOCK_HELD' "$room_test_work/close-first.log"
if psql_local > "$room_test_work/closed.log" 2>&1 <<'SQL'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set role authenticated;
set statement_timeout = '10s';
select public.start_examination('33333333-3333-3333-3333-333333333332','診間 1',array['腹部超音波'],'10111111-1111-1111-1111-111111111111',repeat('c',64));
SQL
then
  echo 'FAIL: a concurrent start bypassed session closure' >&2
  exit 1
fi
wait "$room_close_pid"
if ! rg -q 'not_today_session' "$room_test_work/closed.log"; then
  cat "$room_test_work/closed.log" >&2
  exit 1
fi
echo 'PASS: room absence SQL, room counts, backfill, cascade deletion, permissions, additional rounds, and three existing concurrency races'

# Count changes take the session lock before inspecting room rows. Test both
# orders with independent connections: start first rejects the shrink; shrink
# first makes the waiting start observe the new count, rather than stale data.
psql_local >/dev/null <<'SQL'
insert into public.health_sessions(id,session_date,company_name,created_by,room_count)
values('22222222-2222-2222-2222-222222222225',(clock_timestamp() at time zone 'Asia/Taipei')::date,'count concurrency test','11111111-1111-1111-1111-111111111111',6);
insert into public.participants(id,session_id,sequence_no,employee_no,full_name,schedule_slot,group_code,status,checkin_no,checked_in_at)
values('33333333-3333-3333-3333-333333333335','22222222-2222-2222-2222-222222222225',1,'5','E','08:00','A','等候中','A1',clock_timestamp());
SQL
psql_local >/dev/null <<'SQL'
set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
set role authenticated;
select public.claim_room('22222222-2222-2222-2222-222222222225','診間5','10555555-5555-5555-5555-555555555555',repeat('c',64));
SQL
cat > "$room_test_work/count-start-first.sql" <<'SQL'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set role authenticated;
begin;
select public.start_examination('33333333-3333-3333-3333-333333333335','診間 5',array['腹部超音波'],'10555555-5555-5555-5555-555555555555',repeat('c',64));
\echo SESSION_SHARE_HELD
select pg_sleep(2);
commit;
SQL
psql_local < "$room_test_work/count-start-first.sql" > "$room_test_work/count-start-first.log" 2>&1 &
room_count_start_pid=$!
for attempt in {1..50}; do
  if rg -q 'SESSION_SHARE_HELD' "$room_test_work/count-start-first.log"; then break; fi
  sleep 0.1
done
rg -q 'SESSION_SHARE_HELD' "$room_test_work/count-start-first.log"
if psql_local > "$room_test_work/count-shrink-blocked.log" 2>&1 <<'SQL'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set role authenticated;
set statement_timeout = '10s';
select public.update_session_room_count('22222222-2222-2222-2222-222222222225',4);
SQL
then echo 'FAIL: a shrink bypassed a concurrent examination start' >&2; exit 1; fi
wait "$room_count_start_pid"
if ! rg -q 'room_count_in_progress:診間 5' "$room_test_work/count-shrink-blocked.log"; then cat "$room_test_work/count-shrink-blocked.log" >&2; exit 1; fi
psql_local >/dev/null <<'SQL'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set role authenticated;
select public.complete_examination((select id from public.examinations where participant_id='33333333-3333-3333-3333-333333333335'),'診間 5',array['腹部超音波'],'10555555-5555-5555-5555-555555555555',repeat('c',64));
SQL

psql_local >/dev/null <<'SQL'
set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
set role authenticated;
select public.release_room_claim('22222222-2222-2222-2222-222222222225','診間5','10555555-5555-5555-5555-555555555555',repeat('c',64));
SQL
cat > "$room_test_work/count-shrink-first.sql" <<'SQL'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set role authenticated;
begin;
select public.update_session_room_count('22222222-2222-2222-2222-222222222225',4);
\echo SESSION_EXCLUSIVE_HELD
select pg_sleep(2);
commit;
SQL
psql_local < "$room_test_work/count-shrink-first.sql" > "$room_test_work/count-shrink-first.log" 2>&1 &
room_count_shrink_pid=$!
for attempt in {1..50}; do
  if rg -q 'SESSION_EXCLUSIVE_HELD' "$room_test_work/count-shrink-first.log"; then break; fi
  sleep 0.1
done
rg -q 'SESSION_EXCLUSIVE_HELD' "$room_test_work/count-shrink-first.log"
if psql_local > "$room_test_work/count-start-blocked.log" 2>&1 <<'SQL'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set role authenticated;
set statement_timeout = '10s';
select public.start_examination('33333333-3333-3333-3333-333333333335','診間5',array['腹部超音波'],'10555555-5555-5555-5555-555555555555',repeat('c',64));
SQL
then echo 'FAIL: a start bypassed a concurrent safe decrease' >&2; exit 1; fi
wait "$room_count_shrink_pid"
if ! rg -q 'invalid_room' "$room_test_work/count-start-blocked.log"; then cat "$room_test_work/count-start-blocked.log" >&2; exit 1; fi
psql_local >/dev/null <<'SQL'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set role authenticated;
select public.update_session_room_count('22222222-2222-2222-2222-222222222225',6);
SQL

psql_local >/dev/null <<'SQL'
set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
set role authenticated;
select public.claim_room('22222222-2222-2222-2222-222222222225','診間6','10666666-6666-6666-6666-666666666666',repeat('c',64));
SQL
cat > "$room_test_work/count-away-first.sql" <<'SQL'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set role authenticated;
begin;
select public.set_room_away('22222222-2222-2222-2222-222222222225','診間 6',true,'10666666-6666-6666-6666-666666666666',repeat('c',64));
\echo SESSION_SHARE_HELD
select pg_sleep(2);
commit;
SQL
psql_local < "$room_test_work/count-away-first.sql" > "$room_test_work/count-away-first.log" 2>&1 &
room_count_away_pid=$!
for attempt in {1..50}; do
  if rg -q 'SESSION_SHARE_HELD' "$room_test_work/count-away-first.log"; then break; fi
  sleep 0.1
done
rg -q 'SESSION_SHARE_HELD' "$room_test_work/count-away-first.log"
if psql_local > "$room_test_work/count-away-blocked.log" 2>&1 <<'SQL'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set role authenticated;
set statement_timeout = '10s';
select public.update_session_room_count('22222222-2222-2222-2222-222222222225',4);
SQL
then echo 'FAIL: a shrink bypassed concurrent temporary absence' >&2; exit 1; fi
wait "$room_count_away_pid"
if ! rg -q 'room_count_away:診間 6' "$room_test_work/count-away-blocked.log"; then cat "$room_test_work/count-away-blocked.log" >&2; exit 1; fi
psql_local >/dev/null <<'SQL'
do $$ begin
  if not exists(select 1 from public.health_sessions where id='22222222-2222-2222-2222-222222222225' and room_count=6) then raise exception 'concurrent rejected shrink modified count'; end if;
  if (select count(*) from public.rooms where session_id='22222222-2222-2222-2222-222222222225')<>6 then raise exception 'count race removed retained room rows'; end if;
end $$;
SQL
echo 'PASS: start -> shrink, shrink -> start, and away -> shrink concurrency races'

# Two browsers using the SAME Auth account compete through independent psql
# connections. UUID equality/account equality never substitutes for the secret.
psql_local >/dev/null <<'SQL'
insert into public.health_sessions(id,session_date,company_name,created_by,room_count)
values('22222222-2222-2222-2222-222222222227',(clock_timestamp() at time zone 'Asia/Taipei')::date,'device claim contention','11111111-1111-1111-1111-111111111111',3);
insert into public.participants(id,session_id,sequence_no,employee_no,full_name,schedule_slot,group_code,status,checkin_no,checked_in_at)
values('33333333-3333-3333-3333-333333333337','22222222-2222-2222-2222-222222222227',1,'7','Claim race','08:00','A','等候中','A1',clock_timestamp());
SQL
cat > "$room_test_work/claim-first.sql" <<'SQL'
set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
set role authenticated;
begin;
select public.claim_room('22222222-2222-2222-2222-222222222227','診間1','10777777-7777-7777-7777-777777777771',repeat('a',64));
\echo CLAIM_LOCK_HELD
select pg_sleep(2);
commit;
SQL
psql_local < "$room_test_work/claim-first.sql" > "$room_test_work/claim-first.log" 2>&1 &
claim_first_pid=$!
for attempt in {1..50}; do
  if rg -q 'CLAIM_LOCK_HELD' "$room_test_work/claim-first.log"; then break; fi
  sleep 0.1
done
rg -q 'CLAIM_LOCK_HELD' "$room_test_work/claim-first.log"
if psql_local > "$room_test_work/claim-second.log" 2>&1 <<'SQL'
set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
set role authenticated;
set statement_timeout='10s';
select public.claim_room('22222222-2222-2222-2222-222222222227','診間1','10777777-7777-7777-7777-777777777772',repeat('b',64));
SQL
then echo 'FAIL: concurrent browsers both claimed one room' >&2; exit 1; fi
wait "$claim_first_pid"
if ! rg -q 'room_claimed' "$room_test_work/claim-second.log"; then cat "$room_test_work/claim-second.log" >&2; exit 1; fi
psql_local >/dev/null <<'SQL'
do $$ begin
  if not exists(select 1 from public.rooms where session_id='22222222-2222-2222-2222-222222222227' and room_id='診間 1'
    and claimed_by_device_id='10777777-7777-7777-7777-777777777771' and claim_expires_at>clock_timestamp()) then
    raise exception 'claim race did not preserve exactly one winner';
  end if;
end $$;
update public.rooms set claimed_at=clock_timestamp()-interval '181 seconds',claim_expires_at=clock_timestamp()-interval '1 second'
where session_id='22222222-2222-2222-2222-222222222227' and room_id='診間 1';
SQL

# A takeover that obtains the mutex first prevents the former owner from
# starting an examination using its earlier (now expired) device credential.
cat > "$room_test_work/takeover-first.sql" <<'SQL'
set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
set role authenticated;
begin;
select public.claim_room('22222222-2222-2222-2222-222222222227','診間1','10777777-7777-7777-7777-777777777772',repeat('b',64));
\echo CLAIM_LOCK_HELD
select pg_sleep(2);
commit;
SQL
psql_local < "$room_test_work/takeover-first.sql" > "$room_test_work/takeover-first.log" 2>&1 &
claim_takeover_pid=$!
for attempt in {1..50}; do
  if rg -q 'CLAIM_LOCK_HELD' "$room_test_work/takeover-first.log"; then break; fi
  sleep 0.1
done
rg -q 'CLAIM_LOCK_HELD' "$room_test_work/takeover-first.log"
if psql_local > "$room_test_work/takeover-old-start.log" 2>&1 <<'SQL'
set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
set role authenticated;
set statement_timeout='10s';
select public.start_examination('33333333-3333-3333-3333-333333333337','診間1',array['腹部超音波'],'10777777-7777-7777-7777-777777777771',repeat('a',64));
SQL
then echo 'FAIL: stale device started after concurrent takeover' >&2; exit 1; fi
wait "$claim_takeover_pid"
if ! rg -q 'room_claim_lost' "$room_test_work/takeover-old-start.log"; then cat "$room_test_work/takeover-old-start.log" >&2; exit 1; fi
psql_local >/dev/null <<'SQL'
do $$ begin
  if exists(select 1 from public.examinations where participant_id='33333333-3333-3333-3333-333333333337') then
    raise exception 'stale concurrent start left an examination';
  end if;
end $$;
set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
set role authenticated;
select public.release_room_claim('22222222-2222-2222-2222-222222222227','診間1','10777777-7777-7777-7777-777777777772',repeat('b',64));
select public.claim_room('22222222-2222-2222-2222-222222222227','診間1','10777777-7777-7777-7777-777777777771',repeat('a',64));
reset role;
update public.rooms set claim_expires_at=clock_timestamp()+interval '1 second'
where session_id='22222222-2222-2222-2222-222222222227' and room_id='診間 1';
SQL

# The reverse order: a valid owner starts first and holds the room mutex while
# its short synthetic lease expires. The waiting takeover must re-read time
# and ownership AFTER the lock, retain the visit, and deny its former operator.
cat > "$room_test_work/operation-first.sql" <<'SQL'
set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
set role authenticated;
begin;
select public.start_examination('33333333-3333-3333-3333-333333333337','診間1',array['腹部超音波'],'10777777-7777-7777-7777-777777777771',repeat('a',64));
\echo CLAIM_LOCK_HELD
select pg_sleep(2);
commit;
SQL
psql_local < "$room_test_work/operation-first.sql" > "$room_test_work/operation-first.log" 2>&1 &
claim_operation_pid=$!
for attempt in {1..50}; do
  if rg -q 'CLAIM_LOCK_HELD' "$room_test_work/operation-first.log"; then break; fi
  sleep 0.1
done
rg -q 'CLAIM_LOCK_HELD' "$room_test_work/operation-first.log"
if ! psql_local > "$room_test_work/operation-takeover.log" 2>&1 <<'SQL'
set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
set role authenticated;
set statement_timeout='10s';
select public.claim_room('22222222-2222-2222-2222-222222222227','診間1','10777777-7777-7777-7777-777777777772',repeat('b',64));
SQL
then cat "$room_test_work/operation-takeover.log" >&2; exit 1; fi
wait "$claim_operation_pid"
if psql_local > "$room_test_work/operation-stale-complete.log" 2>&1 <<'SQL'
set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
set role authenticated;
select public.complete_examination((select id from public.examinations where participant_id='33333333-3333-3333-3333-333333333337'),'診間1',array['腹部超音波'],'10777777-7777-7777-7777-777777777771',repeat('a',64));
SQL
then echo 'FAIL: former owner completed after takeover won the mutex' >&2; exit 1; fi
if ! rg -q 'room_claim_lost' "$room_test_work/operation-stale-complete.log"; then cat "$room_test_work/operation-stale-complete.log" >&2; exit 1; fi
psql_local >/dev/null <<'SQL'
set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
set role authenticated;
select public.complete_examination((select id from public.examinations where participant_id='33333333-3333-3333-3333-333333333337'),'診間1',array['腹部超音波'],'10777777-7777-7777-7777-777777777772',repeat('b',64));
reset role;
do $$ begin
  if (select count(*) from public.examinations where participant_id='33333333-3333-3333-3333-333333333337' and status='completed')<>1 then
    raise exception 'takeover lost/duplicated the retained examination';
  end if;
end $$;
SQL
echo 'PASS: same-account claim -> claim, takeover -> stale start, and start -> expiry/takeover races'

# A heartbeat arriving before expiry extends the lease atomically. A competing
# browser waiting behind that renewal must observe the new expiry and fail.
psql_local >/dev/null <<'SQL'
update public.rooms set claim_expires_at=clock_timestamp()+interval '1 second'
where session_id='22222222-2222-2222-2222-222222222227' and room_id='診間 1';
SQL
cat > "$room_test_work/heartbeat-first.sql" <<'SQL'
set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
set role authenticated;
begin;
select public.heartbeat_room_claim('22222222-2222-2222-2222-222222222227','診間1','10777777-7777-7777-7777-777777777772',repeat('b',64));
\echo CLAIM_LOCK_HELD
select pg_sleep(2);
commit;
SQL
psql_local < "$room_test_work/heartbeat-first.sql" > "$room_test_work/heartbeat-first.log" 2>&1 &
claim_heartbeat_pid=$!
for attempt in {1..50}; do
  if rg -q 'CLAIM_LOCK_HELD' "$room_test_work/heartbeat-first.log"; then break; fi
  sleep 0.1
done
rg -q 'CLAIM_LOCK_HELD' "$room_test_work/heartbeat-first.log"
if psql_local > "$room_test_work/heartbeat-competing-claim.log" 2>&1 <<'SQL'
set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
set role authenticated;
set statement_timeout='10s';
select public.claim_room('22222222-2222-2222-2222-222222222227','診間1','10777777-7777-7777-7777-777777777771',repeat('a',64));
SQL
then echo 'FAIL: competing claim bypassed concurrent heartbeat renewal' >&2; exit 1; fi
wait "$claim_heartbeat_pid"
if ! rg -q 'room_claimed' "$room_test_work/heartbeat-competing-claim.log"; then cat "$room_test_work/heartbeat-competing-claim.log" >&2; exit 1; fi
psql_local >/dev/null <<'SQL'
do $$ begin
  if not exists(select 1 from public.rooms where session_id='22222222-2222-2222-2222-222222222227' and room_id='診間 1'
    and claimed_by_device_id='10777777-7777-7777-7777-777777777772' and claim_expires_at>clock_timestamp()+interval '170 seconds') then
    raise exception 'concurrent heartbeat did not preserve renewing device';
  end if;
end $$;
SQL
echo 'PASS: heartbeat renewal -> competing takeover concurrency race'
