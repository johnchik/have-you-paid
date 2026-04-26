drop policy if exists sessions_delete_host on public.sessions;
create policy sessions_delete_host
on public.sessions
for delete
using (public.is_session_host(id));
