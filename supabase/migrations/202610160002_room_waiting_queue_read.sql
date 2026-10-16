-- Room staff read the same canonical waiting positions as the console/public
-- board. Promotion mutations remain restricted to console staff.
create or replace function public.get_standard_waiting_queue(p_session_id uuid)
returns table(participant_id uuid,queue_position bigint)
language plpgsql stable security definer set search_path = '' as $$
declare mode text;
begin
  if auth.uid() is null or not (public.can_use_console() or public.can_use_room()) then
    raise exception 'permission_denied' using errcode='42501';
  end if;
  if not public.can_access_session(p_session_id) then raise exception 'not_authorized'; end if;
  select workflow_mode into mode from public.health_sessions where id=p_session_id;
  if not found then raise exception 'session_not_found'; end if;
  if mode<>'standard' then raise exception 'invalid_workflow_mode'; end if;
  return query select * from public.build_standard_waiting_queue(p_session_id);
end;
$$;

-- CREATE OR REPLACE retains the existing owner and authenticated EXECUTE grant;
-- anon and the private queue builders retain their existing denied access.
