-- Private challenges and invites (plan step 6.1). PRODUCT.md stories 2 and 3.
--
-- Adds the rest of a challenge's fields, invite codes, and the functions the
-- app calls to create, edit and delete a challenge and to look up an invite.
-- Creating a challenge also places the creator's own stake, through the same
-- join_challenge as everyone else.

-- ---------------------------------------------------------------------------
-- Challenge fields
-- ---------------------------------------------------------------------------

alter table public.challenges
  add column rule text not null default '' check (length(rule) <= 280),
  -- 7 means every day; otherwise N times a week.
  add column times_per_week integer not null default 7 check (times_per_week between 1 and 7),
  add column start_date date not null default current_date + 1,
  add column length_days integer not null default 7 check (length_days between 7 and 30),
  add column misses_allowed integer not null default 0 check (misses_allowed >= 0),
  -- The creator's time zone when creating; status changes at the start date use it.
  add column time_zone text not null default 'UTC',
  -- A deleted challenge keeps its row because the ledger refers to it.
  add column deleted_at timestamptz,
  add constraint challenges_misses_within_length check (misses_allowed < length_days);

-- Only live challenges are visible to the app.
drop policy "Creators and members read a challenge" on public.challenges;
create policy "Creators and members read a live challenge"
  on public.challenges for select to authenticated
  using (deleted_at is null and (creator_id = (select auth.uid()) or public.is_challenge_member(id)));

-- ---------------------------------------------------------------------------
-- Invites
-- ---------------------------------------------------------------------------

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges (id),
  code text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  created_by uuid not null references public.profiles (id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index invites_challenge on public.invites (challenge_id);

alter table public.invites enable row level security;
revoke all on public.invites from anon, authenticated;
grant select on public.invites to authenticated;

create policy "Creators read their challenges' invites"
  on public.invites for select to authenticated
  using (exists (
    select 1 from public.challenges c
    where c.id = challenge_id and c.creator_id = (select auth.uid()) and c.deleted_at is null
  ));

-- Six characters, no letters that look like digits (0/O, 1/I/L). The random
-- source is the same strong generator that makes ids.
create function public.invite_code() returns text
  language plpgsql set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  bytes constant bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  code text := '';
begin
  for i in 0..5 loop
    code := code || substr(alphabet, get_byte(bytes, i) % length(alphabet) + 1, 1);
  end loop;
  return code;
end;
$$;

-- The moment the challenge starts for its creator: midnight at the start of
-- the start date in the creator's time zone. Invites stop working then.
create function public.challenge_starts_at(p_start_date date, p_time_zone text) returns timestamptz
  language sql immutable set search_path = ''
as $$
  select p_start_date::timestamp at time zone p_time_zone;
$$;

-- ---------------------------------------------------------------------------
-- Names of people in your challenges (ARCHITECTURE.md, "Permissions")
-- ---------------------------------------------------------------------------

create function public.shares_challenge_with(p_user_id uuid) returns boolean
  language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.challenge_members mine
    join public.challenge_members theirs on theirs.challenge_id = mine.challenge_id
    where mine.user_id = (select auth.uid()) and theirs.user_id = p_user_id
  );
$$;

-- The app sees only the name of other people, never their role.
revoke select on public.profiles from authenticated;
grant select (id, display_name) on public.profiles to authenticated;

create policy "Members of your challenges see your name"
  on public.profiles for select to authenticated
  using (public.shares_challenge_with(id));

-- ---------------------------------------------------------------------------
-- Checks shared by create and update
-- ---------------------------------------------------------------------------

create function public.check_challenge_fields(
  p_title text, p_rule text, p_times_per_week integer, p_start_date date,
  p_length_days integer, p_misses_allowed integer, p_time_zone text
) returns void
  language plpgsql set search_path = ''
as $$
begin
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'give the challenge a title';
  end if;
  if length(p_title) > 80 then
    raise exception 'the title can be 80 characters at most';
  end if;
  if length(coalesce(p_rule, '')) > 280 then
    raise exception 'the rule can be 280 characters at most';
  end if;
  if p_times_per_week is null or p_times_per_week not between 1 and 7 then
    raise exception 'how often must be between 1 and 7 times a week';
  end if;
  if p_length_days is null or p_length_days not between 7 and 30 then
    raise exception 'a challenge lasts between 7 and 30 days';
  end if;
  if p_misses_allowed is null or p_misses_allowed < 0 or p_misses_allowed >= p_length_days then
    raise exception 'misses allowed must be between 0 and one less than the length';
  end if;
  if p_time_zone is null
    or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_time_zone) then
    raise exception 'unknown time zone %', p_time_zone;
  end if;
  -- Friends join before the start date (PRODUCT.md 3.3), so a challenge
  -- starting today could never be joined: the earliest start is tomorrow.
  if p_start_date is null or p_start_date <= (now() at time zone p_time_zone)::date then
    raise exception 'the start date must be tomorrow or later';
  end if;
  if p_start_date > (now() at time zone p_time_zone)::date + 90 then
    raise exception 'the start date can be at most 90 days away';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Create, edit, delete (PRODUCT.md 2.1, 2.2)
