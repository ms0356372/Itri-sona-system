-- Exercise real database behavior with isolated sessions. Company Master and
-- national-ID validation remain local and are covered by the frontend tests.
begin;
create function pg_temp.assert_manual_gender(p_ok boolean,p_message text)
returns void language plpgsql as $$ begin
  if p_ok is distinct from true then raise exception 'FAIL: %',p_message; end if;
end $$;
create function pg_temp.expect_manual_gender_error(p_sql text,p_error text,p_state text default 'P0001')
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

insert into auth.users(id,email) values
  ('e5000000-0000-0000-0000-000000000001','manual.registration@itri.example.com'),
  ('e5000000-0000-0000-0000-000000000002','manual.console@itri.example.com'),
  ('e5000000-0000-0000-0000-000000000003','manual.no-access@itri.example.com');
update public.staff_permissions set can_registration=true
where user_id='e5000000-0000-0000-0000-000000000001';
update public.staff_permissions set can_console=true
where user_id='e5000000-0000-0000-0000-000000000002';
insert into public.health_sessions(id,session_date,company_name,created_by,workflow_mode) values
  ('e5100000-0000-0000-0000-000000000001',(clock_timestamp() at time zone 'Asia/Taipei')::date,
    'Optional manual gender simple','e5000000-0000-0000-0000-000000000001','simple'),
  ('e5100000-0000-0000-0000-000000000002',(clock_timestamp() at time zone 'Asia/Taipei')::date,
    'Optional manual gender standard','e5000000-0000-0000-0000-000000000001','standard');

set local request.jwt.claim.sub='e5000000-0000-0000-0000-000000000001';
set local role authenticated;
create temporary table manual_gender_replies(label text primary key,reply jsonb);
insert into manual_gender_replies select 'blank',to_jsonb(public.simple_check_in_participant(
  'e5100000-0000-0000-0000-000000000001',' 00125 ',' 新生甲 ','','一般',''));
insert into manual_gender_replies select 'whitespace',to_jsonb(public.simple_check_in_participant(
  'e5100000-0000-0000-0000-000000000001','00126','新生乙','   ','一般'));
insert into manual_gender_replies select 'null',to_jsonb(public.simple_check_in_participant(
  'e5100000-0000-0000-0000-000000000001','00127','新生丙',null,'一般'));
select pg_temp.assert_manual_gender((select count(*)=3 and bool_and(
  reply->>'gender'='' and reply->'planned_items'='["一般"]'::jsonb
  and reply->>'note'='' and reply->>'status'='等候中'
  and reply->>'group_code' is null and reply->>'schedule_slot' is null
  and reply->>'checkin_sequence' is null
  and (reply->>'checked_in_at')::timestamptz between transaction_timestamp() and clock_timestamp()
  and not (reply ?| array['national_id','nationalId'])
) from manual_gender_replies),'blank/whitespace/NULL gender normalize to empty without fake values, groups, slots or national IDs');
select pg_temp.assert_manual_gender((select reply->>'employee_no'='00125' and reply->>'full_name'='新生甲'
  and reply->>'queue_number'='1' and reply->>'checkin_no'='1' from manual_gender_replies where label='blank'),
  'trimmed employee number preserves leading zeros and first numeric ticket');
select pg_temp.assert_manual_gender((select reply->>'queue_number'='2' and reply->>'checkin_no'='2'
  from manual_gender_replies where label='whitespace')
  and (select reply->>'queue_number'='3' and reply->>'checkin_no'='3'
    from manual_gender_replies where label='null'),'optional gender uses the original sequence 1/2/3');
select pg_temp.assert_manual_gender(to_jsonb(public.simple_check_in_participant(
  'e5100000-0000-0000-0000-000000000001','00125','新生甲',null,'另一項目','9999'))
  =(select reply from manual_gender_replies where label='blank'),
  'rescan returns original full row, time, queue, item and empty extension');

-- Identity and the other required cloud fields retain their exact old rules.
select pg_temp.expect_manual_gender_error($sql$select public.simple_check_in_participant(
  'e5100000-0000-0000-0000-000000000001','00125','新生甲','男','一般')$sql$,'simple_identity_conflict');
select pg_temp.expect_manual_gender_error($sql$select public.simple_check_in_participant(
  'e5100000-0000-0000-0000-000000000001','00125','不同姓名','','一般')$sql$,'simple_identity_conflict');
select pg_temp.expect_manual_gender_error($sql$select public.simple_check_in_participant(
  'e5100000-0000-0000-0000-000000000001','   ','姓名','','一般')$sql$,'invalid_simple_participant');
select pg_temp.expect_manual_gender_error($sql$select public.simple_check_in_participant(
  'e5100000-0000-0000-0000-000000000001','EMPTYNAME','   ','','一般')$sql$,'invalid_simple_participant');
