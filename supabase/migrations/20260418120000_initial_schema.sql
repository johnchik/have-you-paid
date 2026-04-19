-- Bill-sharing: sessions, split items, claims, payment acks, profiles
create extension if not exists "pgcrypto";

-- Profiles
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Guest',
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  using (id = auth.uid());

create policy "profiles_insert_own"
  on public.profiles for insert
  with check (id = auth.uid());

create policy "profiles_update_own"
  on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- Core tables (RLS enabled after policies are defined)
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  host_user_id uuid not null references auth.users (id) on delete restrict,
  receipt_storage_path text,
  status text not null default 'open' check (status in ('open', 'locked')),
  locked_at timestamptz,
  title text,
  created_at timestamptz not null default now()
);

create index sessions_host_user_id_idx on public.sessions (host_user_id);

create table public.session_participants (
  session_id uuid not null references public.sessions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('host', 'guest')),
  joined_at timestamptz not null default now(),
  primary key (session_id, user_id)
);

create index session_participants_user_id_idx on public.session_participants (user_id);

create table public.split_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  slot_count int not null check (slot_count >= 1),
  anchor_x numeric not null check (anchor_x >= 0 and anchor_x <= 1),
  anchor_y numeric not null check (anchor_y >= 0 and anchor_y <= 1),
  label text,
  created_at timestamptz not null default now()
);

create index split_items_session_id_idx on public.split_items (session_id);

create table public.split_item_slot_claims (
  id uuid primary key default gen_random_uuid(),
  split_item_id uuid not null references public.split_items (id) on delete cascade,
  slot_index int not null check (slot_index >= 1),
  claimed_by_user_id uuid not null references auth.users (id) on delete cascade,
  claimed_at timestamptz not null default now(),
  unique (split_item_id, slot_index)
);

create index split_item_slot_claims_split_item_id_idx on public.split_item_slot_claims (split_item_id);

create table public.payment_acknowledgements (
  session_id uuid not null references public.sessions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  primary key (session_id, user_id)
);

create index payment_acknowledgements_session_id_idx on public.payment_acknowledgements (session_id);

-- Helper functions (after tables exist)
create or replace function public.is_session_participant(p_session_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.session_participants sp
    where sp.session_id = p_session_id
      and sp.user_id = p_user_id
  );
$$;

create or replace function public.is_session_host(p_session_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.sessions s
    where s.id = p_session_id
      and s.host_user_id = p_user_id
  );
$$;

