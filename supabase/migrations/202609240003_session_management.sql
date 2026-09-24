-- Destructive session management is kept server-side so related cloud records
-- are deleted atomically and anonymous clients can never invoke it.
create or replace function public.clear_session_schedule(p_session_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.can_access_session(p_session_id) then
    raise exception 'not_authorized';
  end if;
  delete from public.participants where session_id = p_session_id;
  delete from public.group_counters where session_id = p_session_id;
  delete from public.clearance_requests where session_id = p_session_id;
end;
$$;

create or replace function public.delete_health_session(p_session_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.can_access_session(p_session_id) then
    raise exception 'not_authorized';
  end if;
  delete from public.health_sessions where id = p_session_id;
  if not found then raise exception 'session_not_found'; end if;
end;
$$;

revoke all on function public.clear_session_schedule(uuid), public.delete_health_session(uuid) from public, anon;
grant execute on function public.clear_session_schedule(uuid), public.delete_health_session(uuid) to authenticated;
