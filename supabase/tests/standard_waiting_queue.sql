-- Actual migrated PostgreSQL functions, grants, masks and row locks are tested.
-- Fixtures deliberately use supplied server timestamps; no device clock enters
-- a classification or queue key. Every fixture rolls back after this suite.
begin;
set local timezone='UTC';
create function pg_temp.assert_standard(p_ok boolean,p_message text)
returns void language plpgsql as $$ begin
  if p_ok is distinct from true then raise exception 'FAIL: %',p_message; end if;
end $$;
create function pg_temp.standard_error(p_sql text,p_message text,p_state text default 'P0001')
returns void language plpgsql as $$ declare rejected boolean:=false; begin
  begin execute p_sql;
  exception when others then
    if sqlstate<>p_state or sqlerrm<>p_message then raise; end if;
    rejected:=true;
  end;
  if not rejected then raise exception 'FAIL: expected % for %',p_message,p_sql; end if;
end $$;
create function pg_temp.standard_denied(p_sql text)
returns void language plpgsql as $$ declare rejected boolean:=false; begin
  begin execute p_sql; exception when insufficient_privilege then rejected:=true; end;
  if not rejected then raise exception 'FAIL: unexpectedly allowed %',p_sql; end if;
end $$;
create function pg_temp.standard_person(p_session uuid,p_employee text,p_group text,p_checked timestamptz,
  p_number text default null,p_checkin_sequence integer default null,p_sequence integer default 1,
  p_status public.work_status default '等候中')
returns uuid language plpgsql as $$ declare person_id uuid:=md5(p_session::text||':'||p_employee)::uuid; begin
  insert into public.participants(id,session_id,sequence_no,employee_no,full_name,gender,schedule_slot,
    group_code,planned_items,checkin_no,checkin_sequence,checked_in_at,status,note)
  values(person_id,p_session,p_sequence,p_employee,'王小明','女','07:30~08:00',p_group,
    array['腹部超音波'],p_number,p_checkin_sequence,p_checked,p_status,'private-extension-9876');
  return person_id;
end $$;
create function pg_temp.standard_order(p_session uuid,p_expected text[],p_base boolean default false)
returns void language plpgsql as $$ declare actual text[]; positions bigint[]; begin
  if p_base then
    select array_agg(p.employee_no order by q.queue_position),array_agg(q.queue_position order by q.queue_position)
    into actual,positions from public.standard_base_queue(p_session) q join public.participants p on p.id=q.participant_id;
  else
    select array_agg(p.employee_no order by q.queue_position),array_agg(q.queue_position order by q.queue_position)
    into actual,positions from public.build_standard_waiting_queue(p_session) q join public.participants p on p.id=q.participant_id;
  end if;
  perform pg_temp.assert_standard(coalesce(actual,'{}')=p_expected,
    'queue mismatch; expected '||p_expected::text||', got '||coalesce(actual,'{}')::text);
  perform pg_temp.assert_standard(coalesce(positions,'{}')=array(select generate_series(1,cardinality(p_expected))::bigint),
    'positions are recomputed contiguously from one');
end $$;

insert into auth.users(id,email) values
  ('d7000000-0000-0000-0000-000000000001','standard.queue.console@itri.example.com'),
  ('d7000000-0000-0000-0000-000000000002','standard.queue.registration@itri.example.com');
update public.staff_permissions set can_console=true where user_id='d7000000-0000-0000-0000-000000000001';
update public.staff_permissions set can_registration=true where user_id='d7000000-0000-0000-0000-000000000002';
insert into public.health_sessions(id,session_date,company_name,created_by,workflow_mode,status) values
  ('d7100000-0000-0000-0000-000000000001',(clock_timestamp() at time zone 'Asia/Taipei')::date,'Standard queue base','d7000000-0000-0000-0000-000000000002','standard','active'),
  ('d7100000-0000-0000-0000-000000000002',(clock_timestamp() at time zone 'Asia/Taipei')::date,'Standard queue promotion','d7000000-0000-0000-0000-000000000002','standard','active'),
  ('d7100000-0000-0000-0000-000000000003',(clock_timestamp() at time zone 'Asia/Taipei')::date,'Standard queue simple isolation','d7000000-0000-0000-0000-000000000002','simple','active'),
  ('d7100000-0000-0000-0000-000000000004',(clock_timestamp() at time zone 'Asia/Taipei')::date,'Standard server check-in','d7000000-0000-0000-0000-000000000002','standard','active'),
  ('d7100000-0000-0000-0000-000000000005',(clock_timestamp() at time zone 'Asia/Taipei')::date-1,'Standard closed queue','d7000000-0000-0000-0000-000000000002','standard','closed');

