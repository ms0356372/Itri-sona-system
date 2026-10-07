-- Exercise production constraints/triggers/RPCs with the authenticated staff
-- role. The runner provides a disposable local Postgres; fixtures roll back.
begin;
insert into auth.users(id) values ('41111111-1111-1111-1111-111111111111');
update public.staff_permissions set can_registration=true,can_console=true,can_room=true where user_id='41111111-1111-1111-1111-111111111111';
create function pg_temp.assert_room_count(p_ok boolean, p_message text)
returns void language plpgsql as $$ begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_message; end if;
end $$;
create function pg_temp.expect_room_count_error(p_sql text, p_error text)
returns void language plpgsql as $$
declare rejected boolean := false;
begin
  begin execute p_sql;
  exception when raise_exception or insufficient_privilege then
    if sqlerrm <> p_error then raise; end if;
    rejected := true;
  end;
  if not rejected then raise exception 'FAIL: expected % for %', p_error, p_sql; end if;
end $$;

set local request.jwt.claim.sub = '41111111-1111-1111-1111-111111111111';
insert into public.health_sessions(id,session_date,company_name,created_by)
values ('42222222-2222-2222-2222-222222222224',(clock_timestamp() at time zone 'Asia/Taipei')::date,'default four rooms','41111111-1111-1111-1111-111111111111');
insert into public.health_sessions(id,session_date,company_name,created_by,room_count)
values ('42222222-2222-2222-2222-222222222221',(clock_timestamp() at time zone 'Asia/Taipei')::date,'one room','41111111-1111-1111-1111-111111111111',1),
       ('42222222-2222-2222-2222-222222222222',(clock_timestamp() at time zone 'Asia/Taipei')::date,'two rooms','41111111-1111-1111-1111-111111111111',2),
       ('42222222-2222-2222-2222-222222222223',(clock_timestamp() at time zone 'Asia/Taipei')::date,'three rooms','41111111-1111-1111-1111-111111111111',3),
       ('42222222-2222-2222-2222-222222222226',(clock_timestamp() at time zone 'Asia/Taipei')::date,'six rooms','41111111-1111-1111-1111-111111111111',6),
       ('42222222-2222-2222-2222-222222222228',(clock_timestamp() at time zone 'Asia/Taipei')::date,'eight rooms','41111111-1111-1111-1111-111111111111',8),
       ('42222222-2222-2222-2222-222222222229',(clock_timestamp() at time zone 'Asia/Taipei')::date+1,'future rooms','41111111-1111-1111-1111-111111111111',4),
       ('42222222-2222-2222-2222-222222222220',(clock_timestamp() at time zone 'Asia/Taipei')::date-1,'historical six rooms','41111111-1111-1111-1111-111111111111',6);
-- Closed-session and checked-in fixtures are administrative data, not client
-- schedule writes. Production clients use the close/check-in RPCs instead.
insert into public.health_sessions(id,session_date,company_name,created_by,room_count,status)
values ('42222222-2222-2222-2222-222222222227',(clock_timestamp() at time zone 'Asia/Taipei')::date,'closed eight rooms','41111111-1111-1111-1111-111111111111',8,'closed');
insert into public.participants(id,session_id,sequence_no,employee_no,full_name,schedule_slot,group_code,status,checkin_no,checked_in_at)
values ('43333333-3333-3333-3333-333333333331','42222222-2222-2222-2222-222222222224',1,'1','A','08:00','A','等候中','A1',clock_timestamp()),
       ('43333333-3333-3333-3333-333333333332','42222222-2222-2222-2222-222222222226',1,'2','B','08:00','A','等候中','A1',clock_timestamp()),
       ('43333333-3333-3333-3333-333333333333','42222222-2222-2222-2222-222222222223',1,'3','C','08:00','A','等候中','A1',clock_timestamp());
set local role authenticated;