-- ---------------------------------------------------------------------------

-- Creates the challenge, its invite code, and places the creator's stake.
-- Everything is undone if the creator cannot afford the stake.
create function public.create_challenge(
  p_title text, p_rule text, p_times_per_week integer, p_start_date date,
  p_length_days integer, p_stake integer, p_misses_allowed integer, p_time_zone text
) returns uuid
  language plpgsql security definer set search_path = ''
as $$
declare
  me constant uuid := (select auth.uid());
  challenge uuid;
begin
  if me is null then
    raise exception 'sign in first' using errcode = 'insufficient_privilege';
  end if;
  perform public.check_challenge_fields(
    p_title, p_rule, p_times_per_week, p_start_date, p_length_days, p_misses_allowed, p_time_zone);
  if p_stake is null or p_stake < 1 then
    raise exception 'the stake must be at least 1 token';
  end if;

  insert into public.challenges
    (creator_id, title, rule, times_per_week, start_date, length_days, stake, misses_allowed, time_zone, status)
  values
    (me, trim(p_title), trim(coalesce(p_rule, '')), p_times_per_week, p_start_date, p_length_days,
     p_stake, p_misses_allowed, p_time_zone, 'open')
  returning id into challenge;

  for attempt in 1..5 loop
    begin
      insert into public.invites (challenge_id, code, created_by, expires_at)
      values (challenge, public.invite_code(), me, public.challenge_starts_at(p_start_date, p_time_zone));
      exit;
    exception when unique_violation then
      if attempt = 5 then raise; end if;
    end;
  end loop;

  perform public.join_challenge(challenge, p_time_zone);
  return challenge;
end;
$$;

-- The creator can change everything but the stake before the start.
create function public.update_challenge(
  p_id uuid, p_title text, p_rule text, p_times_per_week integer, p_start_date date,
  p_length_days integer, p_misses_allowed integer
) returns void
  language plpgsql security definer set search_path = ''
as $$
declare
  me constant uuid := (select auth.uid());
  c public.challenges;
begin
  select * into c from public.challenges where id = p_id for update;
  if not found or c.deleted_at is not null or c.creator_id is distinct from me then
    raise exception 'only the creator can edit this challenge';
  end if;
  if c.status not in ('draft', 'open') then
    raise exception 'a challenge cannot change once it has started';
  end if;
  perform public.check_challenge_fields(
    p_title, p_rule, p_times_per_week, p_start_date, p_length_days, p_misses_allowed, c.time_zone);

  update public.challenges
  set title = trim(p_title), rule = trim(coalesce(p_rule, '')), times_per_week = p_times_per_week,
    start_date = p_start_date, length_days = p_length_days, misses_allowed = p_misses_allowed
  where id = c.id;
  update public.invites
  set expires_at = public.challenge_starts_at(p_start_date, c.time_zone)
  where challenge_id = c.id;
end;
$$;

-- Deleting before the start gives every member their stake back. The row
-- stays, hidden, because the ledger history points at it.
create function public.delete_challenge(p_id uuid) returns void
  language plpgsql security definer set search_path = ''
as $$
declare
  me constant uuid := (select auth.uid());
  c public.challenges;
  m record;
  tx uuid;
begin
  select * into c from public.challenges where id = p_id for update;
  if not found or c.deleted_at is not null or c.creator_id is distinct from me then
    raise exception 'only the creator can delete this challenge';
  end if;
  if c.status not in ('draft', 'open') then
    raise exception 'a challenge cannot be deleted once it has started';
  end if;

  for m in select id, user_id from public.challenge_members where challenge_id = c.id loop
    tx := public.ledger_begin('refund', 'refund:' || m.id, c.id, 'Refund: ' || c.title || ' was deleted', me);
    perform public.ledger_post(tx, public.ledger_pool(c.id), -c.stake);
    perform public.ledger_post(tx, public.ledger_wallet(m.user_id), c.stake);
  end loop;
  delete from public.challenge_members where challenge_id = c.id;
  delete from public.invites where challenge_id = c.id;
  update public.challenges set deleted_at = now() where id = c.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Invite lookup (PRODUCT.md 3.1, 3.3): details only, for anyone signed in
-- who holds the code
-- ---------------------------------------------------------------------------

