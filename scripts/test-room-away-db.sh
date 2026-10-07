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
create schema auth;
create table auth.users (id uuid primary key);
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
  psql_local < "$migration" > /dev/null
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
done
psql_local < supabase/tests/room_away.sql

# Exercise true database contention using independent psql connections. The
# first transaction holds the room mutex; the racing start must wait and then
# observe away rather than create an examination from an earlier availability.
psql_local >/dev/null <<'SQL'
insert into auth.users(id) values('11111111-1111-1111-1111-111111111111');
insert into public.health_sessions(id, session_date, company_name, created_by)
values('22222222-2222-2222-2222-222222222222', (clock_timestamp() at time zone 'Asia/Taipei')::date, 'room concurrency test', '11111111-1111-1111-1111-111111111111');
insert into public.participants(id,session_id,sequence_no,employee_no,full_name,schedule_slot,group_code,status,checkin_no,checked_in_at)
values('33333333-3333-3333-3333-333333333331','22222222-2222-2222-2222-222222222222',1,'1','A','08:00','A','等候中','A1',clock_timestamp()),
      ('33333333-3333-3333-3333-333333333332','22222222-2222-2222-2222-222222222222',2,'2','B','08:00','A','等候中','A2',clock_timestamp());
SQL
cat > "$room_test_work/away-first.sql" <<'SQL'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set role authenticated;
begin;
select public.set_room_away('22222222-2222-2222-2222-222222222222','診間 1',true);
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
select public.start_examination('33333333-3333-3333-3333-333333333331','診間1',array['腹部超音波']);
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
select public.set_room_away('22222222-2222-2222-2222-222222222222','診間 1',false);
SQL

# Two distinct participants competing for one room: exactly one start commits.
cat > "$room_test_work/start-first.sql" <<'SQL'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set role authenticated;
begin;
select public.start_examination('33333333-3333-3333-3333-333333333331','診間 1',array['腹部超音波']);
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
select public.start_examination('33333333-3333-3333-3333-333333333332','診間1',array['腹部超音波']);
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
  if (select count(*) from public.examinations where status='in_progress') <> 1 then
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
select public.start_examination('33333333-3333-3333-3333-333333333332','診間 1',array['腹部超音波']);
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
echo 'PASS: room absence SQL, backfill, cascade deletion, permissions, additional rounds, and three concurrency races'