-- Infer effective group from the real Base Queue against seven early sentinels.
-- This exercises CASE 1-7 and each boundary, including fractional seconds.
do $$ declare scenario record; group_code text; position bigint; expected bigint; begin
  for scenario in select * from (values
    ('A','07:50:00','A'),('A','08:10:00','B'),('A','09:10:00','D'),
    ('C','08:05:00','C'),('G','07:40:00','G'),('G','07:15:00','G'),('A','11:15:00','G'),
    ('A','00:00:00','A'),('A','07:29:59.999999','A'),('A','07:30:00','A'),
    ('A','07:59:59.999999','A'),('A','08:00:00','B'),('A','08:29:59.999999','B'),
    ('A','08:30:00','C'),('A','08:59:59.999999','C'),('A','09:00:00','D'),
    ('A','09:29:59.999999','D'),('A','09:30:00','E'),('A','09:59:59.999999','E'),
    ('A','10:00:00','F'),('A','10:29:59.999999','F'),('A','10:30:00','G'),
    ('A','10:59:59.999999','G'),('A','11:00:00','G'),('A','23:59:59.999999','G')
  ) cases(scheduled,clock,expected_group) loop
    delete from public.participants where session_id='d7100000-0000-0000-0000-000000000001';
    foreach group_code in array array['A','B','C','D','E','F','G'] loop
      perform pg_temp.standard_person('d7100000-0000-0000-0000-000000000001','sentinel-'||group_code,
        group_code,'2026-10-15T00:00:00+08:00',group_code||'1');
    end loop;
    perform pg_temp.standard_person('d7100000-0000-0000-0000-000000000001','target',scenario.scheduled,
      (date '2026-10-16'+scenario.clock::time) at time zone 'Asia/Taipei',scenario.scheduled||'999');
    select q.queue_position into position from public.standard_base_queue('d7100000-0000-0000-0000-000000000001') q
    join public.participants p on p.id=q.participant_id where p.employee_no='target';
    expected:=ascii(scenario.expected_group)-ascii('A')+2;
    perform pg_temp.assert_standard(position=expected,scenario.scheduled||' at Taiwan '||scenario.clock||' must have effective '||scenario.expected_group);
  end loop;
end $$;
\echo 'PASS: standard SQL effective groups CASE 1-7, all seven slot boundaries, microseconds and A/G clamping'

delete from public.participants where session_id='d7100000-0000-0000-0000-000000000001';
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000001','B3','B','2026-10-16T08:12:00+08:00','B3',3,1);
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000001','A8','A','2026-10-16T00:10:00Z','A8',8,2);
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000001','B2','B','2026-10-16T08:06:00+08:00','B2',2,3);
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000001','B1','B','2026-10-16T08:02:00+08:00','B1',1,999);
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000001','A5','A','2026-10-16T07:50:00+08:00','A5',5,1000);
select pg_temp.standard_order('d7100000-0000-0000-0000-000000000001',array['A5','B1','B2','A8','B3'],true);
set local timezone='Pacific/Honolulu';
select pg_temp.standard_order('d7100000-0000-0000-0000-000000000001',array['A5','B1','B2','A8','B3'],true);
set local timezone='UTC';
select pg_temp.standard_order('d7100000-0000-0000-0000-000000000001',array['A5','B1','B2','A8','B3']);
\echo 'PASS: CASE 8-11 actual server completion order wins over schedule sequence; UTC/offset/connection time zone do not change queue'

