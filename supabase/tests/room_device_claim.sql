-- Exercise production device leases without waiting three minutes. Only the
-- disposable database owner adjusts timestamps; clients call the actual RPCs.
begin;
create function pg_temp.assert_claim(p_ok boolean,p_message text)
returns void language plpgsql as $$ begin
  if p_ok is distinct from true then raise exception 'FAIL: %',p_message; end if;
end $$;
create function pg_temp.expect_claim_error(p_sql text,p_error text,p_state text default 'P0001')
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
create function pg_temp.expect_claim_privilege(p_sql text)
returns void language plpgsql as $$
declare rejected boolean:=false;
begin
  begin execute p_sql;
  exception when insufficient_privilege then rejected:=true; end;
  if not rejected then raise exception 'FAIL: direct client mutation accepted %',p_sql; end if;
end $$;

insert into auth.users(id,email) values
  ('e1000000-0000-0000-0000-000000000001','lease.room.a@itri.example.com'),
  ('e1000000-0000-0000-0000-000000000002','lease.room.b@itri.example.com'),
  ('e1000000-0000-0000-0000-000000000003','lease.registration@itri.example.com'),
  ('e1000000-0000-0000-0000-000000000004','lease.console@itri.example.com'),
  ('e1000000-0000-0000-0000-000000000005','lease.inactive@itri.example.com'),
  ('e1000000-0000-0000-0000-000000000006','lease.missing@itri.example.com');
update public.staff_permissions set can_room=true where user_id in
  ('e1000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000002','e1000000-0000-0000-0000-000000000005');
update public.staff_permissions set can_registration=true where user_id='e1000000-0000-0000-0000-000000000003';
update public.staff_permissions set can_console=true where user_id='e1000000-0000-0000-0000-000000000004';
update public.staff_permissions set is_active=false where user_id='e1000000-0000-0000-0000-000000000005';
delete from public.staff_permissions where user_id='e1000000-0000-0000-0000-000000000006';
insert into public.health_sessions(id,session_date,company_name,created_by,room_count) values
  ('e2000000-0000-0000-0000-000000000001',(clock_timestamp() at time zone 'Asia/Taipei')::date,'lease A','e1000000-0000-0000-0000-000000000001',3),
  ('e2000000-0000-0000-0000-000000000002',(clock_timestamp() at time zone 'Asia/Taipei')::date,'lease B','e1000000-0000-0000-0000-000000000001',3),
  ('e2000000-0000-0000-0000-000000000003',(clock_timestamp() at time zone 'Asia/Taipei')::date-1,'lease history','e1000000-0000-0000-0000-000000000001',3);
insert into public.participants(id,session_id,sequence_no,employee_no,full_name,schedule_slot,group_code,status,checkin_no,checked_in_at) values
  ('e3000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000001',1,'1','Lease participant A','08:00','A','等候中','A1',clock_timestamp()),
  ('e3000000-0000-0000-0000-000000000002','e2000000-0000-0000-0000-000000000001',2,'2','Lease participant B','08:00','A','等候中','A2',clock_timestamp());
set local request.jwt.claim.sub='e1000000-0000-0000-0000-000000000001';
set local role authenticated;

