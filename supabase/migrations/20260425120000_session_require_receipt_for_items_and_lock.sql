-- Enforce: split lines and locking require a receipt image on the session (host "limited mode" until upload).

create or replace function public.sessions_enforce_receipt_before_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'locked' and (new.receipt_storage_path is null or btrim(new.receipt_storage_path) = '') then
    raise exception 'Cannot lock a session before a receipt image is uploaded';
  end if;
  return new;
end;
$$;

drop trigger if exists sessions_receipt_before_lock on public.sessions;
create trigger sessions_receipt_before_lock
  before update on public.sessions
  for each row
  execute function public.sessions_enforce_receipt_before_lock();

drop policy if exists "split_items_insert_host" on public.split_items;
create policy "split_items_insert_host"
  on public.split_items for insert
  with check (
    public.is_session_host(session_id, auth.uid())
    and exists (
      select 1
      from public.sessions s
      where s.id = session_id
        and s.status = 'open'
        and s.receipt_storage_path is not null
        and btrim(s.receipt_storage_path) <> ''
    )
  );