-- Equal timestamp fallbacks use the real per-group counter, then numeric suffix,
-- and only then schedule sequence. Distinct original groups permit tied counters.
delete from public.participants where session_id='d7100000-0000-0000-0000-000000000001';
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000001','micro-first','B','2026-10-16T00:10:00.123001Z','B99',99,999);
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000001','micro-second','B','2026-10-16T08:10:00.123999+08:00','B1',1,1);
select pg_temp.standard_order('d7100000-0000-0000-0000-000000000001',array['micro-first','micro-second'],true);
delete from public.participants where session_id='d7100000-0000-0000-0000-000000000001';
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000001','counter-first','A','2026-10-16T08:10:00+08:00','A99',2,999);
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000001','counter-second','B','2026-10-16T08:10:00+08:00','B1',3,1);
select pg_temp.standard_order('d7100000-0000-0000-0000-000000000001',array['counter-first','counter-second'],true);
delete from public.participants where session_id='d7100000-0000-0000-0000-000000000001';
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000001','suffix-ten','A','2026-10-16T08:10:00+08:00','A10',1,1);
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000001','suffix-two','B','2026-10-16T08:10:00+08:00','B2',1,999);
select pg_temp.standard_order('d7100000-0000-0000-0000-000000000001',array['suffix-two','suffix-ten'],true);
delete from public.participants where session_id='d7100000-0000-0000-0000-000000000001';
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000001','sequence-later','A','2026-10-16T08:10:00+08:00','A2',1,99);
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000001','sequence-first','B','2026-10-16T08:10:00+08:00','B2',1,1);
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000001','legacy-missing','A',null,null,null,1);
select pg_temp.standard_order('d7100000-0000-0000-0000-000000000001',array['sequence-first','sequence-later','legacy-missing'],true);
insert into public.participants(session_id,sequence_no,employee_no,full_name,schedule_slot,group_code,status)
select 'd7100000-0000-0000-0000-000000000001',10+ordinality::integer,'excluded-'||ordinality,'排除人員','07:30~08:00','A',status::public.work_status
from unnest(array['未報到','已叫號','上廁所','心電圖','先做其他','檢查中','已完成']) with ordinality statuses(status,ordinality);
select pg_temp.standard_order('d7100000-0000-0000-0000-000000000001',array['sequence-first','sequence-later','legacy-missing']);
\echo 'PASS: precise server microseconds, actual checkin_sequence, numeric suffix, last sequence fallback, legacy NULL time and seven excluded statuses'

-- Real check-in RPCs retain their server clocks, per-group A1/A2/B1 tickets,
-- idempotency and simple numeric numbering without receiving any time argument.
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000004','server-a1','A',null,null,null,1,'未報到');
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000004','server-a2','A',null,null,null,2,'未報到');
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000004','server-b1','B',null,null,null,3,'未報到');
set local request.jwt.claim.sub='d7000000-0000-0000-0000-000000000002';
set local role authenticated;
create temporary table standard_checkin_replies as
select employee_no,to_jsonb(public.check_in_participant(id)) reply
from public.participants where session_id='d7100000-0000-0000-0000-000000000004' order by sequence_no;
select pg_temp.assert_standard((select array_agg(reply->>'checkin_no' order by employee_no)=array['A1','A2','B1']
  and bool_and((reply->>'checked_in_at')::timestamptz between transaction_timestamp() and clock_timestamp())
  from standard_checkin_replies),'standard uses Database Server time and preserves A1/A2/B1');
select pg_temp.assert_standard((select bool_and(to_jsonb(public.check_in_participant((reply->>'id')::uuid))=reply)
  from standard_checkin_replies),'repeat standard check-in preserves complete original row and clock');
select public.simple_check_in_participant('d7100000-0000-0000-0000-000000000003','simple-1','林小華','','一般');
select public.simple_check_in_participant('d7100000-0000-0000-0000-000000000003','simple-2','陳建志','','一般');
reset role;
select pg_temp.assert_standard((select bool_and(promoted_at is null and promoted_after_key is null)
  from public.participants where session_id='d7100000-0000-0000-0000-000000000003'),'simple tickets have no promotion state');