-- 1, 2, 3, 11: room-only acquisition, authenticated same-device restoration,
-- other-device visibility and API rejection. Return only safe UI claim fields.
create temporary table lease_reply(reply jsonb);
insert into lease_reply select public.claim_room('e2000000-0000-0000-0000-000000000001','room_1','e0000000-0000-0000-0000-000000000001',repeat('a',64));
select pg_temp.assert_claim((select (reply->>'is_mine')::boolean and (reply->>'is_claimed')::boolean and reply->>'room_id'='診間 1' from lease_reply),'room-only claims canonical room');
select pg_temp.assert_claim((select (extract(epoch from ((reply->>'claim_expires_at')::timestamptz-(reply->>'server_now')::timestamptz)) between 179 and 181) from lease_reply),'lease TTL is exactly 180 seconds');
select pg_temp.assert_claim((select not (reply ?| array['claimed_by_device_id','claimed_by_user_id','claim_secret_hash','device_secret','login_email']) from lease_reply),'claim response omits device/user identities and secrets');
select pg_temp.assert_claim((public.claim_room('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000001',repeat('a',64))->>'is_mine')::boolean,'refresh restores own active device lease');
select pg_temp.expect_claim_error($sql$select public.release_room_claim('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000001',repeat('a',64),(select (reply->>'claimed_at')::timestamptz from lease_reply))$sql$,'room_claim_lost');
select pg_temp.assert_claim((public.list_room_claims('e2000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000001',repeat('a',64))->0->>'is_mine')::boolean,'stale release callback cannot clear a newer same-device lease');
select pg_temp.assert_claim((public.list_room_claims('e2000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000002',repeat('b',64))->0->>'is_claimed')::boolean
  and not (public.list_room_claims('e2000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000002',repeat('b',64))->0->>'is_mine')::boolean,'other device sees occupied room without being its owner');
select pg_temp.expect_claim_error($sql$select public.claim_room('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000002',repeat('b',64))$sql$,'room_claimed');

-- Same-account devices cannot impersonate another browser merely by copying
-- its visible UUID or the SHA-256 digest visible in a room Realtime row.
select pg_temp.expect_claim_error($sql$select public.heartbeat_room_claim('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000001',repeat('b',64))$sql$,'room_claim_lost');
select pg_temp.expect_claim_error($sql$select public.release_room_claim('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000001',repeat('b',64))$sql$,'room_claim_lost');
select pg_temp.expect_claim_error($sql$select public.claim_room('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000001',repeat('b',64))$sql$,'room_claimed');
select pg_temp.expect_claim_error($sql$select public.set_room_away('e2000000-0000-0000-0000-000000000001','診間1',true,'e0000000-0000-0000-0000-000000000001',(select claim_secret_hash from public.rooms where session_id='e2000000-0000-0000-0000-000000000001' and room_id='診間 1'))$sql$,'room_claim_lost');
select pg_temp.expect_claim_error($sql$select public.start_examination('e3000000-0000-0000-0000-000000000001','診間1',array['腹部超音波'],'e0000000-0000-0000-0000-000000000001',repeat('b',64))$sql$,'room_claim_lost');
select pg_temp.assert_claim((select claim_secret_hash<>repeat('a',64) and length(claim_secret_hash)=64 from public.rooms where session_id='e2000000-0000-0000-0000-000000000001' and room_id='診間 1'),'database stores a digest rather than browser secret');
select pg_temp.expect_claim_privilege($sql$update public.rooms set claimed_by_device_id='e0000000-0000-0000-0000-000000000002',claim_expires_at=clock_timestamp()+interval '1 day' where session_id='e2000000-0000-0000-0000-000000000001'$sql$);
\echo 'PASS: 1-3,11 atomic acquisition, refresh restoration, safe visibility, same-account spoof/digest replay denial and direct-write protection'

-- 4, 5, 6: failed switch preserves original ownership; successful switch is
-- all-or-nothing and leaves only one valid room for this browser/session.
select public.claim_room('e2000000-0000-0000-0000-000000000001','診間2','e0000000-0000-0000-0000-000000000002',repeat('b',64));
select pg_temp.expect_claim_error($sql$select public.switch_room_claim('e2000000-0000-0000-0000-000000000001','診間1','診間2','e0000000-0000-0000-0000-000000000001',repeat('a',64))$sql$,'room_claimed');
select pg_temp.assert_claim((public.heartbeat_room_claim('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000001',repeat('a',64))->>'is_mine')::boolean,'failed switch leaves original lease intact');
select public.release_room_claim('e2000000-0000-0000-0000-000000000001','診間2','e0000000-0000-0000-0000-000000000002',repeat('b',64));
select pg_temp.assert_claim((public.switch_room_claim('e2000000-0000-0000-0000-000000000001','診間1','診間2','e0000000-0000-0000-0000-000000000001',repeat('a',64))->>'is_mine')::boolean,'atomic switch claims target');
select pg_temp.assert_claim((select claimed_by_device_id is null from public.rooms where session_id='e2000000-0000-0000-0000-000000000001' and room_id='診間 1'),'atomic switch releases source');
select pg_temp.expect_claim_error($sql$select public.claim_room('e2000000-0000-0000-0000-000000000001','診間3','e0000000-0000-0000-0000-000000000001',repeat('a',64))$sql$,'room_claim_switch_required');
select public.switch_room_claim('e2000000-0000-0000-0000-000000000001','診間2','診間1','e0000000-0000-0000-0000-000000000001',repeat('a',64));
select public.release_room_claim('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000001',repeat('a',64));
select pg_temp.assert_claim(not (public.list_room_claims('e2000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000002',repeat('b',64))->0->>'is_claimed')::boolean,'release exposes room to other browser');
select public.claim_room('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000002',repeat('b',64));
select public.release_room_claim('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000002',repeat('b',64));
select public.claim_room('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000001',repeat('a',64));
\echo 'PASS: 4-6 release, atomic switch success/rollback and single-room-per-device guard'

