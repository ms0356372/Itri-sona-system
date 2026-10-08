-- Real production RPCs, grants and constraints in the disposable database.
-- Local Company Master/IndexedDB behavior is covered by the frontend tests.
begin;
create function pg_temp.assert_simple(p_ok boolean,p_message text)
returns void language plpgsql as $$ begin
  if p_ok is distinct from true then raise exception 'FAIL: %',p_message; end if;
end $$;
create function pg_temp.expect_simple_error(p_sql text,p_error text,p_state text default 'P0001')
returns void language plpgsql as $$
declare rejected boolean:=false;
begin
  begin execute p_sql;
  exception when others then
    if sqlstate<>p_state or sqlerrm<>p_error then raise; end if;
    rejected:=true;
  end;
  if not rejected then raise exception 'FAIL: expected % for %',p_error,p_sql; end if;
end $$;
create function pg_temp.expect_simple_privilege(p_sql text)
returns void language plpgsql as $$
declare rejected boolean:=false;
begin
  begin execute p_sql;
  exception when insufficient_privilege then rejected:=true; end;
  if not rejected then raise exception 'FAIL: client mutation accepted %',p_sql; end if;
end $$;

-- All page-permission combinations: this new endpoint belongs to registration.
create temporary table simple_permission_cases as
select ('b5000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid user_id,
  n case_number,n<=8 and ((n-1)&4)>0 registration,
  n<=8 and ((n-1)&2)>0 console,n<=8 and ((n-1)&1)>0 room,n<=8 active
from generate_series(1,10) n;
grant select on simple_permission_cases to authenticated;
insert into auth.users(id,email)
select user_id,'simple.permission.'||case_number||'@itri.example.com' from simple_permission_cases;
update public.staff_permissions p set can_registration=c.registration,can_console=c.console,can_room=c.room
from simple_permission_cases c where p.user_id=c.user_id;
update public.staff_permissions set can_registration=true,can_console=true,can_room=true,is_active=false
where user_id='b5000000-0000-0000-0000-000000000009';
delete from public.staff_permissions where user_id='b5000000-0000-0000-0000-000000000010';
set local role authenticated;
do $$ declare permission_case record; rejected boolean; begin
  for permission_case in select * from simple_permission_cases order by case_number loop
    perform set_config('request.jwt.claim.sub',permission_case.user_id::text,true);
    rejected:=false;
    begin
      perform public.simple_check_in_participant('00000000-0000-0000-0000-000000000000','1','Tester','男','一般');
    exception
      when insufficient_privilege then
        if permission_case.registration and permission_case.active or sqlerrm<>'permission_denied' then raise; end if;
        rejected:=true;
      when raise_exception then
        if not permission_case.registration or not permission_case.active then raise; end if;
    end;
    if not (permission_case.registration and permission_case.active) and not rejected then
      raise exception 'FAIL: simple RPC bypassed registration permission for case %',permission_case.case_number;
    end if;
  end loop;
end $$;
set local role anon;
select pg_temp.expect_simple_privilege($sql$select public.simple_check_in_participant('00000000-0000-0000-0000-000000000000','1','Tester','男','一般')$sql$);
reset role;
select pg_temp.assert_simple(has_function_privilege('authenticated','public.simple_check_in_participant(uuid,text,text,text,text,text)','EXECUTE')
  and not has_function_privilege('anon','public.simple_check_in_participant(uuid,text,text,text,text,text)','EXECUTE'),'new RPC has explicit authenticated-only execute');
select pg_temp.assert_simple(not exists(select 1 from information_schema.columns where table_schema='public'
  and table_name in ('participants','health_sessions','simple_queue_counters') and column_name ~* 'national.?id'),'cloud simple schema has no national ID');
select pg_temp.assert_simple(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='simple_check_in_participant' and array_to_string(p.proargnames,',') ~* 'national.?id'),'simple payload has no national ID argument');
\echo 'PASS: simple registration permission matrix, inactive/missing/anon denial and national-ID-free schema/RPC'

