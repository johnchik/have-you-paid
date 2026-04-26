alter table public.profiles
  add column if not exists default_payment_comment text,
  add column if not exists default_accepts_fps boolean not null default false,
  add column if not exists default_accepts_payme boolean not null default false,
  add column if not exists payment_qr_url text;

alter table public.sessions
  add column if not exists host_payment_comment text,
  add column if not exists accepts_fps boolean not null default false,
  add column if not exists accepts_payme boolean not null default false;

create or replace function public.claim_guest_data(p_user_id uuid, p_guest_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  token_uuid uuid;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'claim_guest_data can only claim rows for the authenticated user';
  end if;

  if p_guest_token is null or p_guest_token = '' then
    return;
  end if;

  begin
    token_uuid := p_guest_token::uuid;
  exception
    when invalid_text_representation then
      return;
  end;

  update public.session_members
  set
    user_id = p_user_id,
    status = case when status = 'claimed' then 'linked' else status end
  where guest_token = token_uuid
    and user_id is null;
end;
$$;
