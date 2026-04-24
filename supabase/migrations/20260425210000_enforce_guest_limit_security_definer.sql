-- Guest count must see *all* guest rows for the session. The previous trigger used
-- SECURITY INVOKER, so the joining user could not SELECT other guests' rows under RLS,
-- and the count was always too low (guest cap effectively broken).

create or replace function public.enforce_session_guest_limit()
returns trigger
language plpgsql
security definer
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