create temporary table standard_simple_snapshot as select to_jsonb(p) record from public.participants p
where session_id='d7100000-0000-0000-0000-000000000003';
\echo 'PASS: untouched standard server check-in, original counters/tickets and idempotency; simple numbering and NULL promotion state'

-- CASE 12-16: snapshot only the normal people occupying the first three when
-- arranging, so an arranged fourth person naturally advances as people depart.
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000002','A3','A','2026-10-16T07:35:00+08:00','A3',3,99);
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000002','A5','A','2026-10-16T07:40:00+08:00','A5',5,98);
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000002','B1','B','2026-10-16T08:01:00+08:00','B1',1,97);
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000002','B3','B','2026-10-16T08:03:00+08:00','B3',3,1);
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000002','C2','C','2026-10-16T07:20:00+08:00','C2',2,2);
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000002','F2','F','2026-10-16T07:20:00+08:00','F2',2,3);
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000002','G1','G','2026-10-16T07:20:00+08:00','G1',1,4);
create temporary table standard_promotion_business_snapshot as
select id,to_jsonb(p)-array['promoted_at','promoted_after_key','updated_at'] record
from public.participants p where session_id='d7100000-0000-0000-0000-000000000002';
create temporary table standard_promote_started as select clock_timestamp() as started;
grant select on standard_promote_started to authenticated;
set local request.jwt.claim.sub='d7000000-0000-0000-0000-000000000001';
set local role authenticated;
select pg_temp.standard_error($sql$select public.promote_waiting_participant((select id from public.participants where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='A3'))$sql$,'protected_top_three');
select public.promote_waiting_participant((select id from public.participants where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='G1'));
select pg_temp.assert_standard((select promoted_at between (select started from standard_promote_started) and clock_timestamp()
  and status='等候中' and promoted_after_key is not null from public.participants
  where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='G1'),'promotion stores Database Server time and boundary, keeps waiting status');
create temporary table standard_first_promotion as select to_jsonb(p) record from public.participants p
where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='G1';
select public.promote_waiting_participant((select id from public.participants where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='G1'));
select pg_temp.assert_standard((select to_jsonb(p)=(select record from standard_first_promotion) from public.participants p
  where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='G1'),'repeat promote preserves original timestamp and full row');
reset role;
select pg_temp.standard_order('d7100000-0000-0000-0000-000000000002',array['A3','A5','B1','G1','B3','C2','F2']);
select pg_temp.assert_standard(not exists(select 1 from standard_promotion_business_snapshot old
  join public.participants p using(id) where old.record is distinct from to_jsonb(p)-array['promoted_at','promoted_after_key','updated_at']),
  'promotion changes neither original check-in identity/time/counter nor medical fields');
set local role authenticated;
select public.promote_waiting_participant((select id from public.participants where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='F2'));
reset role;
select pg_temp.standard_order('d7100000-0000-0000-0000-000000000002',array['A3','A5','B1','G1','F2','B3','C2']);
set local role authenticated;
select public.call_participant((select id from public.participants where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='A3'));
reset role;
select pg_temp.standard_order('d7100000-0000-0000-0000-000000000002',array['A5','B1','G1','F2','B3','C2']);
set local role authenticated;
select public.promote_waiting_participant((select id from public.participants where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='G1'));
select pg_temp.assert_standard((select promoted_at=(select (record->>'promoted_at')::timestamptz from standard_first_promotion)
  from public.participants where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='G1'),'retry after natural advance to third remains idempotent');