insert into public.health_sessions(id,session_date,company_name,created_by,workflow_mode,room_count) values
  ('b5100000-0000-0000-0000-000000000001',(clock_timestamp() at time zone 'Asia/Taipei')::date,'Simple first','b5000000-0000-0000-0000-000000000008','simple',3),
  ('b5100000-0000-0000-0000-000000000002',(clock_timestamp() at time zone 'Asia/Taipei')::date,'Simple independent','b5000000-0000-0000-0000-000000000008','simple',2),
  ('b5100000-0000-0000-0000-000000000003',(clock_timestamp() at time zone 'Asia/Taipei')::date,'Standard regression','b5000000-0000-0000-0000-000000000008','standard',4),
  ('b5100000-0000-0000-0000-000000000004',(clock_timestamp() at time zone 'Asia/Taipei')::date-1,'Simple history','b5000000-0000-0000-0000-000000000008','simple',2),
  ('b5100000-0000-0000-0000-000000000005',(clock_timestamp() at time zone 'Asia/Taipei')::date+1,'Simple future','b5000000-0000-0000-0000-000000000008','simple',2);
insert into public.health_sessions(id,session_date,company_name,created_by)
values('b5100000-0000-0000-0000-000000000006',(clock_timestamp() at time zone 'Asia/Taipei')::date,'Default standard','b5000000-0000-0000-0000-000000000008');
select pg_temp.assert_simple((select workflow_mode='standard' from public.health_sessions where id='b5100000-0000-0000-0000-000000000006'),'omitted mode defaults to standard');
select pg_temp.assert_simple((select count(*)=3 from public.rooms where session_id='b5100000-0000-0000-0000-000000000001'),'simple session uses existing room initialization');
select pg_temp.expect_simple_error($sql$update public.health_sessions set workflow_mode='standard' where id='b5100000-0000-0000-0000-000000000001'$sql$,'workflow_mode_immutable');
select pg_temp.expect_simple_error($sql$update public.health_sessions set workflow_mode='simple' where id='b5100000-0000-0000-0000-000000000006'$sql$,'workflow_mode_immutable');
select pg_temp.assert_simple(not exists(select 1 from public.participants where session_id='b5100000-0000-0000-0000-000000000001'),'new simple session starts with zero participants and no schedule');

set local request.jwt.claim.sub='b5000000-0000-0000-0000-000000000005';
set local role authenticated;
create temporary table simple_created_session as
with created as (
  insert into public.health_sessions(session_date,company_name,created_by,workflow_mode,room_count)
  values((clock_timestamp() at time zone 'Asia/Taipei')::date,'Registration creates simple',
    'b5000000-0000-0000-0000-000000000005','simple',2)
  returning *
) select * from created;
select pg_temp.assert_simple((select workflow_mode='simple' and room_count=2 from simple_created_session),
  'registration-only browser INSERT RETURNING accepts workflow_mode under existing RLS');
create temporary table simple_reply(label text primary key,reply jsonb);
insert into simple_reply select 'first',to_jsonb(public.simple_check_in_participant('b5100000-0000-0000-0000-000000000001','B30040','王小明','男','一般','1234'));
select pg_temp.assert_simple((select reply->>'checkin_no'='1' and (reply->>'queue_number')::integer=1
  and (reply->>'sequence_no')::integer=1 and reply->>'status'='等候中' and reply->>'employee_no'='B30040'
  and reply->>'full_name'='王小明' and reply->>'gender'='男' and reply->'planned_items'='["一般"]'::jsonb
  and reply->>'note' like '%1234%' and reply->>'group_code' is null and reply->>'schedule_slot' is null
  and reply->>'checkin_sequence' is null and (reply->>'checked_in_at')::timestamptz between transaction_timestamp() and clock_timestamp()
  from simple_reply where label='first'),'first explicit confirmation gets numeric queue 1, DB time, master items and no schedule/group');
insert into simple_reply select 'second',to_jsonb(public.simple_check_in_participant('b5100000-0000-0000-0000-000000000001','B30041','林小華','女','一般'));
select pg_temp.assert_simple((select reply->>'checkin_no'='2' and (reply->>'queue_number')::integer=2 from simple_reply where label='second'),'second confirmation gets queue 2');
select pg_temp.assert_simple(to_jsonb(public.simple_check_in_participant('b5100000-0000-0000-0000-000000000001','B30040','王小明','男','另一項目','9999'))
  =(select reply from simple_reply where label='first'),'duplicate returns same full row without rewriting time, item or extension');
