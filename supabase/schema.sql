create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 48),
  join_code text not null unique,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 32),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 100),
  starts_on date not null default current_date,
  ends_on date not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);

create table if not exists public.completions (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  completed_on date not null default current_date,
  created_at timestamptz not null default now(),
  unique (challenge_id, user_id, completed_on)
);

create index if not exists challenges_group_created_idx
  on public.challenges (group_id, created_at desc);
create index if not exists completions_challenge_idx
  on public.completions (challenge_id);

alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.challenges enable row level security;
alter table public.completions enable row level security;

create or replace function public.is_group_member(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_group_member(uuid) from public;
grant execute on function public.is_group_member(uuid) to authenticated;

drop policy if exists "Group members can view their groups" on public.groups;
create policy "Group members can view their groups"
  on public.groups for select to authenticated
  using (public.is_group_member(id));

drop policy if exists "Members can view group membership" on public.group_members;
create policy "Members can view group membership"
  on public.group_members for select to authenticated
  using (public.is_group_member(group_id));

drop policy if exists "Members can view group challenges" on public.challenges;
create policy "Members can view group challenges"
  on public.challenges for select to authenticated
  using (public.is_group_member(group_id));

drop policy if exists "Members can create group challenges" on public.challenges;
create policy "Members can create group challenges"
  on public.challenges for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and public.is_group_member(group_id)
  );

drop policy if exists "Group members can view check-ins" on public.completions;
create policy "Group members can view check-ins"
  on public.completions for select to authenticated
  using (exists (
    select 1
    from public.challenges c
    where c.id = completions.challenge_id and public.is_group_member(c.group_id)
  ));

drop policy if exists "Members can check in for themselves" on public.completions;
create policy "Members can check in for themselves"
  on public.completions for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and completed_on = current_date
    and exists (
      select 1
      from public.challenges c
      where c.id = completions.challenge_id
        and public.is_group_member(c.group_id)
        and current_date between c.starts_on and c.ends_on
    )
  );

drop policy if exists "Members can undo their own check-ins" on public.completions;
create policy "Members can undo their own check-ins"
  on public.completions for delete to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.create_group(
  p_name text,
  p_challenge_title text,
  p_duration_days integer,
  p_display_name text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_group_id uuid;
  new_join_code text;
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'Sign in is required.';
  end if;
  if coalesce(char_length(trim(p_name)), 0) not between 1 and 48
    or coalesce(char_length(trim(p_challenge_title)), 0) not between 1 and 100
    or coalesce(char_length(trim(p_display_name)), 0) not between 1 and 32
    or coalesce(p_duration_days, 0) not between 1 and 30 then
    raise exception 'Please check the group, challenge, name, and duration.';
  end if;

  loop
    new_join_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16));
    exit when not exists (select 1 from public.groups where join_code = new_join_code);
  end loop;

  insert into public.groups (name, join_code, created_by)
  values (trim(p_name), new_join_code, current_user_id)
  returning id into new_group_id;

  insert into public.group_members (group_id, user_id, display_name)
  values (new_group_id, current_user_id, trim(p_display_name));

  insert into public.challenges (group_id, title, ends_on, created_by)
  values (new_group_id, trim(p_challenge_title), current_date + (p_duration_days - 1), current_user_id);

  return new_group_id;
end;
$$;

create or replace function public.join_group(p_join_code text, p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  found_group_id uuid;
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'Sign in is required.';
  end if;
  if coalesce(char_length(trim(p_display_name)), 0) not between 1 and 32 then
    raise exception 'Your name must be between 1 and 32 characters.';
  end if;

  select id into found_group_id
  from public.groups
  where join_code = upper(trim(p_join_code));

  if found_group_id is null then
    raise exception 'That invite code was not found. Check it and try again.';
  end if;

  insert into public.group_members (group_id, user_id, display_name)
  values (found_group_id, current_user_id, trim(p_display_name))
  on conflict (group_id, user_id)
  do update set display_name = excluded.display_name;

  return found_group_id;
end;
$$;

revoke all on function public.create_group(text, text, integer, text) from public;
revoke all on function public.join_group(text, text) from public;
grant execute on function public.create_group(text, text, integer, text) to authenticated;
grant execute on function public.join_group(text, text) to authenticated;

grant select on public.groups, public.group_members, public.challenges, public.completions to authenticated;
grant insert, delete on public.completions to authenticated;
