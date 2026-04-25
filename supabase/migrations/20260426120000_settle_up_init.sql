create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Guest',
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  currency text not null default 'HKD',
  status text not null default 'open' check (status in ('open', 'settled')),
  receipt_storage_path text,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.session_members (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  display_name text not null,
  guest_token uuid,
  user_id uuid references auth.users (id) on delete set null,
  is_host boolean not null default false,
  status text not null default 'placeholder' check (status in ('placeholder', 'claimed', 'linked')),
  avatar_color text,
  claimed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists session_members_one_host_per_session_idx
  on public.session_members (session_id)
  where is_host;

create unique index if not exists session_members_session_guest_token_idx
  on public.session_members (session_id, guest_token)
  where guest_token is not null;

create index if not exists session_members_guest_token_idx on public.session_members (guest_token);
create index if not exists session_members_user_id_idx on public.session_members (user_id);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  name text not null,
  amount numeric(12, 2) not null check (amount >= 0),
  source text not null default 'manual' check (source in ('ocr', 'manual')),
  sort_order integer,
  ocr_confidence numeric(5, 2),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists expenses_session_id_idx on public.expenses (session_id, created_at);

create table if not exists public.expense_claims (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.expenses (id) on delete cascade,
  member_id uuid not null references public.session_members (id) on delete cascade,
  share_amount numeric(12, 2) not null check (share_amount >= 0),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists expense_claims_expense_id_idx on public.expense_claims (expense_id);
create index if not exists expense_claims_member_id_idx on public.expense_claims (member_id);

create table if not exists public.settlements (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  from_member_id uuid not null references public.session_members (id) on delete cascade,
  to_member_id uuid not null references public.session_members (id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'confirmed')),
  created_at timestamptz not null default timezone('utc', now()),
  confirmed_at timestamptz
);

create index if not exists settlements_session_id_idx on public.settlements (session_id, created_at);
create index if not exists settlements_from_member_id_idx on public.settlements (from_member_id);
create index if not exists settlements_to_member_id_idx on public.settlements (to_member_id);

create or replace function public.touch_profile_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create or replace function public.sync_member_status_fields()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'placeholder' then
    new.guest_token = null;
    new.user_id = null;
    new.claimed_at = null;
  elsif new.status = 'claimed' then
    if new.guest_token is null then
      raise exception 'claimed members require guest_token';
    end if;
    new.claimed_at = coalesce(new.claimed_at, timezone('utc', now()));
  elsif new.status = 'linked' then
    if new.guest_token is null then
      raise exception 'linked members require guest_token';
    end if;
    if new.user_id is null then
      raise exception 'linked members require user_id';
    end if;
    new.claimed_at = coalesce(new.claimed_at, timezone('utc', now()));
  end if;

  return new;
end;
$$;

create or replace function public.recompute_session_status(p_session_id uuid)
returns void
language plpgsql
as $$
declare
  unsettled_count integer;
begin
  select count(*)
    into unsettled_count
  from public.session_members m
  left join (
    select ec.member_id, coalesce(sum(ec.share_amount), 0)::numeric(12, 2) as total_owed
    from public.expense_claims ec
    join public.expenses e on e.id = ec.expense_id
    where e.session_id = p_session_id
    group by ec.member_id
  ) owed on owed.member_id = m.id
  left join (
    select s.from_member_id, coalesce(sum(s.amount), 0)::numeric(12, 2) as total_confirmed
    from public.settlements s
    where s.session_id = p_session_id and s.status = 'confirmed'
    group by s.from_member_id
  ) settled on settled.from_member_id = m.id
  where m.session_id = p_session_id
    and not m.is_host
    and round(coalesce(owed.total_owed, 0) - coalesce(settled.total_confirmed, 0), 2) > 0;

  update public.sessions
  set status = case when unsettled_count = 0 then 'settled' else 'open' end
  where id = p_session_id;
end;
$$;

create or replace function public.recompute_session_status_from_expense()
returns trigger
language plpgsql
as $$
declare
  target_session_id uuid;
begin
  select e.session_id into target_session_id
  from public.expenses e
  where e.id = coalesce(new.expense_id, old.expense_id);

  if target_session_id is not null then
    perform public.recompute_session_status(target_session_id);
  end if;

  return coalesce(new, old);
end;
$$;

create or replace function public.recompute_session_status_from_settlement()
returns trigger
language plpgsql
as $$
begin
  perform public.recompute_session_status(coalesce(new.session_id, old.session_id));
  return coalesce(new, old);
end;
$$;

create or replace function public.current_guest_token_text()
returns text
language sql
stable
as $$
  select nullif(current_setting('request.headers', true)::json ->> 'x-guest-token', '')
$$;

create or replace function public.current_guest_token_uuid()
returns uuid
language plpgsql
stable
as $$
declare
  token_text text;
begin
  token_text := public.current_guest_token_text();

  if token_text is null then
    return null;
  end if;

  if token_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return token_text::uuid;
  end if;

  return null;
end;
$$;

create or replace function public.is_session_member(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.session_members m
    where m.session_id = p_session_id
      and (
        m.guest_token = public.current_guest_token_uuid()
        or (auth.uid() is not null and m.user_id = auth.uid())
      )
  )
$$;

create or replace function public.is_session_host(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.session_members m
    where m.session_id = p_session_id
      and m.is_host
      and (
        m.guest_token = public.current_guest_token_uuid()
        or (auth.uid() is not null and m.user_id = auth.uid())
      )
  )
$$;

create or replace function public.expense_session_id(p_expense_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select e.session_id
  from public.expenses e
  where e.id = p_expense_id
$$;

create or replace function public.member_session_id(p_member_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.session_id
  from public.session_members m
  where m.id = p_member_id
$$;

create or replace function public.receipt_session_id(path text)
returns uuid
language plpgsql
stable
as $$
declare
  first_segment text;
begin
  first_segment := split_part(path, '/', 1);

  if first_segment ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return first_segment::uuid;
  end if;

  return null;
end;
$$;

create or replace function public.is_current_member_row(p_session_id uuid, p_member_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.session_members m
    where m.id = p_member_id
      and m.session_id = p_session_id
      and (
        m.guest_token = public.current_guest_token_uuid()
        or (auth.uid() is not null and m.user_id = auth.uid())
      )
  )
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
before update on public.profiles
for each row
execute function public.touch_profile_updated_at();

drop trigger if exists session_members_sync_status_fields on public.session_members;
create trigger session_members_sync_status_fields
before insert or update on public.session_members
for each row
execute function public.sync_member_status_fields();

drop trigger if exists expense_claims_recompute_session_status on public.expense_claims;
create trigger expense_claims_recompute_session_status
after insert or update or delete on public.expense_claims
for each row
execute function public.recompute_session_status_from_expense();

drop trigger if exists settlements_recompute_session_status on public.settlements;
create trigger settlements_recompute_session_status
after insert or update or delete on public.settlements
for each row
execute function public.recompute_session_status_from_settlement();

alter table public.profiles enable row level security;
alter table public.sessions enable row level security;
alter table public.session_members enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_claims enable row level security;
alter table public.settlements enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
on public.profiles
for select
using (auth.uid() = id);

drop policy if exists profiles_upsert_own on public.profiles;
create policy profiles_upsert_own
on public.profiles
for all
using (auth.uid() = id)
with check (auth.uid() = id);

drop policy if exists sessions_select_public on public.sessions;
create policy sessions_select_public
on public.sessions
for select
using (true);

drop policy if exists sessions_insert_public on public.sessions;
create policy sessions_insert_public
on public.sessions
for insert
with check (true);

drop policy if exists sessions_update_host on public.sessions;
create policy sessions_update_host
on public.sessions
for update
using (public.is_session_host(id))
with check (public.is_session_host(id));

drop policy if exists session_members_select_public on public.session_members;
create policy session_members_select_public
on public.session_members
for select
using (true);

drop policy if exists session_members_insert_claim_or_host on public.session_members;
create policy session_members_insert_claim_or_host
on public.session_members
for insert
with check (
  public.is_session_host(session_id)
  or (
    guest_token = public.current_guest_token_uuid()
    and (user_id is null or user_id = auth.uid())
  )
);

drop policy if exists session_members_update_host_or_self on public.session_members;
create policy session_members_update_host_or_self
on public.session_members
for update
using (
  public.is_session_host(session_id)
  or status = 'placeholder'
  or guest_token = public.current_guest_token_uuid()
  or (auth.uid() is not null and user_id = auth.uid())
)
with check (
  public.is_session_host(session_id)
  or guest_token = public.current_guest_token_uuid()
  or (auth.uid() is not null and user_id = auth.uid())
  or status = 'placeholder'
);

drop policy if exists session_members_delete_host on public.session_members;
create policy session_members_delete_host
on public.session_members
for delete
using (public.is_session_host(session_id));

drop policy if exists expenses_select_member on public.expenses;
create policy expenses_select_member
on public.expenses
for select
using (public.is_session_member(session_id));

drop policy if exists expenses_insert_host on public.expenses;
create policy expenses_insert_host
on public.expenses
for insert
with check (public.is_session_host(session_id));

drop policy if exists expenses_update_host on public.expenses;
create policy expenses_update_host
on public.expenses
for update
using (public.is_session_host(session_id))
with check (public.is_session_host(session_id));

drop policy if exists expenses_delete_host on public.expenses;
create policy expenses_delete_host
on public.expenses
for delete
using (public.is_session_host(session_id));

drop policy if exists expense_claims_select_member on public.expense_claims;
create policy expense_claims_select_member
on public.expense_claims
for select
using (public.is_session_member(public.expense_session_id(expense_id)));

drop policy if exists expense_claims_write_member on public.expense_claims;
create policy expense_claims_write_member
on public.expense_claims
for all
using (public.is_session_member(public.expense_session_id(expense_id)))
with check (public.is_session_member(public.expense_session_id(expense_id)));

drop policy if exists settlements_select_member on public.settlements;
create policy settlements_select_member
on public.settlements
for select
using (public.is_session_member(session_id));

drop policy if exists settlements_write_host on public.settlements;
drop policy if exists settlements_write_host_or_self on public.settlements;
drop policy if exists settlements_insert_host_or_self on public.settlements;
drop policy if exists settlements_update_host_or_self on public.settlements;
drop policy if exists settlements_delete_host_or_self on public.settlements;

create policy settlements_insert_host_or_self
on public.settlements
for insert
with check (
  public.is_session_host(session_id)
  or public.is_current_member_row(session_id, from_member_id)
);

create policy settlements_update_host_or_self
on public.settlements
for update
using (
  public.is_session_host(session_id)
  or public.is_current_member_row(session_id, from_member_id)
)
with check (
  public.is_session_host(session_id)
  or public.is_current_member_row(session_id, from_member_id)
);

create policy settlements_delete_host_or_self
on public.settlements
for delete
using (
  public.is_session_host(session_id)
  or public.is_current_member_row(session_id, from_member_id)
);

insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

drop policy if exists receipts_select_member on storage.objects;
create policy receipts_select_member
on storage.objects
for select
using (
  bucket_id = 'receipts'
  and public.is_session_member(public.receipt_session_id(name))
);

drop policy if exists receipts_insert_host on storage.objects;
create policy receipts_insert_host
on storage.objects
for insert
with check (
  bucket_id = 'receipts'
  and public.is_session_host(public.receipt_session_id(name))
);

drop policy if exists receipts_update_host on storage.objects;
create policy receipts_update_host
on storage.objects
for update
using (
  bucket_id = 'receipts'
  and public.is_session_host(public.receipt_session_id(name))
)
with check (
  bucket_id = 'receipts'
  and public.is_session_host(public.receipt_session_id(name))
);

drop policy if exists receipts_delete_host on storage.objects;
create policy receipts_delete_host
on storage.objects
for delete
using (
  bucket_id = 'receipts'
  and public.is_session_host(public.receipt_session_id(name))
);
