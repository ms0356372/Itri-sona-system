-- Exercise the real security boundary as anon/authenticated, not just the UI.
begin;
create function pg_temp.assert_board(p_ok boolean,p_message text)
returns void language plpgsql as $$ begin
  if p_ok is distinct from true then raise exception 'FAIL: %',p_message; end if;
end $$;
create function pg_temp.board_denied(p_sql text,p_message text default null)
returns void language plpgsql as $$
declare rejected boolean:=false;
begin
  begin execute p_sql;
  exception when insufficient_privilege then
    if p_message is not null and sqlerrm<>p_message then raise; end if;
    rejected:=true;
  end;
  if not rejected then raise exception 'FAIL: allowed %',p_sql; end if;
end $$;
create function pg_temp.board_error(p_sql text,p_message text)
returns void language plpgsql as $$
declare rejected boolean:=false;
begin
  begin execute p_sql;
  exception when raise_exception then
    if sqlerrm<>p_message then raise; end if;
    rejected:=true;
  end;
  if not rejected then raise exception 'FAIL: expected % for %',p_message,p_sql; end if;
end $$;

select pg_temp.assert_board(public.mask_public_board_name('王小明')='王○明','three characters');
select pg_temp.assert_board(public.mask_public_board_name('陳建志')='陳○志','second three-character example');
select pg_temp.assert_board(public.mask_public_board_name('林美玲')='林○玲','third three-character example');
select pg_temp.assert_board(public.mask_public_board_name('王明')='王○','two characters');
select pg_temp.assert_board(public.mask_public_board_name('歐陽小明')='歐○○明','four characters');
select pg_temp.assert_board(public.mask_public_board_name('王')='○','one character never disclosed');
select pg_temp.assert_board(public.mask_public_board_name('  王小明  ')='王○明','surrounding spaces trimmed');
select pg_temp.assert_board(public.mask_public_board_name('𠮷小明')='𠮷○明','Unicode code points');
select pg_temp.assert_board(public.mask_public_board_name('')='' and public.mask_public_board_name(null)='','missing name');

