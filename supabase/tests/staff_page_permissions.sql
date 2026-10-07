-- Runs actual deployed SQL under PostgreSQL's authenticated/anon roles. The
-- runner supplies auth.uid() only; no mocks replace policies, grants or RPCs.
begin;

create function pg_temp.assert_permission(p_ok boolean,p_message text)
returns void language plpgsql as $$ begin
  if p_ok is distinct from true then raise exception 'FAIL: %',p_message; end if;
end $$;
create function pg_temp.expect_permission_denied(p_sql text)
returns void language plpgsql as $$
declare rejected boolean:=false;
begin
  begin execute p_sql;
  exception when insufficient_privilege then rejected:=true; end;
  if not rejected then raise exception 'FAIL: API did not reject %',p_sql; end if;
end $$;
create function pg_temp.check_rpc_gate(p_sql text,p_allowed boolean)
returns void language plpgsql as $$
declare rejected boolean:=false;
begin
  begin execute p_sql;
  exception
    when insufficient_privilege then
      if p_allowed or sqlerrm<>'permission_denied' then raise; end if;
      rejected:=true;
    when raise_exception then
      -- Authorized calls use deliberately nonexistent identifiers. Only the
      -- existing domain validation, never an authorization failure, may fire.
      if not p_allowed or sqlerrm='permission_denied' then raise; end if;
  end;
  if not p_allowed and not rejected then raise exception 'FAIL: RPC bypassed page permission: %',p_sql; end if;
end $$;

-- H: accounts predating the migration retain all pages, including email-less
-- Auth records. Verify every business column against a pre-migration snapshot.
select pg_temp.assert_permission((select count(*)=2 from public.staff_permissions
  where user_id in ('a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002')
  and can_registration and can_console and can_room and is_active),'existing accounts retain all permissions');
select pg_temp.assert_permission((select login_email='legacy.staff@itri.example.com' from public.staff_permissions
  where user_id='a0000000-0000-0000-0000-000000000001'),'backfill copies existing auth email');
select pg_temp.assert_permission(not exists(
  select 1 from auth.permission_history_snapshot old
  left join (
    select 'sessions' as kind,to_jsonb(s) as record from public.health_sessions s where s.id='a1000000-0000-0000-0000-000000000001'
    union all select 'participants',to_jsonb(p) from public.participants p where p.id='a2000000-0000-0000-0000-000000000001'
    union all select 'examinations',to_jsonb(e) from public.examinations e where e.id='a3000000-0000-0000-0000-000000000001'
  ) current_record using(kind)
  where old.record is distinct from current_record.record
),'permission migration preserves every historical business column');
\echo 'PASS: H existing-account backfill and unchanged historical sessions/examinations'

