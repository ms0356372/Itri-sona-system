-- Preserve every ultrasound visit as an independent, concurrency-safe round.
alter table public.examinations drop constraint if exists examinations_check;
alter type public.examination_status rename to examination_status_legacy;
create type public.examination_status as enum ('waiting','in_progress','completed');
alter table public.examinations alter column status drop default;
alter table public.examinations alter column status type public.examination_status using status::text::public.examination_status;
alter table public.examinations alter column status set default 'in_progress';
drop type public.examination_status_legacy;

alter table public.examinations add column round_no integer;
update public.examinations set round_no=1 where round_no is null;
alter table public.examinations alter column round_no set not null;
alter table public.examinations add constraint examinations_round_no_positive check(round_no>=1);
alter table public.examinations drop constraint if exists examinations_participant_id_key;
alter table public.examinations add constraint examinations_participant_round_key unique(participant_id,round_no);
alter table public.examinations alter column room_id drop not null;
alter table public.examinations alter column started_at drop not null;
alter table public.examinations add constraint examinations_state_check check(
  (status='waiting' and room_id is null and started_at is null and completed_at is null and duration_seconds is null)
  or (status='in_progress' and room_id is not null and started_at is not null and completed_at is null and duration_seconds is null)
  or (status='completed' and room_id is not null and started_at is not null and completed_at is not null and duration_seconds is not null)
);
create unique index examinations_one_waiting_per_participant on public.examinations(participant_id) where status='waiting';
create unique index examinations_one_in_progress_per_participant on public.examinations(participant_id) where status='in_progress';
create index examinations_participant_round_desc on public.examinations(participant_id,round_no desc);

drop function if exists public.complete_examination(uuid,text,text[]);

create or replace function public.enqueue_additional_examination(p_participant_id uuid,p_selected_items text[])
returns public.examinations language plpgsql security definer set search_path='' as $$
declare participant public.participants; examination public.examinations; next_round integer;
begin
  if coalesce(cardinality(p_selected_items),0)=0
     or cardinality(p_selected_items)<>(select count(distinct item) from unnest(p_selected_items) item)
     or exists(select 1 from unnest(p_selected_items) item where item not in ('腹部超音波','甲狀腺超音波','婦科超音波','前列腺超音波','乳房超音波')) then raise exception 'invalid_examination'; end if;
  select * into participant from public.participants where id=p_participant_id for update;
  if not found then raise exception 'participant_not_found'; end if;
  if not public.can_access_session(participant.session_id) then raise exception 'not_authorized'; end if;
  if participant.checked_in_at is null or participant.checkin_no is null then raise exception 'not_checked_in'; end if;
  if exists(select 1 from public.examinations where participant_id=p_participant_id and status='in_progress') then raise exception 'examination_in_progress'; end if;
  if exists(select 1 from public.examinations where participant_id=p_participant_id and status='waiting') then raise exception 'additional_examination_already_waiting'; end if;
  if participant.status<>'已完成' then raise exception 'invalid_state'; end if;
  select coalesce(max(round_no),0)+1 into next_round from public.examinations where participant_id=p_participant_id;
  insert into public.examinations(participant_id,round_no,room_id,started_at,selected_items,status)
    values(p_participant_id,next_round,null,null,p_selected_items,'waiting') returning * into examination;
  -- Deliberately keep check-in number/time/group untouched; this is not another check-in.
  update public.participants set status='等候中' where id=p_participant_id;
  return examination;
end $$;

