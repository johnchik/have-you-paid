-- Allow participants to read display names of others in the same sessions
create policy "profiles_select_session_peers"
  on public.profiles for select
  using (
    exists (
      select 1
      from public.session_participants me
      join public.session_participants peer on peer.session_id = me.session_id
      where me.user_id = auth.uid()
        and peer.user_id = public.profiles.id
    )
  );