create function public.invite_preview(p_code text) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  me constant uuid := (select auth.uid());
  i public.invites;
  c public.challenges;
  member_count integer;
  already_member boolean;
  blocker text;
begin
  if me is null then
    raise exception 'sign in first' using errcode = 'insufficient_privilege';
  end if;
  select * into i from public.invites where code = upper(trim(coalesce(p_code, '')));
  if not found then
    raise exception 'no challenge matches this code';
  end if;
  select * into c from public.challenges where id = i.challenge_id;
  if c.deleted_at is not null then
    raise exception 'no challenge matches this code';
  end if;

  select count(*), bool_or(user_id = me) into member_count, already_member
  from public.challenge_members where challenge_id = c.id;
  already_member := coalesce(already_member, false);

  blocker := case
    when already_member then 'you are already in this challenge'
    when c.status <> 'open' or now() >= i.expires_at then 'this challenge has already started'
    when member_count >= 10 then 'this challenge is full (10 members)'
  end;

  return jsonb_build_object(
    'challenge_id', c.id,
    'title', c.title,
    'rule', c.rule,
    'times_per_week', c.times_per_week,
    'start_date', c.start_date,
    'length_days', c.length_days,
    'stake', c.stake,
    'misses_allowed', c.misses_allowed,
    'status', c.status,
    'member_count', member_count,
    'creator_name', (select display_name from public.profiles where id = c.creator_id),
    'already_member', already_member,
    'can_join', blocker is null,
    'blocker', blocker
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Joining and leaving ignore deleted challenges
-- ---------------------------------------------------------------------------

create or replace function public.join_challenge(p_challenge_id uuid, p_time_zone text) returns uuid
  language plpgsql security definer set search_path = ''
as $$
declare
  me constant uuid := (select auth.uid());
  c public.challenges;
  member uuid;
  tx uuid;
begin
  if me is null then
    raise exception 'sign in first' using errcode = 'insufficient_privilege';
  end if;
  -- Lock the challenge: joins, leaves, quits and status changes of one
  -- challenge then run one after the other.
  select * into c from public.challenges where id = p_challenge_id for update;
  if not found or c.status <> 'open' or c.deleted_at is not null then
    raise exception 'this challenge is not open for joining';
  end if;
  if p_time_zone is null
    or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_time_zone) then
    raise exception 'unknown time zone %', p_time_zone;
  end if;
  if exists (select 1 from public.challenge_members where challenge_id = c.id and user_id = me) then
    raise exception 'you have already joined this challenge';
  end if;
  if (select count(*) from public.challenge_members where challenge_id = c.id) >= 10 then
    raise exception 'this challenge is full (10 members)';
  end if;

  insert into public.challenge_members (challenge_id, user_id, time_zone)
  values (c.id, me, p_time_zone)
  returning id into member;

  tx := public.ledger_begin('stake', 'stake:' || member, c.id, 'Stake: ' || c.title, me);
  perform public.ledger_post(tx, public.ledger_wallet(me), -c.stake);
  perform public.ledger_post(tx, public.ledger_pool(c.id), c.stake);
  -- Check the balance now, so the error comes from this call, not at commit.
  set constraints public.ledger_entries_not_negative immediate;
  return member;
end;
$$;

create or replace function public.leave_challenge(p_challenge_id uuid) returns void
  language plpgsql security definer set search_path = ''
as $$
declare
  me constant uuid := (select auth.uid());
  c public.challenges;
  m public.challenge_members;
  tx uuid;
begin
  if me is null then
    raise exception 'sign in first' using errcode = 'insufficient_privilege';
  end if;
  select * into c from public.challenges where id = p_challenge_id for update;
  if not found or c.status not in ('draft', 'open') or c.deleted_at is not null then
    raise exception 'you can only leave before the challenge starts';
  end if;
  select * into m from public.challenge_members where challenge_id = c.id and user_id = me;
  if not found then
    raise exception 'you are not in this challenge';
  end if;

  tx := public.ledger_begin('refund', 'refund:' || m.id, c.id, 'Left: ' || c.title, me);
  perform public.ledger_post(tx, public.ledger_pool(c.id), -c.stake);
  perform public.ledger_post(tx, public.ledger_wallet(me), c.stake);
  delete from public.challenge_members where id = m.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Who may call what (new functions are closed by default)
-- ---------------------------------------------------------------------------

grant execute on function public.create_challenge(text, text, integer, date, integer, integer, integer, text)
  to authenticated;
grant execute on function public.update_challenge(uuid, text, text, integer, date, integer, integer)
  to authenticated;
grant execute on function public.delete_challenge(uuid) to authenticated;
grant execute on function public.invite_preview(text) to authenticated;
-- Used inside an RLS policy, which runs as the reading user.
grant execute on function public.shares_challenge_with(uuid) to authenticated;
