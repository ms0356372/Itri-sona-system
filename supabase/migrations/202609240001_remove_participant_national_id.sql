-- 身分證僅能存在報到站本機 IndexedDB 與使用者主動匯出的 Excel。
--
-- Production safety:
--   1. Run the preflight queries documented in README.md and export any records
--      that must be retained through an approved, offline process.
--   2. When non-empty identifiers exist, a database owner must explicitly approve
--      their destruction before this migration can run:
--        alter database postgres
--          set app.confirm_participant_national_id_removal = 'confirmed';
--   3. Apply this migration, then reset the one-time approval setting:
--        alter database postgres
--          reset app.confirm_participant_national_id_removal;
--
-- The guard deliberately aborts instead of replacing identifiers with NULL,
-- empty strings, notes, JSON, or another cloud column.
do $$
declare
  identifier_count bigint;
  removal_approved boolean;
begin
  select count(*)
    into identifier_count
    from public.participants
   where national_id is not null
     and length(trim(national_id)) > 0;

  removal_approved := coalesce(
    current_setting('app.confirm_participant_national_id_removal', true),
    ''
  ) = 'confirmed';

  if identifier_count > 0 and not removal_approved then
    raise exception using
      message = format(
        'participants.national_id contains %s populated rows; review impact and explicitly approve removal before rerunning this migration',
        identifier_count
      ),
      hint = 'Follow the national_id migration preflight and approval procedure in README.md.';
  end if;
end
$$;

drop index if exists public.participants_session_national_idx;

alter table public.participants
  drop column national_id;