select pg_temp.assert_room_count(not has_table_privilege(current_user,'public.rooms','INSERT,UPDATE,DELETE'), 'room writes remain RPC-only');
select pg_temp.assert_room_count(not has_function_privilege('anon','public.update_session_room_count(uuid,integer)','EXECUTE'), 'anonymous count updates denied');
select pg_temp.assert_room_count((select room_count=4 from public.health_sessions where id='42222222-2222-2222-2222-222222222224'), 'default count is four');
select pg_temp.assert_room_count(not exists (
  select 1 from public.health_sessions sessions
  where sessions.created_by='41111111-1111-1111-1111-111111111111'
    and sessions.room_count<>(select count(*) from public.rooms where session_id=sessions.id and status='idle')
), 'each new session initializes exactly its configured rooms');
select pg_temp.expect_room_count_error($sql$
  insert into public.health_sessions(session_date,company_name,created_by,room_count)
  values ((clock_timestamp() at time zone 'Asia/Taipei')::date,'invalid zero','41111111-1111-1111-1111-111111111111',0)
$sql$,'invalid_room_count');
select pg_temp.expect_room_count_error($sql$
  insert into public.health_sessions(session_date,company_name,created_by,room_count)
  values ((clock_timestamp() at time zone 'Asia/Taipei')::date,'invalid nine','41111111-1111-1111-1111-111111111111',9)
$sql$,'invalid_room_count');
select pg_temp.expect_room_count_error($sql$
  insert into public.health_sessions(session_date,company_name,created_by,room_count)
  values ((clock_timestamp() at time zone 'Asia/Taipei')::date,'invalid null','41111111-1111-1111-1111-111111111111',null)
$sql$,'invalid_room_count');
select pg_temp.expect_room_count_error($sql$select public.update_session_room_count('42222222-2222-2222-2222-222222222224',0)$sql$,'invalid_room_count');
select pg_temp.expect_room_count_error($sql$select public.update_session_room_count('42222222-2222-2222-2222-222222222224',9)$sql$,'invalid_room_count');

-- Increasing adds only missing rows and preserves away, occupied and timestamps.
select public.set_room_away('42222222-2222-2222-2222-222222222224','診間2',true);
create temporary table room_before_increase as select * from public.rooms where session_id='42222222-2222-2222-2222-222222222224';
select public.update_session_room_count('42222222-2222-2222-2222-222222222224',6);
select pg_temp.assert_room_count(not exists (
  select 1 from room_before_increase old_room
  join public.rooms current_room using (session_id,room_id)
  where old_room.status<>current_room.status or old_room.updated_at<>current_room.updated_at
), 'increasing preserves all existing room status and update timestamps');
select pg_temp.assert_room_count((select count(*)=2 from public.rooms where session_id='42222222-2222-2222-2222-222222222224' and room_id in ('診間 5','診間 6') and status='idle'), 'increase initializes five and six');
select public.update_session_room_count('42222222-2222-2222-2222-222222222224',6);
select pg_temp.assert_room_count((select count(*)=6 from public.rooms where session_id='42222222-2222-2222-2222-222222222224'), 'retry cannot create duplicate rooms');

-- Safe decreases retain history rows. Older devices cannot reactivate them.
select public.update_session_room_count('42222222-2222-2222-2222-222222222224',4);
select pg_temp.assert_room_count((select count(*)=6 from public.rooms where session_id='42222222-2222-2222-2222-222222222224'), 'decrease keeps retained room rows');
select pg_temp.expect_room_count_error($sql$select public.set_room_away('42222222-2222-2222-2222-222222222224','診間5',true)$sql$,'invalid_room');
select pg_temp.expect_room_count_error($sql$select public.start_examination('43333333-3333-3333-3333-333333333331','診間 5',array['腹部超音波'])$sql$,'invalid_room');
select pg_temp.expect_room_count_error($sql$select public.set_room_away('42222222-2222-2222-2222-222222222224','room_5',true)$sql$,'invalid_room');
select pg_temp.expect_room_count_error($sql$select public.start_examination('43333333-3333-3333-3333-333333333333','診間 4',array['腹部超音波'])$sql$,'invalid_room');
select pg_temp.expect_room_count_error($sql$select public.set_room_away('42222222-2222-2222-2222-222222222228','anything',true)$sql$,'invalid_room');
select pg_temp.expect_room_count_error($sql$select public.set_room_away('42222222-2222-2222-2222-222222222228','診間 9',true)$sql$,'invalid_room');
select pg_temp.expect_room_count_error($sql$select public.start_examination('43333333-3333-3333-3333-333333333331','診間2',array['腹部超音波'])$sql$,'room_away');

