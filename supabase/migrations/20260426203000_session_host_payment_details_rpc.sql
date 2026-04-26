create or replace function public.get_session_host_payment_details(p_session_id uuid)
returns table (
  display_name text,
  default_payment_comment text,
  default_accepts_fps boolean,
  default_accepts_payme boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.display_name,
    p.default_payment_comment,
    coalesce(p.default_accepts_fps, false) as default_accepts_fps,
    coalesce(p.default_accepts_payme, false) as default_accepts_payme
  from public.session_members sm
  join public.profiles p on p.id = sm.user_id
  where sm.session_id = p_session_id
    and sm.is_host = true
  limit 1
$$;