select pg_temp.expect_simple_error($sql$select public.check_in_participant((select (reply->>'id')::uuid from simple_reply where label='first'))$sql$,'invalid_workflow_mode');
select pg_temp.expect_simple_error($sql$select public.simple_check_in_participant('b5100000-0000-0000-0000-000000000001','B30040','另一人','男','一般')$sql$,'simple_identity_conflict');
select pg_temp.expect_simple_error($sql$select public.simple_check_in_participant('b5100000-0000-0000-0000-000000000001','B30040','王小明','女','一般')$sql$,'simple_identity_conflict');
select pg_temp.expect_simple_error($sql$select public.simple_check_in_participant('b5100000-0000-0000-0000-000000000001','','空工號','男','一般')$sql$,'invalid_simple_participant');
select pg_temp.expect_simple_error($sql$select public.simple_check_in_participant('b5100000-0000-0000-0000-000000000001','EMPTY',' ','男','一般')$sql$,'invalid_simple_participant');
select pg_temp.expect_simple_error($sql$select public.simple_check_in_participant('b5100000-0000-0000-0000-000000000001','EMPTY','空項目','男',' ')$sql$,'invalid_simple_participant');
-- Optional gender normalization is exercised in manual_optional_gender.sql on
-- isolated sessions, preserving this suite's original queue/counter assertions.
select pg_temp.expect_simple_error($sql$select public.simple_check_in_participant('b5100000-0000-0000-0000-000000000003','STANDARD','Standard','男','一般')$sql$,'invalid_workflow_mode');
-- Registration follows the existing active-session boundary. Room operations
-- retain their separate deployed today/lease checks without changing check-in.
select pg_temp.assert_simple((public.simple_check_in_participant('b5100000-0000-0000-0000-000000000004','PAST','Past','男','一般')).queue_number=1,'active session check-in has no added date rule');
select pg_temp.assert_simple((public.simple_check_in_participant('b5100000-0000-0000-0000-000000000005','FUTURE','Future','男','一般')).queue_number=1,'future active session check-in has no added date rule');
select pg_temp.expect_simple_error($sql$insert into public.participants(session_id,sequence_no,employee_no,full_name,gender,planned_items)
  values('b5100000-0000-0000-0000-000000000001',3,'FORGED','Forged','男',array['一般'])$sql$,'invalid_simple_participant');
select pg_temp.expect_simple_privilege($sql$update public.participants set queue_number=99 where session_id='b5100000-0000-0000-0000-000000000001'$sql$);
select pg_temp.expect_simple_privilege($sql$insert into public.participants(session_id,sequence_no,employee_no,full_name,gender,planned_items,queue_number,checkin_no,checked_in_at,status)
  values('b5100000-0000-0000-0000-000000000001',3,'FORGEDTICKET','Forged ticket','男',array['一般'],3,'3',clock_timestamp(),'等候中')$sql$);
select pg_temp.expect_simple_privilege($sql$insert into public.simple_queue_counters(session_id,next_number) values('b5100000-0000-0000-0000-000000000001',99)$sql$);
select pg_temp.expect_simple_privilege($sql$update public.health_sessions set workflow_mode='standard' where id='b5100000-0000-0000-0000-000000000001'$sql$);
reset role;
grant select on simple_reply to authenticated;
select pg_temp.expect_simple_error($sql$update public.participants set group_code='A'
  where session_id='b5100000-0000-0000-0000-000000000001' and employee_no='B30040'$sql$,'invalid_simple_participant');
select pg_temp.expect_simple_error($sql$update public.participants set schedule_slot='08:00'
  where session_id='b5100000-0000-0000-0000-000000000001' and employee_no='B30040'$sql$,'invalid_simple_participant');
select pg_temp.expect_simple_error($sql$update public.participants set checkin_no='999'
  where session_id='b5100000-0000-0000-0000-000000000001' and employee_no='B30040'$sql$,'invalid_simple_participant');
select pg_temp.expect_simple_error($sql$update public.participants set checked_in_at=checked_in_at+interval '1 second'
  where session_id='b5100000-0000-0000-0000-000000000001' and employee_no='B30040'$sql$,'invalid_simple_participant');
select pg_temp.assert_simple((select next_number=3 from public.simple_queue_counters where session_id='b5100000-0000-0000-0000-000000000001'),'duplicate/invalid/rejected calls do not consume queue numbers');
select pg_temp.assert_simple((select count(*)=2 from public.participants where session_id='b5100000-0000-0000-0000-000000000001')
  and not exists(select 1 from public.group_counters where session_id='b5100000-0000-0000-0000-000000000001'),'simple queue is independent of A-G counters');