-- A removed occupied/away room is rejected transactionally. Clients cannot
-- write room_count directly; its guard also protects administrator updates.
select public.update_session_room_count('42222222-2222-2222-2222-222222222224',6);
select public.start_examination('43333333-3333-3333-3333-333333333331','room_5',array['腹部超音波']);
select public.update_session_room_count('42222222-2222-2222-2222-222222222224',8);
select pg_temp.assert_room_count((select status='in_progress' from public.rooms where session_id='42222222-2222-2222-2222-222222222224' and room_id='診間 5'), 'increase after starting retains occupied status');
select pg_temp.assert_room_count((select status='away' from public.rooms where session_id='42222222-2222-2222-2222-222222222224' and room_id='診間 2'), 'increase after starting retains away status');
select public.update_session_room_count('42222222-2222-2222-2222-222222222224',6);
select pg_temp.expect_room_count_error($sql$select public.update_session_room_count('42222222-2222-2222-2222-222222222224',4)$sql$,'room_count_in_progress:診間 5');
select pg_temp.expect_room_count_error($sql$update public.health_sessions set room_count=4 where id='42222222-2222-2222-2222-222222222224'$sql$,'permission denied for table health_sessions');
reset role;
select pg_temp.expect_room_count_error($sql$update public.health_sessions set room_count=4 where id='42222222-2222-2222-2222-222222222224'$sql$,'room_count_in_progress:診間 5');
set local role authenticated;
select pg_temp.assert_room_count((select room_count=6 from public.health_sessions where id='42222222-2222-2222-2222-222222222224'), 'failed shrink does not change count');
select public.set_room_away('42222222-2222-2222-2222-222222222224','診間5',true);
select pg_temp.expect_room_count_error($sql$select public.update_session_room_count('42222222-2222-2222-2222-222222222224',4)$sql$,'room_count_away:診間 5');
select public.set_room_away('42222222-2222-2222-2222-222222222224','診間5',false);
create temporary table completed_history as
select (public.complete_examination((select id from public.examinations where participant_id='43333333-3333-3333-3333-333333333331'),'診間5',array['腹部超音波'])).*;
select public.update_session_room_count('42222222-2222-2222-2222-222222222224',4);
select pg_temp.assert_room_count((select count(*)=1 from public.examinations where participant_id='43333333-3333-3333-3333-333333333331' and room_id='診間 5' and status='completed'), 'decrease preserves completed examination history');
select pg_temp.assert_room_count(
  public.complete_examination((select id from completed_history),'診間5',array['腹部超音波'])=(select row(examinations.*)::public.examinations from public.examinations where id=(select id from completed_history)),
  'completed examination retry remains read-only for a retained inactive room'
);

-- Defense in depth: unfinished examinations prevent a shrink even if an old
-- administrator/device left the availability row incorrectly marked idle.
select public.start_examination('43333333-3333-3333-3333-333333333332','診間6',array['腹部超音波']);
reset role;
update public.rooms set status='idle' where session_id='42222222-2222-2222-2222-222222222226' and room_id='診間 6';
update public.rooms set status='in_progress' where session_id='42222222-2222-2222-2222-222222222223' and room_id='診間 2';
set local role authenticated;
select pg_temp.expect_room_count_error($sql$select public.start_examination('43333333-3333-3333-3333-333333333333','診間2',array['腹部超音波'])$sql$,'room_occupied');
select pg_temp.expect_room_count_error($sql$select public.update_session_room_count('42222222-2222-2222-2222-222222222226',4)$sql$,'room_count_unfinished:診間 6');
select pg_temp.assert_room_count((select room_count=6 from public.health_sessions where id='42222222-2222-2222-2222-222222222226'), 'unfinished examination keeps old count');

-- Future editing works, while past/closed sessions retain their recorded count.
select public.update_session_room_count('42222222-2222-2222-2222-222222222229',2);
select pg_temp.expect_room_count_error($sql$select public.update_session_room_count('42222222-2222-2222-2222-222222222220',4)$sql$,'session_read_only');
select pg_temp.expect_room_count_error($sql$select public.update_session_room_count('42222222-2222-2222-2222-222222222227',4)$sql$,'session_read_only');
select pg_temp.expect_room_count_error($sql$update public.health_sessions set room_count=4 where id='42222222-2222-2222-2222-222222222220'$sql$,'permission denied for table health_sessions');
reset role;
select pg_temp.expect_room_count_error($sql$update public.health_sessions set room_count=4 where id='42222222-2222-2222-2222-222222222220'$sql$,'session_read_only');
set local role authenticated;
select pg_temp.assert_room_count((select room_count=6 from public.health_sessions where id='42222222-2222-2222-2222-222222222220'), 'historical six rooms are not forced to four');
select pg_temp.assert_room_count((select room_count=8 from public.health_sessions where id='42222222-2222-2222-2222-222222222227'), 'closed eight rooms stay eight');
select set_config('request.jwt.claim.sub','',true);
select pg_temp.expect_room_count_error($sql$select public.update_session_room_count('42222222-2222-2222-2222-222222222224',2)$sql$,'permission_denied');
reset role;
select pg_temp.assert_room_count(exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='health_sessions'), 'count-only changes are published to realtime');
rollback;
\echo 'PASS: count defaults/range, initialization, safe increases/decreases, retained history, RPC/table boundaries, readonly history, and realtime'