-- All eight independent Boolean combinations, plus inactive and missing rows.
create temporary table permission_cases as
select ('f0000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid as user_id,
  n as case_number,
  n<=8 and ((n-1)&4)>0 as registration,
  n<=8 and ((n-1)&2)>0 as console,
  n<=8 and ((n-1)&1)>0 as room,
  n<=8 as active
from generate_series(1,10) n;
insert into auth.users(id,email,raw_user_meta_data)
select user_id,'permissions'||case_number||'@itri.example.com',
  '{"can_registration":true,"can_console":true,"can_room":true,"is_active":true}'::jsonb from permission_cases;
select pg_temp.assert_permission((select count(*)=10 from public.staff_permissions
  where user_id in (select user_id from permission_cases)
  and not can_registration and not can_console and not can_room and is_active
  and login_email is not null and display_name=''),'new auth trigger defaults to active with no page permissions');
update public.staff_permissions permissions
set can_registration=cases.registration,can_console=cases.console,can_room=cases.room
from permission_cases cases where permissions.user_id=cases.user_id;
update public.staff_permissions set can_registration=true,can_console=true,can_room=true,is_active=false
where user_id='f0000000-0000-0000-0000-000000000009';
delete from public.staff_permissions where user_id='f0000000-0000-0000-0000-000000000010';
insert into auth.users(id,email) values('f0000000-0000-0000-0000-000000000011','delete.fixture@itri.example.com');
delete from auth.users where id='f0000000-0000-0000-0000-000000000011';
select pg_temp.assert_permission(not exists(select 1 from public.staff_permissions where user_id='f0000000-0000-0000-0000-000000000011'),'deleting auth user cascades permission row');
update auth.users set email='room.changed@itri.example.com' where id='f0000000-0000-0000-0000-000000000002';
select pg_temp.assert_permission((select login_email='room.changed@itri.example.com'
  and not can_registration and not can_console and can_room and is_active
  from public.staff_permissions where user_id='f0000000-0000-0000-0000-000000000002'),'email trigger synchronizes email without resetting granted permissions');
\echo 'PASS: H new-user deny-by-default and email synchronization preserve grants'

insert into public.health_sessions(id,session_date,company_name,created_by)
values('f1000000-0000-0000-0000-000000000001',(clock_timestamp() at time zone 'Asia/Taipei')::date,'permission fixture','f0000000-0000-0000-0000-000000000008');
insert into public.participants(id,session_id,sequence_no,employee_no,full_name,schedule_slot,group_code)
values('f2000000-0000-0000-0000-000000000001','f1000000-0000-0000-0000-000000000001',1,'1','Permission fixture','08:00','A');
insert into public.registered_devices(id,display_name,owner_id)
values('permission-device','Permission fixture','f0000000-0000-0000-0000-000000000008');
insert into public.clearance_requests(session_id,device_id)
values('f1000000-0000-0000-0000-000000000001','permission-device');

create temporary table permission_rpc_cases(page,statement) as values
  ('registration',$sql$select public.check_in_participant('ffffffff-ffff-ffff-ffff-ffffffffffff')$sql$),
  ('registration',$sql$select public.clear_session_schedule('ffffffff-ffff-ffff-ffff-ffffffffffff')$sql$),
  ('registration',$sql$select public.delete_health_session('ffffffff-ffff-ffff-ffff-ffffffffffff')$sql$),
  ('registration',$sql$select public.close_health_session('ffffffff-ffff-ffff-ffff-ffffffffffff')$sql$),
  ('registration',$sql$select public.update_session_room_count('ffffffff-ffff-ffff-ffff-ffffffffffff',4)$sql$),
  ('registration',$sql$select public.acknowledge_device_clear('ffffffff-ffff-ffff-ffff-ffffffffffff','fake-user-id')$sql$),
  ('console',$sql$select public.set_waiting_status('ffffffff-ffff-ffff-ffff-ffffffffffff','等候中')$sql$),
  ('console',$sql$select public.call_participant('ffffffff-ffff-ffff-ffff-ffffffffffff')$sql$),
  ('room',$sql$select public.start_examination('ffffffff-ffff-ffff-ffff-ffffffffffff','診間 1',array['腹部超音波'])$sql$),
  ('room',$sql$select public.complete_examination('ffffffff-ffff-ffff-ffff-ffffffffffff','診間 1',array['腹部超音波'])$sql$),
  ('room',$sql$select public.enqueue_additional_examination('ffffffff-ffff-ffff-ffff-ffffffffffff',array['腹部超音波'])$sql$),
  ('room',$sql$select public.set_room_away('ffffffff-ffff-ffff-ffff-ffffffffffff','診間 1',true)$sql$),
  ('room',$sql$select public.examination_clock()$sql$);
grant select on permission_cases,permission_rpc_cases to authenticated;
set local role authenticated;
do $$
declare staff record; rpc record; any_page boolean; changed integer; rows_seen integer;
begin
  for staff in select * from permission_cases order by case_number loop
    perform set_config('request.jwt.claim.sub',staff.user_id::text,true);
    -- Supplying a different user in untrusted JWT metadata or RPC identifiers
    -- does not change auth.uid(), which every permission helper uses.
    perform set_config('request.jwt.claims','{"user_id":"f0000000-0000-0000-0000-000000000008","can_room":true}',true);
    any_page:=staff.registration or staff.console or staff.room;
    perform pg_temp.assert_permission(public.can_use_registration()=staff.registration,'registration helper case '||staff.case_number);
    perform pg_temp.assert_permission(public.can_use_console()=staff.console,'console helper case '||staff.case_number);
    perform pg_temp.assert_permission(public.can_use_room()=staff.room,'room helper case '||staff.case_number);
    perform pg_temp.assert_permission(public.is_active_staff()=staff.active,'active helper case '||staff.case_number);
    perform pg_temp.assert_permission(public.can_access_session('f1000000-0000-0000-0000-000000000001')=any_page,'session access case '||staff.case_number);
    select count(*) into rows_seen from public.staff_permissions;
    perform pg_temp.assert_permission(rows_seen=case when staff.case_number=10 then 0 else 1 end,'only own permission row case '||staff.case_number);
    perform pg_temp.assert_permission(not exists(select 1 from public.staff_permissions where user_id<>staff.user_id),'other staff permissions remain hidden');
    select count(*) into rows_seen from public.health_sessions where id='f1000000-0000-0000-0000-000000000001';
    perform pg_temp.assert_permission(rows_seen=case when any_page then 1 else 0 end,'sessions select case '||staff.case_number);
    select count(*) into rows_seen from public.participants where id='f2000000-0000-0000-0000-000000000001';
    perform pg_temp.assert_permission(rows_seen=case when any_page then 1 else 0 end,'participant select case '||staff.case_number);
    select count(*) into rows_seen from public.rooms where session_id='f1000000-0000-0000-0000-000000000001';
    perform pg_temp.assert_permission(rows_seen=case when any_page then 4 else 0 end,'rooms select case '||staff.case_number);
    select count(*) into rows_seen from public.ultrasound_items;
    perform pg_temp.assert_permission((rows_seen>0)=any_page,'item catalog select case '||staff.case_number);
    select count(*) into rows_seen from public.clearance_requests where session_id='f1000000-0000-0000-0000-000000000001';
    perform pg_temp.assert_permission(rows_seen=case when any_page then 1 else 0 end,'clearance select case '||staff.case_number);
    select count(*) into rows_seen from public.registered_devices where id='permission-device';
    perform pg_temp.assert_permission(rows_seen=case when staff.case_number=8 then 1 else 0 end,'only own device readable by active staff');
    select count(*) into rows_seen from public.examinations where participant_id='a2000000-0000-0000-0000-000000000001';
    perform pg_temp.assert_permission(rows_seen=case when any_page then 1 else 0 end,'examinations select case '||staff.case_number);
    for rpc in select * from permission_rpc_cases loop
      perform pg_temp.check_rpc_gate(rpc.statement,case rpc.page
        when 'registration' then staff.registration when 'console' then staff.console else staff.room end);
    end loop;
    perform pg_temp.expect_permission_denied(format('update public.staff_permissions set can_registration=true where user_id=%L',staff.user_id));
    perform pg_temp.expect_permission_denied(format('delete from public.staff_permissions where user_id=%L',staff.user_id));
    perform pg_temp.expect_permission_denied(format('insert into public.staff_permissions(user_id,can_registration) values(%L,true)',staff.user_id));
    perform pg_temp.expect_permission_denied($sql$update public.participants set status='已完成' where id='f2000000-0000-0000-0000-000000000001'$sql$);
    perform pg_temp.expect_permission_denied($sql$update public.participants set checkin_no='A999',checked_in_at=now(),called_at=now() where id='f2000000-0000-0000-0000-000000000001'$sql$);
    perform pg_temp.expect_permission_denied($sql$update public.health_sessions set room_count=8 where id='f1000000-0000-0000-0000-000000000001'$sql$);
    perform pg_temp.expect_permission_denied($sql$update public.health_sessions set status='closed' where id='f1000000-0000-0000-0000-000000000001'$sql$);
    perform pg_temp.expect_permission_denied($sql$update public.rooms set status='away' where session_id='f1000000-0000-0000-0000-000000000001'$sql$);
    perform pg_temp.expect_permission_denied($sql$insert into public.rooms(session_id,room_id,status) values('f1000000-0000-0000-0000-000000000001','診間 8','idle')$sql$);
    perform pg_temp.expect_permission_denied($sql$delete from public.rooms where session_id='f1000000-0000-0000-0000-000000000001'$sql$);
    perform pg_temp.expect_permission_denied($sql$insert into public.examinations(participant_id,round_no,selected_items,status) values('f2000000-0000-0000-0000-000000000001',1,array['腹部超音波'],'waiting')$sql$);
    perform pg_temp.expect_permission_denied($sql$update public.examinations set actual_items=array['甲狀腺超音波'] where participant_id='a2000000-0000-0000-0000-000000000001'$sql$);
    perform pg_temp.expect_permission_denied($sql$delete from public.examinations where participant_id='a2000000-0000-0000-0000-000000000001'$sql$);
    perform pg_temp.expect_permission_denied($sql$insert into public.participants(session_id,sequence_no,employee_no,full_name,schedule_slot,group_code,status) values('f1000000-0000-0000-0000-000000000001',99,'forged','Forged','08:00','A','已完成')$sql$);
    perform pg_temp.expect_permission_denied($sql$insert into public.health_sessions(session_date,company_name,created_by) values((clock_timestamp() at time zone 'Asia/Taipei')::date,'forged creator','a0000000-0000-0000-0000-000000000001')$sql$);
    perform pg_temp.expect_permission_denied($sql$delete from public.health_sessions where id='f1000000-0000-0000-0000-000000000001'$sql$);
    perform pg_temp.expect_permission_denied($sql$update public.group_counters set last_value=999 where session_id='f1000000-0000-0000-0000-000000000001'$sql$);
    perform pg_temp.expect_permission_denied($sql$update public.clearance_requests set acknowledged_at=now() where session_id='f1000000-0000-0000-0000-000000000001'$sql$);
    perform pg_temp.expect_permission_denied($sql$update public.ultrasound_items set active=false$sql$);
    update public.participants set note='allowed basic schedule note' where id='f2000000-0000-0000-0000-000000000001';
    get diagnostics changed=row_count;
    perform pg_temp.assert_permission(changed=case when staff.registration then 1 else 0 end,'basic participant updates registration-only');
    update public.health_sessions set company_name='permission fixture' where id='f1000000-0000-0000-0000-000000000001';
    get diagnostics changed=row_count;
    perform pg_temp.assert_permission(changed=case when staff.registration then 1 else 0 end,'session updates registration-only');
    if not staff.registration then
      perform pg_temp.expect_permission_denied(format($sql$insert into public.health_sessions(session_date,company_name,created_by) values((clock_timestamp() at time zone 'Asia/Taipei')::date,'unauthorized session',%L)$sql$,staff.user_id));
      perform pg_temp.expect_permission_denied($sql$insert into public.participants(session_id,sequence_no,employee_no,full_name,schedule_slot,group_code) values('f1000000-0000-0000-0000-000000000001',99,'unauthorized','Unauthorized','08:00','A')$sql$);
      delete from public.participants where id='f2000000-0000-0000-0000-000000000001';
      get diagnostics changed=row_count;
      perform pg_temp.assert_permission(changed=0,'participant delete denied without registration');
    end if;
  end loop;
  perform set_config('request.jwt.claim.sub','',true);
  for rpc in select * from permission_rpc_cases loop perform pg_temp.check_rpc_gate(rpc.statement,false); end loop;
  perform pg_temp.assert_permission(not public.is_active_staff() and not public.can_use_registration() and not public.can_use_console() and not public.can_use_room(),'missing auth identity fails closed');
end $$;
\echo 'PASS: A-G all eight page combinations, inactive/missing users, thirteen RPC gates and direct API/RLS boundaries'

-- D: registration-only can create, edit/import schedule, check in, manage the
-- roster and clean a session, without unrestricted status/counter writes.
set local request.jwt.claim.sub='f0000000-0000-0000-0000-000000000005';
create temporary table registration_session(id uuid);
with created as (
  insert into public.health_sessions(session_date,company_name,created_by,room_count)
  values((clock_timestamp() at time zone 'Asia/Taipei')::date,'registration only','f0000000-0000-0000-0000-000000000005',2) returning id
) insert into registration_session select id from created;
create temporary table registration_participant(id uuid);
with created as (
  insert into public.participants(session_id,sequence_no,employee_no,full_name,schedule_slot,group_code,planned_items)
  values((select id from registration_session),1,'2','Registration only','08:00','A',array['腹部超音波']) returning id
) insert into registration_participant select id from created;
update public.participants set full_name='Edited schedule',schedule_slot='08:10' where id=(select id from registration_participant);
select pg_temp.assert_permission((public.check_in_participant((select id from registration_participant))).status='等候中','registration-only checks in');
select public.update_session_room_count((select id from registration_session),3);
select pg_temp.assert_permission((select count(*)=3 from public.rooms where session_id=(select id from registration_session)),'registration-only manages room count');
select public.check_in_participant('f2000000-0000-0000-0000-000000000001');

-- C: console-only manipulates the waiting/called queue through its RPCs.
set local request.jwt.claim.sub='f0000000-0000-0000-0000-000000000003';
select public.set_waiting_status('f2000000-0000-0000-0000-000000000001','上廁所');
select pg_temp.assert_permission((select status='上廁所' from public.participants where id='f2000000-0000-0000-0000-000000000001'),'console-only changes waiting status');
select public.set_waiting_status('f2000000-0000-0000-0000-000000000001','等候中');
select public.call_participant('f2000000-0000-0000-0000-000000000001');
select pg_temp.assert_permission((select status='已叫號' and called_at is not null from public.participants where id='f2000000-0000-0000-0000-000000000001'),'console-only calls participant');

-- B: room-only performs every room operation and preserves completed rounds.
set local request.jwt.claim.sub='f0000000-0000-0000-0000-000000000002';
select pg_temp.assert_permission(public.examination_clock() is not null,'room-only reads authoritative examination clock');
select pg_temp.assert_permission((public.set_room_away('f1000000-0000-0000-0000-000000000001','診間 1',true)).status='away','room-only can go away');
select pg_temp.assert_permission((public.set_room_away('f1000000-0000-0000-0000-000000000001','診間 1',false)).status='idle','room-only can return');
create temporary table permission_visit as select (public.start_examination('f2000000-0000-0000-0000-000000000001','診間 1',array['腹部超音波'])).*;
select pg_temp.assert_permission((select status='in_progress' from permission_visit),'room-only starts examination');
select pg_temp.assert_permission((public.complete_examination((select id from permission_visit),'診間 1',array['腹部超音波'])).status='completed','room-only completes examination');
select pg_temp.assert_permission((public.enqueue_additional_examination('f2000000-0000-0000-0000-000000000001',array['甲狀腺超音波'])).round_no=2,'room-only enqueues another examination round');
truncate permission_visit;
insert into permission_visit select (public.start_examination('f2000000-0000-0000-0000-000000000001','診間 1',array['甲狀腺超音波'])).*;
select public.complete_examination((select id from permission_visit),'診間 1',array['甲狀腺超音波']);
select pg_temp.assert_permission((select count(*)=2 from public.examinations where participant_id='f2000000-0000-0000-0000-000000000001' and status='completed'),'additional round preserves first examination');
\echo 'PASS: B-D actual registration-only, console-only and room-only workflows'

-- I: Table Editor changes affect the next API read immediately. Publication is
-- enabled, while SELECT RLS keeps other accounts outside the subscriber scope.
reset role;
update public.staff_permissions set can_room=false,can_console=true where user_id='f0000000-0000-0000-0000-000000000002';
set local role authenticated;
select pg_temp.assert_permission(not public.can_use_room() and public.can_use_console(),'permission update takes effect without a new login');
select pg_temp.assert_permission((select not can_room and can_console from public.staff_permissions),'refresh returns newly granted pages');
select pg_temp.check_rpc_gate($sql$select public.set_room_away('f1000000-0000-0000-0000-000000000001','診間 1',true)$sql$,false);
reset role;
update public.staff_permissions set can_console=false where user_id='f0000000-0000-0000-0000-000000000002';
set local role authenticated;
select pg_temp.assert_permission(not public.can_access_session('f1000000-0000-0000-0000-000000000001'),'revoking last page blocks session access');
select pg_temp.assert_permission((select count(*)=0 from public.participants),'revoking last page blocks participant reads');
select pg_temp.assert_permission((select count(*)=1 from public.staff_permissions),'revoked staff still reads own permissions to show correct UI');
reset role;
select pg_temp.assert_permission(exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='staff_permissions'),'own permissions changes published to Realtime');
\echo 'PASS: I permission refresh/revocation and Realtime publication with own-row RLS'