select public.set_waiting_status((select id from public.participants where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='G1'),'上廁所');
reset role;
select pg_temp.standard_order('d7100000-0000-0000-0000-000000000002',array['A5','B1','F2','B3','C2']);
set local role authenticated;
select public.set_waiting_status((select id from public.participants where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='G1'),'等候中');
reset role;
select pg_temp.standard_order('d7100000-0000-0000-0000-000000000002',array['A5','B1','G1','F2','B3','C2']);
set local role authenticated;
select public.cancel_promoted_participant((select id from public.participants where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='G1'));
reset role;
select pg_temp.standard_order('d7100000-0000-0000-0000-000000000002',array['A5','B1','F2','B3','C2','G1']);
select pg_temp.assert_standard((select promoted_at is null and promoted_after_key is null from public.participants
  where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='G1'),'cancel clears timestamp and insertion boundary');
set local role authenticated;
select public.cancel_promoted_participant((select id from public.participants where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='F2'));
reset role;
select pg_temp.standard_order('d7100000-0000-0000-0000-000000000002',array['A5','B1','B3','C2','F2','G1']);
\echo 'PASS: CASE 12-16 protected current three, FIFO promotions, exact retries, natural fourth-to-third advance, departure/return and cancel back to Base Queue'

-- A later promotion must not retain an earlier promoted person as a normal
-- anchor. Cancelling P1 cannot drag P2 back behind the normal D/E people.
delete from public.participants where session_id='d7100000-0000-0000-0000-000000000002';
do $$ declare employee text; position integer:=0; begin
  foreach employee in array array['A','B','C','D','E','P1','P2'] loop
    position:=position+1;
    perform pg_temp.standard_person('d7100000-0000-0000-0000-000000000002',employee,'A',
      '2026-10-16T07:30:00+08:00'::timestamptz+position*interval '1 minute','A'||position,position,position);
  end loop;
end $$;
set local role authenticated;
select public.promote_waiting_participant((select id from public.participants where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='P1'));
select public.call_participant((select id from public.participants where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='A'));
select public.promote_waiting_participant((select id from public.participants where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='P2'));
select pg_temp.assert_standard((select promoted_after_key is not null from public.participants
  where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='P2'),
  'later promotion stores an immutable normal Base Queue boundary');
select public.cancel_promoted_participant((select id from public.participants where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='P1'));
reset role;
select pg_temp.standard_order('d7100000-0000-0000-0000-000000000002',array['B','C','P2','D','E','P1']);
\echo 'PASS: cancelling an earlier promotion never strands a later promoted third person behind normal Base Queue rows'

-- An insertion boundary inherited from an earlier promotion survives that
-- person's departure. A newly checked-in normal X must keep its third place.
delete from public.participants where session_id='d7100000-0000-0000-0000-000000000002';
do $$ declare employee text; position integer:=0; begin
  foreach employee in array array['A','B','C','D','P1','P2'] loop
    position:=position+1;
    perform pg_temp.standard_person('d7100000-0000-0000-0000-000000000002',employee,'A',
      '2026-10-16T07:30:00+08:00'::timestamptz+position*interval '1 minute','A'||position,position,position);
  end loop;
end $$;
set local role authenticated;
select public.promote_waiting_participant((select id from public.participants where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='P1'));
select public.call_participant((select id from public.participants where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='C'));
select public.promote_waiting_participant((select id from public.participants where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='P2'));
reset role;
select pg_temp.standard_order('d7100000-0000-0000-0000-000000000002',array['A','B','P1','P2','D']);
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000002','X','A','2026-10-16T07:32:30+08:00','A99',99,99);
select pg_temp.standard_order('d7100000-0000-0000-0000-000000000002',array['A','B','X','P1','P2','D']);
set local role authenticated;
select public.call_participant((select id from public.participants where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='P1'));
reset role;
select pg_temp.standard_order('d7100000-0000-0000-0000-000000000002',array['A','B','X','P2','D']);
\echo 'PASS: inherited immutable boundary keeps new third-place arrivals protected after an earlier promoted person departs'

-- Check the authenticated and anonymous boundaries over one exact snapshot.
insert into public.session_public_boards(session_id,public_board_token,public_board_enabled)
values('d7100000-0000-0000-0000-000000000002',repeat('9',64),true),
  ('d7100000-0000-0000-0000-000000000003',repeat('8',64),true);