\echo 'PASS: simple zero-schedule queue 1/2, duplicate full-row preservation, identity validation, server clock and direct-write denial'

-- Standard remains schedule-backed with independent A/B group counters.
insert into public.participants(id,session_id,sequence_no,employee_no,full_name,schedule_slot,group_code) values
  ('b5200000-0000-0000-0000-000000000001','b5100000-0000-0000-0000-000000000003',1,'SA1','Standard A1','08:00','A'),
  ('b5200000-0000-0000-0000-000000000002','b5100000-0000-0000-0000-000000000003',2,'SA2','Standard A2','08:00','A'),
  ('b5200000-0000-0000-0000-000000000003','b5100000-0000-0000-0000-000000000003',3,'SB1','Standard B1','08:30','B');
select pg_temp.expect_simple_error($sql$insert into public.participants(session_id,sequence_no,employee_no,full_name,schedule_slot,group_code)
  values('b5100000-0000-0000-0000-000000000003',4,'NOSLOT','No slot',null,'A')$sql$,'invalid_standard_participant');
select pg_temp.expect_simple_error($sql$insert into public.participants(session_id,sequence_no,employee_no,full_name,schedule_slot,group_code)
  values('b5100000-0000-0000-0000-000000000003',4,'NOGROUP','No group','08:00',null)$sql$,'invalid_standard_participant');
select pg_temp.expect_simple_error($sql$insert into public.participants(session_id,sequence_no,employee_no,full_name,schedule_slot,group_code,queue_number)
  values('b5100000-0000-0000-0000-000000000003',4,'FAKESIMPLE','Fake simple','08:00','A',1)$sql$,'invalid_standard_participant');
set local role authenticated;
select pg_temp.assert_simple((public.check_in_participant('b5200000-0000-0000-0000-000000000001')).checkin_no='A1','standard first A gets A1');
select pg_temp.assert_simple((public.check_in_participant('b5200000-0000-0000-0000-000000000002')).checkin_no='A2','standard second A gets A2');
select pg_temp.assert_simple((public.check_in_participant('b5200000-0000-0000-0000-000000000003')).checkin_no='B1','standard first B gets B1');
select pg_temp.assert_simple((public.check_in_participant('b5200000-0000-0000-0000-000000000001')).checkin_no='A1','standard repeated checkin preserves A1');
select pg_temp.expect_simple_error($sql$select public.check_in_participant('00000000-0000-0000-0000-000000000000')$sql$,'participant_not_found');
reset role;
select pg_temp.assert_simple((select last_value=2 from public.group_counters where session_id='b5100000-0000-0000-0000-000000000003' and group_code='A')
  and (select last_value=1 from public.group_counters where session_id='b5100000-0000-0000-0000-000000000003' and group_code='B')
  and not exists(select 1 from public.simple_queue_counters where session_id='b5100000-0000-0000-0000-000000000003')
  and not exists(select 1 from public.participants where session_id='b5100000-0000-0000-0000-000000000003' and queue_number is not null),'standard group counters and queue null remain unchanged');
\echo 'PASS: standard schedule validation, A1/A2/B1, group-counter independence and repeated check-in regression'

-- Console and room APIs are shared, including device claims and extra rounds.
set local request.jwt.claim.sub='b5000000-0000-0000-0000-000000000003';
set local role authenticated;
select public.set_waiting_status((select (reply->>'id')::uuid from simple_reply where label='first'),'上廁所');
select public.set_waiting_status((select (reply->>'id')::uuid from simple_reply where label='first'),'等候中');
select public.call_participant((select (reply->>'id')::uuid from simple_reply where label='first'));
select pg_temp.assert_simple((select status='已叫號' and checkin_no='1' from public.participants where employee_no='B30040' and session_id='b5100000-0000-0000-0000-000000000001'),'console-only staff calls numeric queue participant');
set local request.jwt.claim.sub='b5000000-0000-0000-0000-000000000002';
select public.claim_room('b5100000-0000-0000-0000-000000000001','診間1','b5300000-0000-0000-0000-000000000001',repeat('a',64));
select public.set_room_away('b5100000-0000-0000-0000-000000000001','診間1',true,'b5300000-0000-0000-0000-000000000001',repeat('a',64));
select pg_temp.expect_simple_error($sql$select public.start_examination((select (reply->>'id')::uuid from simple_reply where label='first'),'診間1',array['腹部超音波'],'b5300000-0000-0000-0000-000000000001',repeat('a',64))$sql$,'room_away');
select public.heartbeat_room_claim('b5100000-0000-0000-0000-000000000001','診間1','b5300000-0000-0000-0000-000000000001',repeat('a',64));
select public.set_room_away('b5100000-0000-0000-0000-000000000001','診間1',false,'b5300000-0000-0000-0000-000000000001',repeat('a',64));
select public.start_examination((select (reply->>'id')::uuid from simple_reply where label='first'),'診間1',array['腹部超音波'],'b5300000-0000-0000-0000-000000000001',repeat('a',64));
reset role;
create temporary table simple_inprogress_snapshot as select to_jsonb(p) record from public.participants p
  where session_id='b5100000-0000-0000-0000-000000000001' and employee_no='B30040';
