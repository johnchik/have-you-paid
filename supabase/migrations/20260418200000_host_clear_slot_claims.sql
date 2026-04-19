-- Allow host to delete any slot claim on their open session (e.g. after reducing slot_count)
create policy "slot_claims_delete_host_open_session"
  on public.split_item_slot_claims for delete
  using (
    public.is_session_host(public.split_item_session_id(split_item_id), auth.uid())
    and exists (
      select 1 from public.sessions s
      where s.id = public.split_item_session_id(split_item_id)
        and s.status = 'open'
    )
  );
