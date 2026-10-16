-- Existing tickets, check-in timestamps and counters are deliberately untouched.
alter table public.participants
  add column promoted_at timestamptz,
  add column promoted_after_key jsonb;

-- An insertion boundary, NOT a permanent top-three/entry permission. Only the
-- normal Base Queue boundary at this promotion is remembered. Earlier promotions
-- are protected by FIFO instead, so cancelling one cannot drag later ones back.
alter table public.participants add constraint participants_promotion_boundary_check
  check ((promoted_at is null and promoted_after_key is null)
    or (promoted_at is not null and promoted_after_key is not null
      and pg_catalog.jsonb_typeof(promoted_after_key)='array'));
revoke insert (promoted_at,promoted_after_key),
  update (promoted_at,promoted_after_key)
  on public.participants from public, anon, authenticated;

-- Frozen database snapshot generated from the existing schedule/rules.ts
-- SLOT_GROUP. The parity test prevents a future frontend change from silently
-- drifting from this deployed definition. Both server queues use this helper.
create function public.standard_queue_schedule()
returns table(schedule_slot text,group_code text,start_minute integer,group_rank integer)
language sql immutable set search_path = '' as $$
  values ('07:30~08:00','A',450,0),('08:00~08:30','B',480,1),
    ('08:30~09:00','C',510,2),('09:00~09:30','D',540,3),
    ('09:30~10:00','E',570,4),('10:00~10:30','F',600,5),
    ('10:30~11:00','G',630,6);
$$;

-- Fixed-size JSON tuples compare lexicographically inside PostgreSQL. Null
-- flags put missing legacy values last; epoch NUMERIC retains every microsecond.
-- Saved keys never leave the authenticated participant/RPC boundary.
create function public.standard_queue_key(p_group_code text,p_schedule_slot text,
  p_checked_in_at timestamptz,p_checkin_sequence integer,p_checkin_no text,
  p_sequence_no integer,p_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  with components as (
    select case when p_checked_in_at is not null and pg_catalog.isfinite(p_checked_in_at)
        and coalesce(scheduled.group_rank,slot_group.group_rank) is not null then
          greatest(coalesce(scheduled.group_rank,slot_group.group_rank),coalesce((
            select max(s.group_rank) from public.standard_queue_schedule() s
            where s.start_minute <= extract(hour from p_checked_in_at at time zone 'Asia/Taipei')*60
              +extract(minute from p_checked_in_at at time zone 'Asia/Taipei')
          ),0)) end as effective_rank,
      case when pg_catalog.isfinite(p_checked_in_at) then extract(epoch from p_checked_in_at) end as checked_epoch,
      case when p_checkin_sequence>0 then p_checkin_sequence end as checked_sequence,
      pg_catalog.substring(p_checkin_no,'([0-9]+)[[:space:]]*$') as suffix
    from (select 1) singleton
    left join public.standard_queue_schedule() scheduled on scheduled.group_code=p_group_code
    left join public.standard_queue_schedule() slot_group on slot_group.schedule_slot=
      pg_catalog.regexp_replace(pg_catalog.translate(pg_catalog.btrim(p_schedule_slot),'～〜－—–-','~~~~~~'),'[[:space:]]','','g')
  ), parsed as (
    select *,case when suffix is not null and pg_catalog.length(pg_catalog.ltrim(suffix,'0'))<=16 then
      case when suffix::numeric between 1 and 9007199254740991 then suffix::numeric end
    end as checked_suffix from components
  )
  select pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_array(effective_rank is null,coalesce(effective_rank,0)),
    pg_catalog.jsonb_build_array(checked_epoch is null,coalesce(checked_epoch,0)),
    pg_catalog.jsonb_build_array(checked_sequence is null,coalesce(checked_sequence,0)),
    pg_catalog.jsonb_build_array(checked_suffix is null,coalesce(checked_suffix,0)),p_sequence_no,p_id::text)
  from parsed;
$$;

create function public.standard_base_queue(p_session_id uuid)
returns table(participant_id uuid,queue_position bigint)
language sql stable set search_path = '' as $$
  select p.id,pg_catalog.row_number() over(order by public.standard_queue_key(
    p.group_code,p.schedule_slot,p.checked_in_at,p.checkin_sequence,p.checkin_no,p.sequence_no,p.id))
  from public.participants p where p.session_id=p_session_id and p.status='等候中';
$$;