set local role authenticated;
create temporary table standard_expected_public as
select jsonb_agg(jsonb_build_object('employeeNo',p.employee_no,'maskedName','王○明') order by q.queue_position) people
from public.get_standard_waiting_queue('d7100000-0000-0000-0000-000000000002') q join public.participants p on p.id=q.participant_id;
grant select on standard_expected_public to anon;
select pg_temp.standard_error($sql$select public.get_standard_waiting_queue('d7100000-0000-0000-0000-000000000003')$sql$,'invalid_workflow_mode');
select pg_temp.standard_error($sql$select public.promote_waiting_participant((select id from public.participants where session_id='d7100000-0000-0000-0000-000000000003' and employee_no='simple-1'))$sql$,'invalid_workflow_mode');
select pg_temp.standard_error($sql$select public.cancel_promoted_participant((select id from public.participants where session_id='d7100000-0000-0000-0000-000000000003' and employee_no='simple-1'))$sql$,'invalid_workflow_mode');
select pg_temp.standard_error($sql$select public.promote_waiting_participant('ffffffff-ffff-ffff-ffff-ffffffffffff')$sql$,'participant_not_found');
select pg_temp.standard_error($sql$select public.cancel_promoted_participant('ffffffff-ffff-ffff-ffff-ffffffffffff')$sql$,'participant_not_found');
select pg_temp.standard_denied($sql$select public.standard_base_queue('d7100000-0000-0000-0000-000000000002')$sql$);
select pg_temp.standard_denied($sql$select public.build_standard_waiting_queue('d7100000-0000-0000-0000-000000000002')$sql$);
select pg_temp.standard_denied($sql$update public.participants set promoted_at=clock_timestamp() where session_id='d7100000-0000-0000-0000-000000000002'$sql$);
select pg_temp.standard_denied($sql$update public.participants set promoted_after_key='{}' where session_id='d7100000-0000-0000-0000-000000000002'$sql$);
reset role;
set local role anon;
set local request.jwt.claim.sub='';
do $$ declare board jsonb; person jsonb; begin
  board:=public.get_public_waiting_board(repeat('9',64));
  perform pg_temp.assert_standard(board->'people'=(select people from standard_expected_public),'public RPC and console use exactly one canonical final queue');
  for person in select value from jsonb_array_elements(board->'people') loop
    perform pg_temp.assert_standard((select array_agg(key order by key) from jsonb_object_keys(person) key)=array['employeeNo','maskedName'],
      'public payload has no participant id, original ticket, timestamps, promotion, status or medical fields');
  end loop;
  perform pg_temp.assert_standard(board::text !~ '王小明|腹部超音波|9876|d7100000|promoted|checked_in|checkin|queue_position',
    'private identity, timestamps and ordering values never reach anonymous clients');
  perform pg_temp.assert_standard(public.get_public_waiting_board(repeat('8',64))->'people'=
    '[{"employeeNo":"simple-1","maskedName":"林○華"},{"employeeNo":"simple-2","maskedName":"陳○志"}]'::jsonb,
    'simple public order is still numeric queue 1/2 without any standard promotion rule');
end $$;
select pg_temp.standard_denied('select * from public.participants');
select pg_temp.standard_denied($sql$select public.get_standard_waiting_queue('d7100000-0000-0000-0000-000000000002')$sql$);
select pg_temp.standard_denied($sql$select public.standard_base_queue('d7100000-0000-0000-0000-000000000002')$sql$);
select pg_temp.standard_denied($sql$select public.build_standard_waiting_queue('d7100000-0000-0000-0000-000000000002')$sql$);
select pg_temp.standard_denied($sql$select public.promote_waiting_participant('ffffffff-ffff-ffff-ffff-ffffffffffff')$sql$);
select pg_temp.standard_denied($sql$select public.cancel_promoted_participant('ffffffff-ffff-ffff-ffff-ffffffffffff')$sql$);
reset role;
\echo 'PASS: CASE 18-21 canonical console/public parity, exact anonymous allowlist, unchanged simple order, private helper denial and no direct promotion writes'

