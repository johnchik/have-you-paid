-- When `sessions` SELECT is restricted (privacy), RLS policy expressions that query `public.sessions`
-- can fail for non-participants. Use a security definer helper in a non-exposed schema instead.

create schema if not exists app_private;

create or replace function app_private.is_session_open(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app_private
as $$
  select exists (
    select 1
    from public.sessions s
    where s.id = p_session_id
      and s.status = 'open'
  );
$$;

drop policy if exists "session_participants_insert" on public.session_participants;

create policy "session_participants_insert"
  on public.session_participants for insert
  with check (
    user_id = auth.uid()
    and (
      (
        role = 'host'
        and public.is_session_host(session_id, auth.uid())
      )
      or (
        role = 'guest'
        and app_private.is_session_open(session_id)
      )
    )
  );

-- Optional: Ask PostgREST to reload its schema cache.
select pg_notify('pgrst', 'reload schema');