-- Reapply each promotion's insertion boundary to the CURRENT waiting base.
-- An immutable boundary also retains the order of later arrivals if the original
-- anchor leaves. Removing any waiting person makes the next one move forward
-- naturally. No status-change RPC or wall-clock refresh mutates rank.
create function public.build_standard_waiting_queue(p_session_id uuid)
returns table(participant_id uuid,queue_position bigint)
language plpgsql stable set search_path = '' as $$
declare
  queue uuid[];
  base_keys jsonb;
  processed uuid[] := '{}'::uuid[];
  promotion record;
  insertion_position integer;
begin
  select coalesce(pg_catalog.array_agg(q.participant_id order by q.queue_position),'{}'::uuid[]),
    coalesce(pg_catalog.jsonb_object_agg(p.id::text,public.standard_queue_key(
      p.group_code,p.schedule_slot,p.checked_in_at,p.checkin_sequence,p.checkin_no,p.sequence_no,p.id)),'{}'::jsonb)
    into queue,base_keys from public.standard_base_queue(p_session_id) q
    join public.participants p on p.id=q.participant_id;
  for promotion in select p.id,p.promoted_after_key from public.participants p
    where p.session_id=p_session_id and p.status='等候中' and p.promoted_at is not null
    order by p.promoted_at,p.id
  loop
    queue := pg_catalog.array_remove(queue,promotion.id);
    select coalesce(max(current.ordinality),0)::integer into insertion_position
      from pg_catalog.unnest(queue) with ordinality as current(id,ordinality)
      where base_keys->current.id::text<=promotion.promoted_after_key or current.id=any(processed);
    queue := coalesce(queue[1:insertion_position],'{}'::uuid[])
      ||array[promotion.id]||coalesce(queue[insertion_position+1:cardinality(queue)],'{}'::uuid[]);
    processed := pg_catalog.array_append(processed,promotion.id);
  end loop;
  return query select current.id,current.ordinality
    from pg_catalog.unnest(queue) with ordinality as current(id,ordinality);
end;
$$;

-- Private helpers run only inside the guarded RPCs below, as their owner.
revoke all on function public.standard_queue_schedule(),public.standard_base_queue(uuid),
  public.build_standard_waiting_queue(uuid),
  public.standard_queue_key(text,text,timestamptz,integer,text,integer,uuid) from public, anon, authenticated;

create function public.get_standard_waiting_queue(p_session_id uuid)
returns table(participant_id uuid,queue_position bigint)
language plpgsql stable security definer set search_path = '' as $$
declare mode text;
begin
  if auth.uid() is null or not public.can_use_console() then
    raise exception 'permission_denied' using errcode='42501';
  end if;
  if not public.can_access_session(p_session_id) then raise exception 'not_authorized'; end if;
  select workflow_mode into mode from public.health_sessions where id=p_session_id;
  if not found then raise exception 'session_not_found'; end if;
  if mode<>'standard' then raise exception 'invalid_workflow_mode'; end if;
  return query select * from public.build_standard_waiting_queue(p_session_id);
end;
$$;

create function public.promote_waiting_participant(p_participant_id uuid)
returns public.participants language plpgsql security definer set search_path = '' as $$
declare
  person public.participants;
  session public.health_sessions;
  session_id uuid;
  queue uuid[];
  boundary jsonb;
begin
  if auth.uid() is null or not public.can_use_console() then
    raise exception 'permission_denied' using errcode='42501';
  end if;
  select p.session_id into session_id from public.participants p where p.id=p_participant_id;
  if not found then raise exception 'participant_not_found'; end if;
  if not public.can_access_session(session_id) then raise exception 'not_authorized'; end if;
  -- Serialize promotion/cancellation without conflicting with the FK KEY SHARE
  -- acquired by the existing check-in counter insert (its lock order stays put).
  select * into session from public.health_sessions s where s.id=session_id for no key update;
  if not found then raise exception 'session_not_found'; end if;
  if session.workflow_mode<>'standard' then raise exception 'invalid_workflow_mode'; end if;
  if session.status<>'active' then raise exception 'session_not_active'; end if;
  select * into person from public.participants p where p.id=p_participant_id and p.session_id=session.id for update;
  if not found then raise exception 'participant_not_found'; end if;
  if person.status<>'等候中' then raise exception 'invalid_state'; end if;
  -- Retry after natural promotion into the first three is still idempotent.
  if person.promoted_at is not null then return person; end if;
  select pg_catalog.array_agg(q.participant_id order by q.queue_position) into queue
    from public.build_standard_waiting_queue(session.id) q;
  if coalesce(pg_catalog.array_position(queue,person.id),0)<=3 then
    raise exception 'protected_top_three';
  end if;
  -- Inherit earlier active promotions' boundaries too: after their departure,
  -- a later promotion must still respect new arrivals before that boundary.
  select coalesce((select anchors.key from (
    select public.standard_queue_key(p.group_code,p.schedule_slot,p.checked_in_at,
      p.checkin_sequence,p.checkin_no,p.sequence_no,p.id) as key
    from pg_catalog.unnest(queue[1:3]) as current(id)
    join public.participants p on p.id=current.id where p.promoted_at is null
    union all
    select p.promoted_after_key from public.participants p
      where p.session_id=session.id and p.status='等候中' and p.promoted_at is not null
    ) anchors order by anchors.key desc limit 1),'[]'::jsonb) into boundary;
  update public.participants set promoted_at=pg_catalog.clock_timestamp(),promoted_after_key=boundary
    where id=person.id returning * into person;
  return person;