create temporary table simple_exam_snapshot as select to_jsonb(e) record from public.examinations e
  where participant_id=(select (reply->>'id')::uuid from simple_reply where label='first');
grant select on simple_inprogress_snapshot,simple_exam_snapshot to authenticated;
set local request.jwt.claim.sub='b5000000-0000-0000-0000-000000000005';
set local role authenticated;
select pg_temp.assert_simple(to_jsonb(public.simple_check_in_participant('b5100000-0000-0000-0000-000000000001','B30040','王小明','男','一般'))
  =(select record from simple_inprogress_snapshot),'rescan while examining preserves participant status, called time, queue and check-in time');
select pg_temp.assert_simple((select to_jsonb(e)=(select record from simple_exam_snapshot) from public.examinations e
  where participant_id=(select (reply->>'id')::uuid from simple_reply where label='first')),'rescan never changes examination');
set local request.jwt.claim.sub='b5000000-0000-0000-0000-000000000002';
select public.complete_examination((select id from public.examinations where participant_id=(select (reply->>'id')::uuid from simple_reply where label='first')),
  '診間1',array['腹部超音波'],'b5300000-0000-0000-0000-000000000001',repeat('a',64));
select public.enqueue_additional_examination((select (reply->>'id')::uuid from simple_reply where label='first'),array['甲狀腺超音波']);
select pg_temp.assert_simple((select count(*)=2 from public.examinations where participant_id=(select (reply->>'id')::uuid from simple_reply where label='first'))
  and (select status='waiting' and round_no=2 from public.examinations where participant_id=(select (reply->>'id')::uuid from simple_reply where label='first') and round_no=2),'simple additional examination uses shared second round');
select public.start_examination((select (reply->>'id')::uuid from simple_reply where label='first'),'診間1',array['甲狀腺超音波'],'b5300000-0000-0000-0000-000000000001',repeat('a',64));
select public.complete_examination((select id from public.examinations where participant_id=(select (reply->>'id')::uuid from simple_reply where label='first') and round_no=2),
  '診間1',array['甲狀腺超音波'],'b5300000-0000-0000-0000-000000000001',repeat('a',64));
select public.release_room_claim('b5100000-0000-0000-0000-000000000001','診間1','b5300000-0000-0000-0000-000000000001',repeat('a',64));
set local request.jwt.claim.sub='b5000000-0000-0000-0000-000000000005';
select pg_temp.assert_simple((public.simple_check_in_participant('b5100000-0000-0000-0000-000000000001','B30040','王小明','男','一般')).status='已完成','rescan after completion preserves finished state');
select public.simple_check_in_participant('b5100000-0000-0000-0000-000000000002','INDEPENDENT','另一場次','女','一般');
reset role;
select pg_temp.assert_simple((select next_number=3 from public.simple_queue_counters where session_id='b5100000-0000-0000-0000-000000000001')
  and (select next_number=2 from public.simple_queue_counters where session_id='b5100000-0000-0000-0000-000000000002'),'counters isolate sessions and duplicates across rounds');
\echo 'PASS: simple shared console, away/return/heartbeat, examination completion, round 2 and duplicate examination preservation'