create or replace function public.start_examination(p_participant_id uuid,p_room_id text,p_selected_items text[])
returns public.examinations language plpgsql security definer set search_path='' as $$
declare participant public.participants; examination public.examinations; next_round integer;
begin
  if length(trim(p_room_id))=0 or coalesce(cardinality(p_selected_items),0)=0
     or cardinality(p_selected_items)<>(select count(distinct item) from unnest(p_selected_items) item)
     or exists(select 1 from unnest(p_selected_items) item where item not in ('腹部超音波','甲狀腺超音波','婦科超音波','前列腺超音波','乳房超音波')) then raise exception 'invalid_examination'; end if;
  select * into participant from public.participants where id=p_participant_id for update;
  if not found then raise exception 'participant_not_found'; end if;
  if not public.can_access_session(participant.session_id) then raise exception 'not_authorized'; end if;
  if not exists(select 1 from public.health_sessions where id=participant.session_id and status='active' and session_date=(clock_timestamp() at time zone 'Asia/Taipei')::date) then raise exception 'not_today_session'; end if;
  if participant.checked_in_at is null or participant.checkin_no is null then raise exception 'not_checked_in'; end if;
  select * into examination from public.examinations where participant_id=p_participant_id and status='in_progress' for update;
  if found then
    if examination.room_id<>trim(p_room_id) then raise exception 'examination_in_other_room:%',examination.room_id; end if;
    return examination;
  end if;
  select * into examination from public.examinations where participant_id=p_participant_id and status='waiting' for update;
  if found then
    update public.examinations set room_id=trim(p_room_id),started_at=clock_timestamp(),status='in_progress'
      where id=examination.id returning * into examination;
  else
    if participant.status not in ('等候中','已叫號','上廁所','心電圖','先做其他') then raise exception 'invalid_state'; end if;
    select coalesce(max(round_no),0)+1 into next_round from public.examinations where participant_id=p_participant_id;
    insert into public.examinations(participant_id,round_no,room_id,started_at,selected_items,status)
      values(p_participant_id,next_round,trim(p_room_id),clock_timestamp(),p_selected_items,'in_progress') returning * into examination;
  end if;
  update public.participants set status='檢查中' where id=p_participant_id;
  return examination;
end $$;

create or replace function public.complete_examination(p_examination_id uuid,p_room_id text,p_actual_items text[])
returns public.examinations language plpgsql security definer set search_path='' as $$
declare participant public.participants; examination public.examinations; finished_at timestamptz;
begin
  if length(trim(p_room_id))=0 or coalesce(cardinality(p_actual_items),0)=0
     or cardinality(p_actual_items)<>(select count(distinct item) from unnest(p_actual_items) item)
     or exists(select 1 from unnest(p_actual_items) item where item not in ('腹部超音波','甲狀腺超音波','婦科超音波','前列腺超音波','乳房超音波')) then raise exception 'invalid_examination'; end if;
  select * into examination from public.examinations where id=p_examination_id for update;
  if not found then raise exception 'examination_not_started'; end if;
  select * into participant from public.participants where id=examination.participant_id for update;
  if not public.can_access_session(participant.session_id) then raise exception 'not_authorized'; end if;
  if examination.room_id<>trim(p_room_id) then raise exception 'examination_in_other_room:%',examination.room_id; end if;
  if examination.status='completed' then return examination; end if;
  if examination.status<>'in_progress' or participant.status<>'檢查中' then raise exception 'invalid_state'; end if;
  if exists(select 1 from unnest(p_actual_items) item where not(item=any(examination.selected_items))) then raise exception 'item_not_selected'; end if;
  finished_at:=greatest(clock_timestamp(),examination.started_at);
  update public.examinations set completed_at=finished_at,duration_seconds=greatest(0,extract(epoch from(finished_at-started_at))::integer),actual_items=p_actual_items,item_count=cardinality(p_actual_items),status='completed'
    where id=examination.id returning * into examination;
  if not exists(select 1 from public.examinations where participant_id=examination.participant_id and status in ('waiting','in_progress')) then
    update public.participants set status='已完成' where id=examination.participant_id;
  end if;
  return examination;
end $$;

revoke all on function public.enqueue_additional_examination(uuid,text[]),public.start_examination(uuid,text,text[]),public.complete_examination(uuid,text,text[]) from public,anon;
grant usage on type public.examination_status to authenticated;
grant execute on function public.enqueue_additional_examination(uuid,text[]),public.start_examination(uuid,text,text[]),public.complete_examination(uuid,text,text[]) to authenticated;