create temporary table board_permission_cases as
select ('c5000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid user_id,
  n case_number,n<=8 and ((n-1)&4)>0 registration,
  n<=8 and ((n-1)&2)>0 console,n<=8 and ((n-1)&1)>0 room,n<=8 active
from generate_series(1,10) n;
grant select on board_permission_cases to authenticated;
insert into auth.users(id,email)
select user_id,'board.permission.'||case_number||'@itri.example.com' from board_permission_cases;
update public.staff_permissions p set can_registration=c.registration,can_console=c.console,can_room=c.room
from board_permission_cases c where p.user_id=c.user_id;
update public.staff_permissions set can_registration=true,can_console=true,can_room=true,is_active=false
where user_id='c5000000-0000-0000-0000-000000000009';
delete from public.staff_permissions where user_id='c5000000-0000-0000-0000-000000000010';

insert into public.health_sessions(id,session_date,company_name,created_by,workflow_mode)
values('c5100000-0000-0000-0000-000000000001','2026-10-15','Public standard','c5000000-0000-0000-0000-000000000005','standard'),
  ('c5100000-0000-0000-0000-000000000002','2026-10-15','Public simple','c5000000-0000-0000-0000-000000000005','simple'),
  ('c5100000-0000-0000-0000-000000000003','2026-10-15','Public clear','c5000000-0000-0000-0000-000000000005','standard'),
  ('c5100000-0000-0000-0000-000000000004','2026-10-15','Public empty','c5000000-0000-0000-0000-000000000005','simple'),
  ('c5100000-0000-0000-0000-000000000005','2026-10-15','Public deletion','c5000000-0000-0000-0000-000000000005','standard');

set local role authenticated;
do $$ declare permission_case record; endpoint text; begin
  for permission_case in select * from board_permission_cases order by case_number loop
    perform set_config('request.jwt.claim.sub',permission_case.user_id::text,true);
    foreach endpoint in array array[
      $sql$select public.get_public_board_settings('c5100000-0000-0000-0000-000000000001')$sql$,
      $sql$select public.set_public_board_enabled('c5100000-0000-0000-0000-000000000001',false)$sql$
    ] loop
      if permission_case.registration and permission_case.active then execute endpoint;
      else perform pg_temp.board_denied(endpoint,'permission_denied'); end if;
    end loop;
  end loop;
  perform set_config('request.jwt.claim.sub','',true);
  perform pg_temp.board_denied($sql$select public.get_public_board_settings('c5100000-0000-0000-0000-000000000001')$sql$,'permission_denied');
  perform pg_temp.board_denied($sql$select public.set_public_board_enabled('c5100000-0000-0000-0000-000000000001',true)$sql$,'permission_denied');
end $$;
set local request.jwt.claim.sub='c5000000-0000-0000-0000-000000000005';
select pg_temp.assert_board(public.get_public_board_settings('c5100000-0000-0000-0000-000000000001')='{"enabled":false,"token":null}'::jsonb,'new sessions default disabled without a token');
select pg_temp.board_error($sql$select public.set_public_board_enabled('ffffffff-ffff-ffff-ffff-ffffffffffff',true)$sql$,'not_authorized');
select pg_temp.board_error($sql$select public.set_public_board_enabled('c5100000-0000-0000-0000-000000000001',null)$sql$,'invalid_public_board_enabled');

create temporary table board_tokens(session_id uuid primary key,token text);
insert into board_tokens select id,public.set_public_board_enabled(id,true)->>'token'
from public.health_sessions where id::text like 'c5100000-%';
grant select,update on board_tokens to anon,authenticated;
select pg_temp.assert_board((select count(*)=5 and count(distinct token)=5 and bool_and(token ~ '^[0-9a-f]{64}$') from board_tokens),'strong unique tokens per session');
select pg_temp.assert_board((public.set_public_board_enabled('c5100000-0000-0000-0000-000000000001',true)->>'token')=(select token from board_tokens where session_id='c5100000-0000-0000-0000-000000000001'),'enabling an enabled board is idempotent');
select pg_temp.assert_board((public.get_public_board_settings('c5100000-0000-0000-0000-000000000001')->>'token')=(select token from board_tokens where session_id='c5100000-0000-0000-0000-000000000001'),'registration can read current capability');
select pg_temp.board_denied('select * from public.session_public_boards');
select pg_temp.board_denied('update public.session_public_boards set public_board_enabled=true');
reset role;
\echo 'PASS: shared Unicode name masking, ten staff permission combinations, missing auth denial, private tokens, unique random capability and idempotent enable'

-- Deliberately shuffled sequence numbers prove queue order wins. Private data
-- is populated to catch accidental row serialization into the public payload.
insert into public.participants(session_id,sequence_no,employee_no,full_name,gender,schedule_slot,group_code,planned_items,checkin_no,checked_in_at,status,note)
values
  ('c5100000-0000-0000-0000-000000000001',1,'001010','歐陽小明','男','08:00','A',array['腹部超音波'],'A10','2026-10-15T07:40:00+08:00','等候中','private-extension-1234'),
  ('c5100000-0000-0000-0000-000000000001',9,'000002','王明','女','09:00','A',array['甲狀腺超音波'],'A2','2026-10-15T07:32:00+08:00','等候中','private-extension-4567'),
  ('c5100000-0000-0000-0000-000000000001',10,'000001','王小明','男','10:00','A',array['乳房超音波'],'A1','2026-10-15T07:31:00+08:00','等候中','private-extension-9999'),
  ('c5100000-0000-0000-0000-000000000001',2,'002001','林美玲','女','11:00','B',array['頸動脈超音波'],'B1','2026-10-15T08:02:00+08:00','等候中','private-extension-1111'),
  ('c5100000-0000-0000-0000-000000000001',3,'unknown-queue','陳建志','男','12:00','G',array['其他超音波'],null,null,'等候中','private-extension-2222');
insert into public.participants(session_id,sequence_no,employee_no,full_name,schedule_slot,group_code,status)
select 'c5100000-0000-0000-0000-000000000001',20+ordinality::integer,'excluded-'||ordinality,
  '秘密排除姓名','13:00','A',status::public.work_status
from unnest(array['未報到','已叫號','檢查中','已完成','上廁所','心電圖','先做其他']) with ordinality statuses(status,ordinality);
insert into public.participants(session_id,sequence_no,employee_no,full_name,schedule_slot,group_code,queue_number,checkin_no,checked_in_at,status)
values('c5100000-0000-0000-0000-000000000002',10,'simple-10','王小明',null,null,10,'10',now(),'等候中'),
  ('c5100000-0000-0000-0000-000000000002',1,'simple-1','王明',null,null,1,'1',now(),'等候中'),
  ('c5100000-0000-0000-0000-000000000002',3,'simple-3','歐陽小明',null,null,3,'3',now(),'等候中'),
  ('c5100000-0000-0000-0000-000000000002',2,'simple-2','林美玲',null,null,2,'2',now(),'等候中');
-- Existing guards require queue_number for new simple arrivals. Simulate
-- compatible legacy data only after those guards have validated the fixture.
alter table public.participants disable trigger participants_guard_workflow;
update public.participants set queue_number=null where employee_no='simple-3' and session_id='c5100000-0000-0000-0000-000000000002';
alter table public.participants enable trigger participants_guard_workflow;
create temporary table board_private_snapshot as
select 'sessions' kind,to_jsonb(s) record from public.health_sessions s
union all select 'participants',to_jsonb(p) from public.participants p
union all select 'examinations',to_jsonb(e) from public.examinations e
union all select 'rooms',to_jsonb(r) from public.rooms r
union all select 'group_counters',to_jsonb(c) from public.group_counters c
union all select 'simple_queue_counters',to_jsonb(c) from public.simple_queue_counters c
union all select 'board_settings',to_jsonb(b) from public.session_public_boards b;

set local role anon;
set local request.jwt.claim.sub='';
do $$ declare board jsonb; person jsonb; begin
  board:=public.get_public_waiting_board((select token from board_tokens where session_id='c5100000-0000-0000-0000-000000000001'));
  perform pg_temp.assert_board(board->>'companyName'='Public standard' and board->>'sessionDate'='2026-10-15','anon receives company and date');
  perform pg_temp.assert_board((select array_agg(key order by key) from jsonb_object_keys(board) key)=array['companyName','people','sessionDate'],'exact top-level allowlist');
  perform pg_temp.assert_board(board->'people'='[{"employeeNo":"000001","maskedName":"王○明"},{"employeeNo":"000002","maskedName":"王○"},{"employeeNo":"001010","maskedName":"歐○○明"},{"employeeNo":"002001","maskedName":"林○玲"},{"employeeNo":"unknown-queue","maskedName":"陳○志"}]'::jsonb,'standard A1/A2/A10/B1 and unknown last, full employee identifiers and masked names only');
  for person in select value from jsonb_array_elements(board->'people') loop
    perform pg_temp.assert_board((select array_agg(key order by key) from jsonb_object_keys(person) key)=array['employeeNo','maskedName'],'no UUID/full name/status/room/queue/items/gender/times/medical detail per row');
  end loop;
  perform pg_temp.assert_board(board::text !~ '王小明|王明|歐陽小明|林美玲|陳建志|秘密排除姓名|腹部超音波|private-extension|c5100000|A1|A2|A10|B1|等候中','no full identity, medical data or internal sorting values anywhere in wire payload');
  perform pg_temp.assert_board(public.get_public_waiting_board((select token from board_tokens where session_id='c5100000-0000-0000-0000-000000000002'))->'people'='[{"employeeNo":"simple-1","maskedName":"王○"},{"employeeNo":"simple-2","maskedName":"林○玲"},{"employeeNo":"simple-3","maskedName":"歐○○明"},{"employeeNo":"simple-10","maskedName":"王○明"}]'::jsonb,'simple numeric queue 1/2/3/10 including compatible numeric checkin fallback');
  perform pg_temp.assert_board(public.get_public_waiting_board((select token from board_tokens where session_id='c5100000-0000-0000-0000-000000000004'))->'people'='[]'::jsonb,'enabled empty board remains valid');
  perform pg_temp.assert_board(public.get_public_waiting_board(null) is null and public.get_public_waiting_board('') is null
    and public.get_public_waiting_board('invalid') is null and public.get_public_waiting_board(repeat('f',64)) is null
    and public.get_public_waiting_board('c5100000-0000-0000-0000-000000000001') is null,'missing/invalid/unknown token and session UUID reveal nothing');
end $$;
select pg_temp.board_denied('select * from public.participants');
select pg_temp.board_denied('select * from public.health_sessions');
select pg_temp.board_denied('select * from public.session_public_boards');
select pg_temp.board_denied('select * from public.examinations');
select pg_temp.board_denied('select * from public.rooms');
select pg_temp.board_denied('update public.participants set full_name=''changed''');
select pg_temp.board_denied('delete from public.participants');
select pg_temp.board_denied($sql$select public.mask_public_board_name('王小明')$sql$);
select pg_temp.board_denied($sql$select public.standard_base_queue('c5100000-0000-0000-0000-000000000001')$sql$);
select pg_temp.board_denied($sql$select public.build_standard_waiting_queue('c5100000-0000-0000-0000-000000000001')$sql$);
select pg_temp.board_denied($sql$select public.get_standard_waiting_queue('c5100000-0000-0000-0000-000000000001')$sql$);
select pg_temp.board_denied($sql$select public.promote_waiting_participant('ffffffff-ffff-ffff-ffff-ffffffffffff')$sql$);
select pg_temp.board_denied($sql$select public.cancel_promoted_participant('ffffffff-ffff-ffff-ffff-ffffffffffff')$sql$);
select pg_temp.board_denied($sql$select public.get_public_board_settings('c5100000-0000-0000-0000-000000000001')$sql$);
select pg_temp.board_denied($sql$select public.set_public_board_enabled('c5100000-0000-0000-0000-000000000001',true)$sql$);
select pg_temp.board_denied($sql$select public.clear_session_schedule('c5100000-0000-0000-0000-000000000001')$sql$);
reset role;
select pg_temp.assert_board(not exists(
  with current_rows as (
    select 'sessions' kind,to_jsonb(s) record from public.health_sessions s
    union all select 'participants',to_jsonb(p) from public.participants p
    union all select 'examinations',to_jsonb(e) from public.examinations e
    union all select 'rooms',to_jsonb(r) from public.rooms r
    union all select 'group_counters',to_jsonb(c) from public.group_counters c
    union all select 'simple_queue_counters',to_jsonb(c) from public.simple_queue_counters c
    union all select 'board_settings',to_jsonb(b) from public.session_public_boards b
  ), changes as (
    (select * from board_private_snapshot except all select * from current_rows)
    union all (select * from current_rows except all select * from board_private_snapshot)
  ) select 1 from changes
),'public reads and rejected mutations do not change any internal state');
\echo 'PASS: anonymous minimal payload, all seven excluded statuses, natural standard/simple order, empty/invalid/UUID handling, no private reads/mutations or data changes'

-- Status transitions are read afresh; no names are cached in the public layer.
update public.participants set status='已叫號' where session_id='c5100000-0000-0000-0000-000000000001' and employee_no='000001';
set local role anon;
select pg_temp.assert_board(jsonb_array_length(public.get_public_waiting_board((select token from board_tokens where session_id='c5100000-0000-0000-0000-000000000001'))->'people')=4,'called participant leaves next read');
reset role;
update public.participants set status='等候中' where session_id='c5100000-0000-0000-0000-000000000001' and employee_no='000001';
set local role anon;
select pg_temp.assert_board(jsonb_array_length(public.get_public_waiting_board((select token from board_tokens where session_id='c5100000-0000-0000-0000-000000000001'))->'people')=5,'returning to waiting reappears');
reset role;
set local role authenticated;
set local request.jwt.claim.sub='c5000000-0000-0000-0000-000000000005';
select pg_temp.assert_board(public.set_public_board_enabled('c5100000-0000-0000-0000-000000000001',false)='{"enabled":false,"token":null}'::jsonb,'disable does not return a capability');
select pg_temp.assert_board(public.get_public_board_settings('c5100000-0000-0000-0000-000000000001')='{"enabled":false,"token":null}'::jsonb,'disabled settings hide stale token');
set local role anon;
select pg_temp.assert_board(public.get_public_waiting_board((select token from board_tokens where session_id='c5100000-0000-0000-0000-000000000001')) is null,'disabled old URL returns no data');
reset role;
set local role authenticated;
create temporary table renewed_board as select public.set_public_board_enabled('c5100000-0000-0000-0000-000000000001',true)->>'token' token;
grant select on renewed_board to anon;
select pg_temp.assert_board((select token from renewed_board)<>(select token from board_tokens where session_id='c5100000-0000-0000-0000-000000000001'),'re-enable rotates capability');
set local role anon;
select pg_temp.assert_board(public.get_public_waiting_board((select token from board_tokens where session_id='c5100000-0000-0000-0000-000000000001')) is null
  and public.get_public_waiting_board((select token from renewed_board)) is not null,'retired URL stays invalid after re-enable');
reset role;

update public.health_sessions set status='closing' where id='c5100000-0000-0000-0000-000000000002';
set local role anon;
select pg_temp.assert_board(public.get_public_waiting_board((select token from board_tokens where session_id='c5100000-0000-0000-0000-000000000002')) is null,'closing stops public reads immediately');
reset role;
update public.health_sessions set status='closed' where id='c5100000-0000-0000-0000-000000000002';
set local role anon;
select pg_temp.assert_board(public.get_public_waiting_board((select token from board_tokens where session_id='c5100000-0000-0000-0000-000000000002')) is null,'closed stops public reads');
reset role;
set local role authenticated;
select pg_temp.board_error($sql$select public.set_public_board_enabled('c5100000-0000-0000-0000-000000000002',true)$sql$,'session_not_active');
select public.clear_session_schedule('c5100000-0000-0000-0000-000000000003');
select public.clear_session_schedule('c5100000-0000-0000-0000-000000000004');
select public.delete_health_session('c5100000-0000-0000-0000-000000000005');
set local role anon;
select pg_temp.assert_board(public.get_public_waiting_board((select token from board_tokens where session_id='c5100000-0000-0000-0000-000000000003')) is null,'cleared standard URL invalidated');
select pg_temp.assert_board(public.get_public_waiting_board((select token from board_tokens where session_id='c5100000-0000-0000-0000-000000000004')) is null,'even clearing empty simple invalidates URL');
select pg_temp.assert_board(public.get_public_waiting_board((select token from board_tokens where session_id='c5100000-0000-0000-0000-000000000005')) is null,'deleted session URL returns no data');
reset role;
select pg_temp.assert_board(not exists(select 1 from public.session_public_boards where session_id='c5100000-0000-0000-0000-000000000005'),'session deletion cascades private capability');
select pg_temp.assert_board(not has_table_privilege('anon','public.participants','SELECT')
  and not has_table_privilege('authenticated','public.session_public_boards','SELECT')
  and not has_function_privilege('anon','public.set_public_board_enabled(uuid,boolean)','EXECUTE')
  and not has_function_privilege('anon','public.mask_public_board_name(text)','EXECUTE'),'least privilege grants');
select pg_temp.assert_board((select relrowsecurity from pg_class where oid='public.session_public_boards'::regclass),'private configuration RLS enabled');
select pg_temp.assert_board((select count(*)=3 from pg_proc where oid in(
  'public.get_public_board_settings(uuid)'::regprocedure,'public.set_public_board_enabled(uuid,boolean)'::regprocedure,'public.get_public_waiting_board(text)'::regprocedure)
  and prosecdef and proconfig @> array['search_path=""']),'all boundary RPCs definer with empty search path');
select pg_temp.assert_board(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and has_function_privilege('anon',p.oid,'EXECUTE') and p.prosecdef
    and p.oid<>'public.get_public_waiting_board(text)'::regprocedure),'only minimal read-only endpoint has anonymous definer access');
\echo 'PASS: live status transitions, disable/re-enable rotation, closed/closing gates, clear/delete invalidation, RLS and least-privilege function grants'
rollback;