select pg_temp.expect_manual_gender_error($sql$select public.simple_check_in_participant(
  'e5100000-0000-0000-0000-000000000001','EMPTYITEM','姓名','','   ')$sql$,'invalid_simple_participant');
set local request.jwt.claim.sub='e5000000-0000-0000-0000-000000000003';
select pg_temp.expect_manual_gender_error($sql$select public.simple_check_in_participant(
  'e5100000-0000-0000-0000-000000000001','NOPERMISSION','姓名','','一般')$sql$,'permission_denied','42501');
set local request.jwt.claim.sub='e5000000-0000-0000-0000-000000000002';
select public.set_waiting_status((select (reply->>'id')::uuid from manual_gender_replies where label='blank'),'上廁所');
insert into manual_gender_replies select 'after_status',to_jsonb(p) from public.participants p
where p.id=(select (reply->>'id')::uuid from manual_gender_replies where label='blank');
set local request.jwt.claim.sub='e5000000-0000-0000-0000-000000000001';
select pg_temp.assert_manual_gender(to_jsonb(public.simple_check_in_participant(
  'e5100000-0000-0000-0000-000000000001','00125','新生甲','   ','一般'))
  =(select reply from manual_gender_replies where label='after_status'),
  'optional-gender rescan preserves an existing operational status and timestamps');
reset role;
select pg_temp.assert_manual_gender((select count(*)=3 from public.participants
  where session_id='e5100000-0000-0000-0000-000000000001')
  and (select next_number=4 from public.simple_queue_counters
    where session_id='e5100000-0000-0000-0000-000000000001')
  and not exists(select 1 from public.group_counters where session_id='e5100000-0000-0000-0000-000000000001'),
  'duplicate, invalid fields, identity conflicts and permission rejection never consume another ticket');
\echo 'PASS: simple manual empty/whitespace/NULL gender, leading-zero employee, DB time, items, privacy, identity/permission guards and duplicate preservation'

-- Browser registration INSERT plus the original standard check-in RPC still
-- require a real slot/group and keep independent A/B counter behavior.
set local role authenticated;
create temporary table manual_standard_participants as
with created as (
  insert into public.participants(session_id,sequence_no,employee_no,full_name,gender,schedule_slot,group_code,planned_items)
  values
    ('e5100000-0000-0000-0000-000000000002',1,'00001','Standard empty gender','','07:30~08:00','A',array['一般']),
    ('e5100000-0000-0000-0000-000000000002',2,'00002','Standard gender present','男','07:30~08:00','A',array['一般']),
    ('e5100000-0000-0000-0000-000000000002',3,'00003','Standard empty gender B','','08:00~08:30','B',array['一般'])
  returning id,employee_no
) select * from created;
insert into manual_gender_replies select 'standard_a1',to_jsonb(public.check_in_participant(id))
from manual_standard_participants where employee_no='00001';
insert into manual_gender_replies select 'standard_a2',to_jsonb(public.check_in_participant(id))
from manual_standard_participants where employee_no='00002';
insert into manual_gender_replies select 'standard_b1',to_jsonb(public.check_in_participant(id))
from manual_standard_participants where employee_no='00003';
select pg_temp.assert_manual_gender((select reply->>'checkin_no'='A1' and reply->>'gender'=''
  and reply->>'employee_no'='00001' and reply->'planned_items'='["一般"]'::jsonb and reply->>'queue_number' is null
  from manual_gender_replies where label='standard_a1')
  and (select reply->>'checkin_no'='A2' and reply->>'gender'='男' from manual_gender_replies where label='standard_a2')
  and (select reply->>'checkin_no'='B1' and reply->>'gender'='' from manual_gender_replies where label='standard_b1'),
  'standard blank-gender INSERT/check-in keeps A1/A2/B1, master item, employee zeros and null simple queue');
select pg_temp.assert_manual_gender(to_jsonb(public.check_in_participant(
  (select id from manual_standard_participants where employee_no='00001')))
  =(select reply from manual_gender_replies where label='standard_a1'),
  'standard repeated empty-gender check-in returns the original full row');
reset role;
select pg_temp.assert_manual_gender((select last_value=2 from public.group_counters
  where session_id='e5100000-0000-0000-0000-000000000002' and group_code='A')
  and (select last_value=1 from public.group_counters
    where session_id='e5100000-0000-0000-0000-000000000002' and group_code='B')
  and not exists(select 1 from public.simple_queue_counters where session_id='e5100000-0000-0000-0000-000000000002'),
  'standard and simple counters retain separate unchanged rules');
\echo 'PASS: standard manual blank-gender INSERT/check-in, A1/A2/B1, group counter isolation and repeated-check-in regression'
rollback;
