-- Server-authoritative, idempotent ultrasound examination workflow.
alter table public.examinations
  add column selected_items text[] not null default '{}';

create or replace function public.examination_clock()
returns timestamptz language sql stable security invoker set search_path = ''
as $$ select clock_timestamp(); $$;

-- Retire the device-timestamp overloads. They allowed a client to replace the
-- room/start time of an active examination and to submit arbitrary durations.
drop function if exists public.start_examination(uuid, text, timestamptz);
drop function if exists public.complete_examination(uuid, text, timestamptz, timestamptz, text[]);

create or replace function public.start_examination(p_participant_id uuid,p_room_id text,p_selected_items text[])
returns public.examinations language plpgsql security definer set search_path = '' as $$
declare participant public.participants; examination public.examinations;
begin
  if length(trim(p_room_id))=0 or coalesce(cardinality(p_selected_items),0)=0
     or cardinality(p_selected_items)<>(select count(distinct item) from unnest(p_selected_items) item)
     or exists(select 1 from unnest(p_selected_items) item where item not in ('腹部超音波','甲狀腺超音波','婦科超音波','前列腺超音波','乳房超音波')) then
    raise exception 'invalid_examination';
  end if;
  select * into participant from public.participants where id=p_participant_id for update;
  if not found then raise exception 'participant_not_found'; end if;
  if not public.can_access_session(participant.session_id) then raise exception 'not_authorized'; end if;
  if not exists(select 1 from public.health_sessions where id=participant.session_id and status='active' and session_date=(clock_timestamp() at time zone 'Asia/Taipei')::date) then raise exception 'not_today_session'; end if;
  if participant.checked_in_at is null or participant.checkin_no is null then raise exception 'not_checked_in'; end if;
  select * into examination from public.examinations where participant_id=p_participant_id for update;
  if found then
    if examination.status='completed' then raise exception 'examination_already_completed'; end if;
    if examination.room_id<>trim(p_room_id) then raise exception 'examination_in_other_room:%',examination.room_id; end if;
    return examination;
  end if;
  if participant.status not in ('等候中','已叫號','上廁所','心電圖','先做其他') then raise exception 'invalid_state'; end if;
  insert into public.examinations(participant_id,room_id,started_at,selected_items)
  values(p_participant_id,trim(p_room_id),clock_timestamp(),p_selected_items) returning * into examination;
  update public.participants set status='檢查中' where id=p_participant_id;
  return examination;
end $$;

create or replace function public.complete_examination(p_participant_id uuid,p_room_id text,p_actual_items text[])
returns public.examinations language plpgsql security definer set search_path = '' as $$
declare participant public.participants; examination public.examinations; finished_at timestamptz;
begin
  if length(trim(p_room_id))=0 or coalesce(cardinality(p_actual_items),0)=0
     or cardinality(p_actual_items)<>(select count(distinct item) from unnest(p_actual_items) item)
     or exists(select 1 from unnest(p_actual_items) item where item not in ('腹部超音波','甲狀腺超音波','婦科超音波','前列腺超音波','乳房超音波')) then
    raise exception 'invalid_examination';
  end if;
  select * into participant from public.participants where id=p_participant_id for update;
  if not found then raise exception 'participant_not_found'; end if;
  if not public.can_access_session(participant.session_id) then raise exception 'not_authorized'; end if;
  select * into examination from public.examinations where participant_id=p_participant_id for update;
  if not found then raise exception 'examination_not_started'; end if;
  if examination.room_id<>trim(p_room_id) then raise exception 'examination_in_other_room:%',examination.room_id; end if;
  if examination.status='completed' then return examination; end if;
  if participant.status<>'檢查中' then raise exception 'invalid_state'; end if;
  if exists(select 1 from unnest(p_actual_items) item where not(item=any(examination.selected_items))) then raise exception 'item_not_selected'; end if;
  finished_at:=greatest(clock_timestamp(),examination.started_at);
  update public.examinations set completed_at=finished_at,duration_seconds=greatest(0,extract(epoch from(finished_at-started_at))::integer),actual_items=p_actual_items,item_count=cardinality(p_actual_items),status='completed'
  where id=examination.id returning * into examination;
  update public.participants set status='已完成' where id=p_participant_id;
  return examination;
end $$;

revoke all on function public.examination_clock(),public.start_examination(uuid,text,text[]),public.complete_examination(uuid,text,text[]) from public,anon;
grant execute on function public.examination_clock(),public.start_examination(uuid,text,text[]),public.complete_examination(uuid,text,text[]) to authenticated;

-- Formal writes must pass through the state-transition RPCs; RLS remains on and
-- authenticated consoles retain read access for realtime display.
revoke insert,update,delete on public.examinations from authenticated;