set local request.jwt.claim.sub='f0000000-0000-0000-0000-000000000005';
set local role authenticated;
select public.acknowledge_device_clear('f1000000-0000-0000-0000-000000000001','permission-device');
select pg_temp.assert_permission((select acknowledged_at is not null from public.clearance_requests where session_id='f1000000-0000-0000-0000-000000000001'),'registration-only acknowledges cleanup');
delete from public.participants where id=(select id from registration_participant);
select public.clear_session_schedule((select id from registration_session));
select pg_temp.assert_permission((public.close_health_session((select id from registration_session))->>'cloud_deleted')::boolean,'registration-only closes cleared session');
select public.delete_health_session((select id from registration_session));
select pg_temp.assert_permission(not exists(select 1 from public.health_sessions where id=(select id from registration_session)),'registration-only deletes session');

-- Anonymous clients cannot execute any operational SECURITY DEFINER function
-- or read permissions, even if a user UUID is supplied in a request setting.
reset role;
select pg_temp.assert_permission(not exists(
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prosecdef and has_function_privilege('authenticated',p.oid,'EXECUTE')
    and p.proname not in ('is_active_staff','can_use_registration','can_use_console','can_use_room','can_access_session',
      'check_in_participant','set_waiting_status','call_participant','set_room_away','start_examination',
      'complete_examination','enqueue_additional_examination','update_session_room_count','clear_session_schedule',
      'delete_health_session','close_health_session','acknowledge_device_clear')
),'all authenticated-callable SECURITY DEFINER functions covered by permission inventory');
select pg_temp.assert_permission((select count(*)=4 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('is_active_staff','can_use_registration','can_use_console','can_use_room')
    and p.prosecdef and p.provolatile='s' and p.pronargs=0 and p.proconfig @> array['search_path=""']),
  'all permission helpers stable, security definer, zero-argument and empty search_path');
select pg_temp.assert_permission(not exists(
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prosecdef and has_function_privilege('anon',p.oid,'EXECUTE')
),'anon cannot call any public SECURITY DEFINER function');
set local role anon;
select pg_temp.expect_permission_denied('select * from public.staff_permissions');
select pg_temp.expect_permission_denied($sql$select public.check_in_participant('f2000000-0000-0000-0000-000000000001')$sql$);
reset role;
\echo 'PASS: registration cleanup/deletion and anonymous API denial'
rollback;