-- Clear resets only the chosen simple cloud workflow; close honors the
-- existing acknowledgement boundary; delete uses cascade, never a local DB.
set local role authenticated;
select public.clear_session_schedule('b5100000-0000-0000-0000-000000000001');
reset role;
select pg_temp.assert_simple(not exists(select 1 from public.participants where session_id='b5100000-0000-0000-0000-000000000001')
  and not exists(select 1 from public.examinations where participant_id=(select (reply->>'id')::uuid from simple_reply where label='first'))
  and not exists(select 1 from public.rooms where session_id='b5100000-0000-0000-0000-000000000001')
  and not exists(select 1 from public.simple_queue_counters where session_id='b5100000-0000-0000-0000-000000000001'),'simple clear removes participants, examinations, rooms and counter');
select pg_temp.assert_simple((select count(*)=3 from public.participants where session_id='b5100000-0000-0000-0000-000000000003')
  and (select next_number=2 from public.simple_queue_counters where session_id='b5100000-0000-0000-0000-000000000002'),'clear preserves other simple and standard sessions');
set local role authenticated;
select pg_temp.assert_simple((public.simple_check_in_participant('b5100000-0000-0000-0000-000000000001','RESET','重設後第一人','男','一般')).queue_number=1,'first confirmation after clear restarts queue at 1');
reset role;
insert into public.registered_devices(id,display_name,owner_id) values('simple-cleanup-device','Simple cleanup test','b5000000-0000-0000-0000-000000000005');
insert into public.clearance_requests(session_id,device_id) values('b5100000-0000-0000-0000-000000000002','simple-cleanup-device');
set local role authenticated;
select pg_temp.assert_simple(public.close_health_session('b5100000-0000-0000-0000-000000000002')='{"cloud_deleted":false,"pending_devices":1}'::jsonb,'pending device acknowledgement delays cleanup');
select pg_temp.expect_simple_error($sql$select public.simple_check_in_participant('b5100000-0000-0000-0000-000000000002','CLOSING','Closing','男','一般')$sql$,'session_not_active');
reset role;
select pg_temp.assert_simple((select next_number=2 from public.simple_queue_counters where session_id='b5100000-0000-0000-0000-000000000002')
  and (select count(*)=1 from public.participants where session_id='b5100000-0000-0000-0000-000000000002')
  and (select count(*)=2 from public.rooms where session_id='b5100000-0000-0000-0000-000000000002'),'pending close preserves simple workflow');
set local role authenticated;
select public.acknowledge_device_clear('b5100000-0000-0000-0000-000000000002','simple-cleanup-device');
select pg_temp.assert_simple((public.close_health_session('b5100000-0000-0000-0000-000000000002')->>'cloud_deleted')::boolean,'acknowledged close deletes cloud workflow');
select pg_temp.expect_simple_error($sql$select public.simple_check_in_participant('b5100000-0000-0000-0000-000000000002','CLOSED','Closed','男','一般')$sql$,'session_not_active');
reset role;
select pg_temp.assert_simple((select status='closed' from public.health_sessions where id='b5100000-0000-0000-0000-000000000002')
  and not exists(select 1 from public.simple_queue_counters where session_id='b5100000-0000-0000-0000-000000000002')
  and not exists(select 1 from public.rooms where session_id='b5100000-0000-0000-0000-000000000002')
  and not exists(select 1 from public.participants where session_id='b5100000-0000-0000-0000-000000000002'),'simple completed close cleans cloud data and retains mode');
set local role authenticated;
select public.delete_health_session('b5100000-0000-0000-0000-000000000001');
reset role;
select pg_temp.assert_simple(not exists(select 1 from public.health_sessions where id='b5100000-0000-0000-0000-000000000001')
  and not exists(select 1 from public.participants where session_id='b5100000-0000-0000-0000-000000000001')
  and not exists(select 1 from public.simple_queue_counters where session_id='b5100000-0000-0000-0000-000000000001')
  and not exists(select 1 from public.rooms where session_id='b5100000-0000-0000-0000-000000000001'),'simple delete cascades workflow data');
select pg_temp.assert_simple((select count(*)=3 from public.participants where session_id='b5100000-0000-0000-0000-000000000003')
  and (select last_value=2 from public.group_counters where session_id='b5100000-0000-0000-0000-000000000003' and group_code='A'),'simple cleanup preserves standard schedule and counters');
\echo 'PASS: simple clear/reset, acknowledgement-aware close, delete/cascade and cross-session standard isolation'
rollback;