-- 7, 8, 12: away and return preserve ownership; heartbeat is legal during
-- absence and short outages. A browser cannot replace the actual Auth owner.
select public.set_room_away('e2000000-0000-0000-0000-000000000001','診間1',true,'e0000000-0000-0000-0000-000000000001',repeat('a',64));
select public.heartbeat_room_claim('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000001',repeat('a',64));
select pg_temp.assert_claim((select status='away' and claimed_by_device_id='e0000000-0000-0000-0000-000000000001' from public.rooms where session_id='e2000000-0000-0000-0000-000000000001' and room_id='診間 1'),'away heartbeat preserves yellow status and device');
select public.claim_room('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000001',repeat('a',64));
select pg_temp.assert_claim((select status='away' from public.rooms where session_id='e2000000-0000-0000-0000-000000000001' and room_id='診間 1'),'refresh claim never resets away status');
select pg_temp.expect_claim_error($sql$select public.claim_room('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000002',repeat('b',64))$sql$,'room_claimed');
set local request.jwt.claim.sub='e1000000-0000-0000-0000-000000000002';
select pg_temp.expect_claim_error($sql$select public.heartbeat_room_claim('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000001',repeat('a',64))$sql$,'room_claim_lost');
set local request.jwt.claim.sub='e1000000-0000-0000-0000-000000000001';
reset role;
update public.rooms set claim_expires_at=clock_timestamp()+interval '120 seconds' where session_id='e2000000-0000-0000-0000-000000000001' and room_id='診間 1';
set local role authenticated;
select public.heartbeat_room_claim('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000001',repeat('a',64));
select pg_temp.assert_claim((select claim_expires_at>clock_timestamp()+interval '179 seconds' from public.rooms where session_id='e2000000-0000-0000-0000-000000000001' and room_id='診間 1'),'sixty-second outage heartbeat restores full TTL');
select public.set_room_away('e2000000-0000-0000-0000-000000000001','診間1',false,'e0000000-0000-0000-0000-000000000001',repeat('a',64));
select pg_temp.assert_claim((select status='idle' and claimed_by_device_id='e0000000-0000-0000-0000-000000000001' from public.rooms where session_id='e2000000-0000-0000-0000-000000000001' and room_id='診間 1'),'return restores status without changing claim');
\echo 'PASS: 7-8,12 away/return preserve ownership, heartbeat tolerates short outage and enforces Auth owner'