create or replace function public.split_item_session_id(p_split_item_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select session_id from public.split_items where id = p_split_item_id;
$$;

create or replace function public.validate_slot_claim()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid;
  sc int;
  sess_status text;
begin
  select si.session_id, si.slot_count into sid, sc
  from public.split_items si
  where si.id = new.split_item_id;

  if sid is null then
    raise exception 'split_item not found';
  end if;

  if new.slot_index > sc then
    raise exception 'slot_index exceeds slot_count';
  end if;

  select s.status into sess_status from public.sessions s where s.id = sid;
  if sess_status <> 'open' then
    raise exception 'session is locked';
  end if;

  return new;
end;
$$;

create trigger split_item_slot_claims_validate
  before insert on public.split_item_slot_claims
  for each row execute function public.validate_slot_claim();

-- RLS: sessions
alter table public.sessions enable row level security;

create policy "sessions_select"
  on public.sessions for select
  using (
    host_user_id = auth.uid()
    or public.is_session_participant(id, auth.uid())
    or (status = 'open' and auth.uid() is not null)
  );

create policy "sessions_insert_host"
  on public.sessions for insert
  with check (host_user_id = auth.uid());

create policy "sessions_update_host"
  on public.sessions for update
  using (public.is_session_host(id, auth.uid()))
  with check (public.is_session_host(id, auth.uid()));

-- RLS: session_participants
alter table public.session_participants enable row level security;

create policy "session_participants_select"
  on public.session_participants for select
  using (
    public.is_session_participant(session_id, auth.uid())
    or public.is_session_host(session_id, auth.uid())
  );

create policy "session_participants_insert"
  on public.session_participants for insert
  with check (
    user_id = auth.uid()
    and (
      (
        role = 'host'
        and exists (
          select 1 from public.sessions s
          where s.id = session_id
            and s.host_user_id = auth.uid()
        )
      )
      or (
        role = 'guest'
        and exists (
          select 1 from public.sessions s
          where s.id = session_id
            and s.status = 'open'
        )
      )
    )
  );

-- RLS: split_items
alter table public.split_items enable row level security;

create policy "split_items_select_participant"
  on public.split_items for select
  using (public.is_session_participant(session_id, auth.uid()));

create policy "split_items_insert_host"
  on public.split_items for insert
  with check (
    public.is_session_host(session_id, auth.uid())
    and exists (select 1 from public.sessions s where s.id = session_id and s.status = 'open')
  );

create policy "split_items_update_host"
  on public.split_items for update
  using (public.is_session_host(session_id, auth.uid()))
  with check (public.is_session_host(session_id, auth.uid()));

create policy "split_items_delete_host"
  on public.split_items for delete
  using (public.is_session_host(session_id, auth.uid()));

-- RLS: slot claims
alter table public.split_item_slot_claims enable row level security;

create policy "slot_claims_select_participant"
  on public.split_item_slot_claims for select
  using (
    public.is_session_participant(public.split_item_session_id(split_item_id), auth.uid())
  );

create policy "slot_claims_insert_self_participant_open"
  on public.split_item_slot_claims for insert
  with check (
    claimed_by_user_id = auth.uid()
    and public.is_session_participant(public.split_item_session_id(split_item_id), auth.uid())
    and exists (
      select 1 from public.sessions s
      where s.id = public.split_item_session_id(split_item_id)
        and s.status = 'open'
    )
  );

create policy "slot_claims_delete_own_open"
  on public.split_item_slot_claims for delete
  using (
    claimed_by_user_id = auth.uid()
    and exists (
      select 1 from public.sessions s
      where s.id = public.split_item_session_id(split_item_id)
        and s.status = 'open'
    )
  );

-- RLS: payment acknowledgements
alter table public.payment_acknowledgements enable row level security;

create policy "payment_ack_select_participant"
  on public.payment_acknowledgements for select
  using (public.is_session_participant(session_id, auth.uid()));

create policy "payment_ack_insert_own"
  on public.payment_acknowledgements for insert
  with check (user_id = auth.uid() and public.is_session_participant(session_id, auth.uid()));

create policy "payment_ack_update_own"
  on public.payment_acknowledgements for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Auth: auto profile (runs with definer; not used for authz)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, 'Guest')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Realtime (ignore if already member of publication)
do $$
begin
  alter publication supabase_realtime add table public.sessions;
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  alter publication supabase_realtime add table public.session_participants;
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  alter publication supabase_realtime add table public.split_items;
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  alter publication supabase_realtime add table public.split_item_slot_claims;
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  alter publication supabase_realtime add table public.payment_acknowledgements;
exception
  when duplicate_object then null;
end;
$$;

-- Storage
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do update set public = excluded.public;

create policy "receipts_select_participant"
  on storage.objects for select
  using (
    bucket_id = 'receipts'
    and exists (
      select 1
      from public.sessions s
      join public.session_participants p on p.session_id = s.id
      where p.user_id = auth.uid()
        and s.id::text = split_part(name, '/', 1)
    )
  );

create policy "receipts_insert_host_folder"
  on storage.objects for insert
  with check (
    bucket_id = 'receipts'
    and auth.uid() is not null
    and exists (
      select 1 from public.sessions s
      where s.host_user_id = auth.uid()
        and s.id::text = split_part(name, '/', 1)
    )
  );

create policy "receipts_update_host_folder"
  on storage.objects for update
  using (
    bucket_id = 'receipts'
    and exists (
      select 1 from public.sessions s
      where s.host_user_id = auth.uid()
        and s.id::text = split_part(name, '/', 1)
    )
  );

create policy "receipts_delete_host_folder"
  on storage.objects for delete
  using (
    bucket_id = 'receipts'
    and exists (
      select 1 from public.sessions s
      where s.host_user_id = auth.uid()
        and s.id::text = split_part(name, '/', 1)
    )
  );
