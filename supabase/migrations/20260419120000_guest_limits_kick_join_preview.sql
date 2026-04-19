-- Guest cap (null = unlimited), host kick / guest leave RPCs, join preview RPC,
-- tighten sessions SELECT, slot_count upper bound.

-- 1) max_guests: null means no limit; otherwise max number of guest rows (host not counted).
alter table public.sessions
  add column if not exists max_guests int null;

alter table public.sessions
  drop constraint if exists sessions_max_guests_check;

alter table public.sessions
  add constraint sessions_max_guests_check check (max_guests is null or max_guests >= 1);

-- 2) Enforce guest count before insert (clear error for join UI).
create or replace function public.enforce_session_guest_limit()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  cap int;
  cnt int;
begin
  if new.role <> 'guest' then
    return new;
  end if;
  select s.max_guests into cap from public.sessions s where s.id = new.session_id;
  if cap is null then
    return new;
  end if;
  select count(*)::int into cnt
  from public.session_participants sp
  where sp.session_id = new.session_id and sp.role = 'guest';
  if cnt >= cap then
    raise exception 'Guest limit reached for this session.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists session_participants_guest_limit on public.session_participants;

create trigger session_participants_guest_limit
  before insert on public.session_participants
  for each row execute function public.enforce_session_guest_limit();

-- 3) Tighten sessions: only host or participant may read rows (no "all open sessions" scan).
drop policy if exists "sessions_select" on public.sessions;

create policy "sessions_select"
  on public.sessions for select
  using (
    host_user_id = auth.uid()
    or public.is_session_participant(id, auth.uid())
  );

-- 4) Join preview for non-participants (minimal fields, open sessions only).
create or replace function public.get_session_join_preview(p_session_id uuid)
returns table (id uuid, status text)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.status::text
  from public.sessions s
  where s.id = p_session_id
    and s.status = 'open';
$$;

-- 5) Host removes a guest: claims + payment ack + participant (works open or locked).
create or replace function public.kick_session_guest(p_session_id uuid, p_guest_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if not exists (
    select 1 from public.sessions s
    where s.id = p_session_id and s.host_user_id = auth.uid()
  ) then
    raise exception 'Only the host can remove a guest';
  end if;
  if p_guest_user_id = auth.uid() then
    raise exception 'Cannot remove the host';
  end if;
  if not exists (
    select 1 from public.session_participants sp
    where sp.session_id = p_session_id
      and sp.user_id = p_guest_user_id
      and sp.role = 'guest'
  ) then
    raise exception 'User is not a guest in this session';
  end if;

  delete from public.split_item_slot_claims c
  using public.split_items si
  where c.split_item_id = si.id
    and si.session_id = p_session_id
    and c.claimed_by_user_id = p_guest_user_id;

  delete from public.payment_acknowledgements pa
  where pa.session_id = p_session_id and pa.user_id = p_guest_user_id;

  delete from public.session_participants sp
  where sp.session_id = p_session_id
    and sp.user_id = p_guest_user_id
    and sp.role = 'guest';
end;
$$;

-- 6) Guest leaves open session: own claims + ack + participant row.
create or replace function public.leave_session_as_guest(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if exists (
    select 1 from public.sessions s
    where s.id = p_session_id and s.host_user_id = auth.uid()
  ) then
    raise exception 'Host cannot leave with this action';
  end if;
  if not exists (
    select 1 from public.session_participants sp
    where sp.session_id = p_session_id
      and sp.user_id = auth.uid()
      and sp.role = 'guest'
  ) then
    raise exception 'You are not a guest in this session';
  end if;
  if exists (
    select 1 from public.sessions s
    where s.id = p_session_id and s.status <> 'open'
  ) then
    raise exception 'Session is locked; you cannot leave this way';
  end if;

  delete from public.split_item_slot_claims c
  using public.split_items si
  where c.split_item_id = si.id
    and si.session_id = p_session_id
    and c.claimed_by_user_id = auth.uid();

  delete from public.payment_acknowledgements pa
  where pa.session_id = p_session_id and pa.user_id = auth.uid();

  delete from public.session_participants sp
  where sp.session_id = p_session_id
    and sp.user_id = auth.uid()
    and sp.role = 'guest';
end;
$$;

-- 7) slot_count upper bound (matches app UI cap).
alter table public.split_items drop constraint if exists split_items_slot_count_check;

alter table public.split_items
  add constraint split_items_slot_count_bounds check (slot_count >= 1 and slot_count <= 20);

grant execute on function public.get_session_join_preview(uuid) to authenticated;

grant execute on function public.kick_session_guest(uuid, uuid) to authenticated;

grant execute on function public.leave_session_as_guest(uuid) to authenticated;