-- 9, 10, 13: in-progress work blocks voluntary release/switch; expiry permits
-- controlled takeover while preserving the examination for its new operator.
create temporary table lease_examination as select (public.start_examination('e3000000-0000-0000-0000-000000000001','診間1',array['腹部超音波'],'e0000000-0000-0000-0000-000000000001',repeat('a',64))).*;
select pg_temp.expect_claim_error($sql$select public.release_room_claim('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000001',repeat('a',64))$sql$,'room_claim_in_progress');
select pg_temp.expect_claim_error($sql$select public.switch_room_claim('e2000000-0000-0000-0000-000000000001','診間1','診間2','e0000000-0000-0000-0000-000000000001',repeat('a',64))$sql$,'room_claim_in_progress');
reset role;
-- Defense in depth: an unfinished assigned examination prevents release even
-- when a legacy administrator incorrectly marks the room's status idle.
update public.rooms set status='idle' where session_id='e2000000-0000-0000-0000-000000000001' and room_id='診間 1';
set local role authenticated;
select pg_temp.expect_claim_error($sql$select public.release_room_claim('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000001',repeat('a',64))$sql$,'room_claim_in_progress');
reset role;
update public.rooms set status='in_progress',claimed_at=clock_timestamp()-interval '181 seconds',claim_expires_at=clock_timestamp()-interval '1 second' where session_id='e2000000-0000-0000-0000-000000000001' and room_id='診間 1';
set local role authenticated;
select pg_temp.assert_claim(not (public.list_room_claims('e2000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000002',repeat('b',64))->0->>'is_claimed')::boolean,'expired lease reads available without a database event');
select pg_temp.expect_claim_error($sql$select public.heartbeat_room_claim('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000001',repeat('a',64))$sql$,'room_claim_lost');
select public.claim_room('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000002',repeat('b',64));
select pg_temp.assert_claim((select status='in_progress' from public.rooms where session_id='e2000000-0000-0000-0000-000000000001' and room_id='診間 1'),'expired takeover retains in-progress room');
select pg_temp.assert_claim((select count(*)=1 from public.examinations where id=(select id from lease_examination) and status='in_progress'),'expired takeover retains existing examination');
select pg_temp.expect_claim_error($sql$select public.heartbeat_room_claim('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000001',repeat('a',64))$sql$,'room_claim_lost');
select pg_temp.expect_claim_error($sql$select public.release_room_claim('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000001',repeat('a',64))$sql$,'room_claim_lost');
select pg_temp.expect_claim_error($sql$select public.complete_examination((select id from lease_examination),'診間1',array['腹部超音波'],'e0000000-0000-0000-0000-000000000001',repeat('a',64))$sql$,'room_claim_lost');
select pg_temp.expect_claim_error($sql$select public.set_room_away('e2000000-0000-0000-0000-000000000001','診間1',true,'e0000000-0000-0000-0000-000000000001',repeat('a',64))$sql$,'room_claim_lost');
select pg_temp.expect_claim_error($sql$select public.set_room_away('e2000000-0000-0000-0000-000000000001','診間1',false,'e0000000-0000-0000-0000-000000000001',repeat('a',64))$sql$,'room_claim_lost');
select pg_temp.assert_claim((public.complete_examination((select id from lease_examination),'診間1',array['腹部超音波'],'e0000000-0000-0000-0000-000000000002',repeat('b',64))).status='completed','new lease owner completes retained examination');
select public.release_room_claim('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000002',repeat('b',64));
\echo 'PASS: 9-10,13,19 unfinished-work guards, simulated expiry/takeover, stale-owner rejection and retained-examination recovery'

