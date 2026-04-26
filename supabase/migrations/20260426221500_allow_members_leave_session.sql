drop policy if exists session_members_delete_host_or_self on public.session_members;
create policy session_members_delete_host_or_self
on public.session_members
for delete
using (
  public.is_session_host(session_id)
  or (
    not is_host
    and public.is_current_member_row(session_id, id)
  )
);