end;
$$;

create function public.cancel_promoted_participant(p_participant_id uuid)
returns public.participants language plpgsql security definer set search_path = '' as $$
declare
  person public.participants;
  session public.health_sessions;
  session_id uuid;
begin
  if auth.uid() is null or not public.can_use_console() then
    raise exception 'permission_denied' using errcode='42501';
  end if;
  select p.session_id into session_id from public.participants p where p.id=p_participant_id;
  if not found then raise exception 'participant_not_found'; end if;
  if not public.can_access_session(session_id) then raise exception 'not_authorized'; end if;
  select * into session from public.health_sessions s where s.id=session_id for no key update;
  if not found then raise exception 'session_not_found'; end if;
  if session.workflow_mode<>'standard' then raise exception 'invalid_workflow_mode'; end if;
  if session.status<>'active' then raise exception 'session_not_active'; end if;
  select * into person from public.participants p where p.id=p_participant_id and p.session_id=session.id for update;
  if not found then raise exception 'participant_not_found'; end if;
  if person.status<>'等候中' then raise exception 'invalid_state'; end if;
  if person.promoted_at is null then return person; end if;
  update public.participants set promoted_at=null,promoted_after_key=null
    where id=person.id returning * into person;
  return person;
end;
$$;

revoke all on function public.get_standard_waiting_queue(uuid),public.promote_waiting_participant(uuid),
  public.cancel_promoted_participant(uuid) from public, anon, authenticated;
grant execute on function public.get_standard_waiting_queue(uuid),public.promote_waiting_participant(uuid),
  public.cancel_promoted_participant(uuid) to authenticated;

-- Sorting data/IDs stay entirely on the server. Preserve the exact public
-- projection and capability gate; simple tickets keep their existing ordering.
create or replace function public.get_public_waiting_board(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return null; end if;
  select pg_catalog.jsonb_build_object('companyName',s.company_name,'sessionDate',s.session_date,
    'people',case when s.workflow_mode='standard' then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('employeeNo',p.employee_no,
        'maskedName',public.mask_public_board_name(p.full_name)) order by q.queue_position)
      from public.build_standard_waiting_queue(s.id) q join public.participants p on p.id=q.participant_id
    ),'[]'::jsonb) else coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('employeeNo',waiting.employee_no,
        'maskedName',public.mask_public_board_name(waiting.full_name))
        order by waiting.queue_value nulls last,waiting.sequence_no,waiting.id)
      from (select p.employee_no,p.full_name,p.sequence_no,p.id,
        case when p.queue_number>0 then p.queue_number::numeric
          when p.checkin_no ~ '^[1-9][0-9]*$' and pg_catalog.length(p.checkin_no)<=16 then
            case when p.checkin_no::numeric<=9007199254740991 then p.checkin_no::numeric end
        end as queue_value
        from public.participants p where p.session_id=s.id and p.status='等候中') waiting
    ),'[]'::jsonb) end) into result
  from public.session_public_boards b join public.health_sessions s on s.id=b.session_id
  where b.public_board_token=p_token and b.public_board_enabled and s.status='active';
  return result;
end;
$$;

-- The existing partial (session_id) WHERE status='等候中' index bounds this read.
-- Timestamp/effective-group expressions and a small promotion replay do not
-- benefit from another unmeasured multicolumn index.