-- 15,16: session isolation and enabled-room range; live idle claims also block
-- room-count reduction until released or expired, preserving the current owner.
select public.claim_room('e2000000-0000-0000-0000-000000000001','診間3','e0000000-0000-0000-0000-000000000001',repeat('a',64));
select public.claim_room('e2000000-0000-0000-0000-000000000002','診間1','e0000000-0000-0000-0000-000000000001',repeat('a',64));
select pg_temp.assert_claim((select count(*)=2 from public.rooms where claimed_by_device_id='e0000000-0000-0000-0000-000000000001' and claim_expires_at>clock_timestamp()),'same device rooms in separate sessions are isolated');
select pg_temp.expect_claim_error($sql$select public.claim_room('e2000000-0000-0000-0000-000000000001','診間4','e0000000-0000-0000-0000-000000000003',repeat('c',64))$sql$,'invalid_room');
select pg_temp.expect_claim_error($sql$select public.claim_room('e2000000-0000-0000-0000-000000000001','診間0','e0000000-0000-0000-0000-000000000003',repeat('c',64))$sql$,'invalid_room');
select pg_temp.expect_claim_error($sql$select public.claim_room('e2000000-0000-0000-0000-000000000001','診間1','bad-device-id',repeat('c',64))$sql$,'invalid_device');
select pg_temp.expect_claim_error($sql$select public.claim_room('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000003','short-secret')$sql$,'invalid_device');
set local request.jwt.claim.sub='e1000000-0000-0000-0000-000000000003';
select pg_temp.expect_claim_error($sql$select public.update_session_room_count('e2000000-0000-0000-0000-000000000001',2)$sql$,'room_count_claimed:診間 3');
select pg_temp.assert_claim((select room_count=3 from public.health_sessions where id='e2000000-0000-0000-0000-000000000001'),'blocked shrink keeps configured room count');
set local request.jwt.claim.sub='e1000000-0000-0000-0000-000000000001';
select public.release_room_claim('e2000000-0000-0000-0000-000000000001','診間3','e0000000-0000-0000-0000-000000000001',repeat('a',64));
set local request.jwt.claim.sub='e1000000-0000-0000-0000-000000000003';
select public.update_session_room_count('e2000000-0000-0000-0000-000000000001',2);
set local request.jwt.claim.sub='e1000000-0000-0000-0000-000000000001';
select pg_temp.assert_claim(jsonb_array_length(public.list_room_claims('e2000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000001',repeat('a',64)))=2,'claim list omits retained inactive room rows');
\echo 'PASS: 15-16 session isolation, room range/device validation and claimed-room shrink protection'

-- 17: every claim RPC checks room permission itself, before arguments or row
-- lookups. Missing/inactive/registration-only/console-only accounts fail closed.
create temporary table lease_rpc_denials(statement) as values
  ($sql$select public.claim_room('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000003',repeat('c',64))$sql$),
  ($sql$select public.switch_room_claim('e2000000-0000-0000-0000-000000000001','診間1','診間2','e0000000-0000-0000-0000-000000000003',repeat('c',64))$sql$),
  ($sql$select public.heartbeat_room_claim('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000003',repeat('c',64))$sql$),
  ($sql$select public.release_room_claim('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000003',repeat('c',64))$sql$),
  ($sql$select public.list_room_claims('e2000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000003',repeat('c',64))$sql$);
do $$ declare staff_no integer; rpc record; begin
  for staff_no in 3..6 loop
    perform set_config('request.jwt.claim.sub','e1000000-0000-0000-0000-'||lpad(staff_no::text,12,'0'),true);
    for rpc in select * from lease_rpc_denials loop
      perform pg_temp.expect_claim_error(rpc.statement,'permission_denied','42501');
    end loop;
  end loop;
  perform set_config('request.jwt.claim.sub','',true);
  for rpc in select * from lease_rpc_denials loop
    perform pg_temp.expect_claim_error(rpc.statement,'permission_denied','42501');
  end loop;
end $$;
reset role;
select pg_temp.assert_claim(to_regprocedure('public.start_examination(uuid,text,text[])') is null
  and to_regprocedure('public.complete_examination(uuid,text,text[])') is null
  and to_regprocedure('public.set_room_away(uuid,text,boolean)') is null
  and to_regprocedure('public.release_room_claim(uuid,text,text,text)') is null,'unprotected legacy room operation overloads removed');
select pg_temp.assert_claim(exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='rooms'),'room claim changes published for selector refresh');
select pg_temp.assert_claim(not has_table_privilege('authenticated','public.rooms','INSERT,UPDATE,DELETE'),'claims stay RPC-only with RLS enabled');
select pg_temp.assert_claim((select relrowsecurity from pg_class where oid='public.rooms'::regclass),'room RLS remains enabled');
set local role anon;
select pg_temp.expect_claim_privilege($sql$select public.claim_room('e2000000-0000-0000-0000-000000000001','診間1','e0000000-0000-0000-0000-000000000003',repeat('c',64))$sql$);
reset role;
\echo 'PASS: 17-18 page guards, removed unsafe overloads, anonymous/direct-write denial and Realtime publication'
rollback;