-- CASE 17: every non-waiting status is rejected, even for a previously arranged
-- person. Closed sessions and missing Auth are rejected at the server boundary.
select pg_temp.standard_person('d7100000-0000-0000-0000-000000000005','closed','A','2026-10-16T07:40:00+08:00','A1');
set local request.jwt.claim.sub='d7000000-0000-0000-0000-000000000001';
set local role authenticated;
select pg_temp.standard_error($sql$select public.promote_waiting_participant((select id from public.participants where session_id='d7100000-0000-0000-0000-000000000005' and employee_no='closed'))$sql$,'session_not_active');
select pg_temp.standard_error($sql$select public.cancel_promoted_participant((select id from public.participants where session_id='d7100000-0000-0000-0000-000000000005' and employee_no='closed'))$sql$,'session_not_active');
reset role;
do $$ declare next_status public.work_status; person_id uuid; begin
  select id into person_id from public.participants where session_id='d7100000-0000-0000-0000-000000000002' and employee_no='P2';
  foreach next_status in array array['未報到','已叫號','上廁所','心電圖','先做其他','檢查中','已完成']::public.work_status[] loop
    update public.participants set status=next_status where id=person_id;
    execute 'set local role authenticated';
    perform pg_temp.standard_error(format('select public.promote_waiting_participant(%L)',person_id),'invalid_state');
    perform pg_temp.standard_error(format('select public.cancel_promoted_participant(%L)',person_id),'invalid_state');
    execute 'reset role';
  end loop;
end $$;
select pg_temp.assert_standard(not exists(
  (select to_jsonb(p) from public.participants p where session_id='d7100000-0000-0000-0000-000000000003'
    except all select record from standard_simple_snapshot)
  union all (select record from standard_simple_snapshot except all select to_jsonb(p) from public.participants p
    where session_id='d7100000-0000-0000-0000-000000000003')),'standard queue work never changes simple participant data');
set local role authenticated;
set local request.jwt.claim.sub='';
select pg_temp.standard_error($sql$select public.get_standard_waiting_queue('d7100000-0000-0000-0000-000000000002')$sql$,'permission_denied','42501');
select pg_temp.standard_error($sql$select public.promote_waiting_participant('ffffffff-ffff-ffff-ffff-ffffffffffff')$sql$,'permission_denied','42501');
select pg_temp.standard_error($sql$select public.cancel_promoted_participant('ffffffff-ffff-ffff-ffff-ffffffffffff')$sql$,'permission_denied','42501');
reset role;
select pg_temp.assert_standard((select count(*)=3 from pg_proc where oid in(
  'public.get_standard_waiting_queue(uuid)'::regprocedure,'public.promote_waiting_participant(uuid)'::regprocedure,
  'public.cancel_promoted_participant(uuid)'::regprocedure) and prosecdef and proconfig @> array['search_path=""']),
  'all new boundary RPCs are SECURITY DEFINER with empty search path');
select pg_temp.assert_standard(not has_function_privilege('authenticated','public.standard_queue_key(text,text,timestamp with time zone,integer,text,integer,uuid)','EXECUTE')
  and not has_function_privilege('anon','public.standard_queue_key(text,text,timestamp with time zone,integer,text,integer,uuid)','EXECUTE')
  and not has_function_privilege('authenticated','public.standard_queue_schedule()','EXECUTE')
  and not has_function_privilege('anon','public.standard_queue_schedule()','EXECUTE'),
  'immutable Base Queue key and schedule helpers are private to trusted SQL wrappers');
select pg_temp.assert_standard(not has_column_privilege('authenticated','public.participants','promoted_at','INSERT,UPDATE')
  and not has_column_privilege('authenticated','public.participants','promoted_after_key','INSERT,UPDATE'),
  'both promotion columns stay outside direct browser INSERT/UPDATE grants');
\echo 'PASS: CASE 17 non-waiting states, closed sessions, missing auth, definer/search_path/column ACL guards and cross-mode isolation'
rollback;
