-- A capability URL grants only this deliberately small read-only projection.
-- Keep tokens out of health_sessions: its existing authenticated reads and
-- realtime payloads must not disclose the public capability to other stations.
create table public.session_public_boards (
  session_id uuid primary key references public.health_sessions(id) on delete cascade,
  public_board_token text not null unique
    check (public_board_token ~ '^[0-9a-f]{64}$'),
  public_board_enabled boolean not null default false
);
alter table public.session_public_boards enable row level security;
revoke all on public.session_public_boards from public, anon, authenticated;
grant all on public.session_public_boards to service_role;

create index participants_public_waiting_idx on public.participants(session_id)
  where status='等候中';

-- Code-point masking happens before any participant data leaves PostgreSQL.
-- This helper itself is private; clients can only call the token-gated RPC.
create function public.mask_public_board_name(p_name text)
returns text language sql immutable set search_path = '' as $$
  select case pg_catalog.char_length(name)
    when 0 then ''
    when 1 then '○'
    when 2 then pg_catalog.left(name,1)||'○'
    else pg_catalog.left(name,1)||pg_catalog.repeat('○',pg_catalog.char_length(name)-2)||pg_catalog.right(name,1)
  end from (select pg_catalog.btrim(coalesce(p_name,'')) as name) trimmed;
$$;
revoke all on function public.mask_public_board_name(text) from public, anon, authenticated;

create function public.get_public_board_settings(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  board public.session_public_boards;
begin
  if not public.can_use_registration() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if not public.can_access_session(p_session_id) then raise exception 'not_authorized'; end if;
  select * into board from public.session_public_boards where session_id=p_session_id;
  return pg_catalog.jsonb_build_object(
    'enabled',coalesce(board.public_board_enabled,false),
    'token',case when board.public_board_enabled then board.public_board_token else null end
  );
end;
$$;

create function public.set_public_board_enabled(p_session_id uuid,p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  session_state public.session_status;
  board public.session_public_boards;
begin
  if not public.can_use_registration() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if not public.can_access_session(p_session_id) then raise exception 'not_authorized'; end if;
  if p_enabled is null then raise exception 'invalid_public_board_enabled'; end if;
  -- Share the existing clear/close/delete mutex, so none can race a re-enable.
  select status into session_state from public.health_sessions where id=p_session_id for update;
  if not found then raise exception 'session_not_found'; end if;
  if p_enabled and session_state<>'active' then raise exception 'session_not_active'; end if;
  select * into board from public.session_public_boards where session_id=p_session_id;
  if p_enabled then
    if not coalesce(board.public_board_enabled,false) then
      -- Two independent UUIDv4 draws provide 244 random bits. Use the built-in
      -- generator, independent of the deployment schema of pgcrypto.
      insert into public.session_public_boards(session_id,public_board_token,public_board_enabled)
      values(p_session_id,
        pg_catalog.replace(pg_catalog.gen_random_uuid()::text||pg_catalog.gen_random_uuid()::text,'-',''),true)
      on conflict(session_id) do update
        set public_board_token=excluded.public_board_token,public_board_enabled=true
      returning * into board;
    end if;
  else
    update public.session_public_boards set public_board_enabled=false where session_id=p_session_id;
  end if;
  return pg_catalog.jsonb_build_object('enabled',p_enabled,'token',case when p_enabled then board.public_board_token else null end);
end;
$$;

create function public.get_public_waiting_board(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  result jsonb;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return null; end if;
  select pg_catalog.jsonb_build_object(
    'companyName',s.company_name,
    'sessionDate',s.session_date,
    'people',coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('employeeNo',waiting.employee_no,
          'maskedName',public.mask_public_board_name(waiting.full_name))
        order by waiting.queue_group collate "C" nulls last,waiting.queue_value nulls last,
          waiting.sequence_no,waiting.id
      ) from (
        select p.employee_no,p.full_name,p.sequence_no,p.id,
          case when s.workflow_mode='standard' and p.checkin_no ~ '^[A-G][1-9][0-9]*$'
            then pg_catalog.left(p.checkin_no,1) end as queue_group,
          case when s.workflow_mode='simple' then
            case when p.queue_number>0 then p.queue_number::numeric
              when p.checkin_no ~ '^[1-9][0-9]*$' and pg_catalog.length(p.checkin_no)<=16 then
                case when p.checkin_no::numeric<=9007199254740991 then p.checkin_no::numeric end
            end
            when p.checkin_no ~ '^[A-G][1-9][0-9]*$' then pg_catalog.substr(p.checkin_no,2)::numeric
          end as queue_value
        from public.participants p where p.session_id=s.id and p.status='等候中'
      ) waiting
    ),'[]'::jsonb)
  ) into result
  from public.session_public_boards b join public.health_sessions s on s.id=b.session_id
  where b.public_board_token=p_token and b.public_board_enabled and s.status='active';
  return result;
end;
$$;

revoke all on function public.get_public_board_settings(uuid),
  public.set_public_board_enabled(uuid,boolean),public.get_public_waiting_board(text)
  from public, anon, authenticated;
grant execute on function public.get_public_board_settings(uuid),public.set_public_board_enabled(uuid,boolean) to authenticated;
grant usage on schema public to anon;
grant execute on function public.get_public_waiting_board(text) to anon, authenticated;

-- Clearing either workflow must invalidate its public URL, including an empty
-- schedule. Retain every existing permission, mutex and workflow cleanup step.
create or replace function public.clear_session_schedule(p_session_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.can_use_registration() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if auth.uid() is null or not public.can_access_session(p_session_id) then raise exception 'not_authorized'; end if;
  perform 1 from public.health_sessions where id = p_session_id for update;
  if not found then raise exception 'session_not_found'; end if;
  update public.session_public_boards set public_board_enabled=false where session_id=p_session_id;
  delete from public.participants where session_id = p_session_id;
  delete from public.group_counters where session_id = p_session_id;
  delete from public.clearance_requests where session_id = p_session_id;
  if (select workflow_mode from public.health_sessions where id = p_session_id) = 'simple' then
    delete from public.simple_queue_counters where session_id = p_session_id;
    delete from public.rooms where session_id = p_session_id;
  end if;
end;
$$;
