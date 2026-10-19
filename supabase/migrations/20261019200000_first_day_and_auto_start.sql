-- Changes from the owner's first test (2026-10-19): a challenge can start
-- today and last 1 to 30 days, friends can join during its first day, and
-- challenges start by themselves at midnight.
--
-- The first day of a challenge is its open day: friends can join or leave
-- and the creator can edit or delete, until midnight at the end of the start
-- date in the creator's time zone. From the second day nothing changes.
-- A challenge becomes active at midnight at the start of its start date (a
-- scheduled job runs every minute); one created for today is active at once.

-- ---------------------------------------------------------------------------
-- Fields
-- ---------------------------------------------------------------------------

alter table public.challenges
  drop constraint challenges_length_days_check,
  add constraint challenges_length_days_check check (length_days between 1 and 30),
  alter column start_date set default current_date;

-- Midnight at the end of the start date, when the first day is over.
create function public.challenge_join_closes_at(p_start_date date, p_time_zone text) returns timestamptz
  language sql immutable set search_path = ''
as $$
  select public.challenge_starts_at(p_start_date + 1, p_time_zone);
$$;

-- True while a challenge can still change: live, and its first day not over.
create function public.challenge_is_open(c public.challenges) returns boolean
  language sql stable set search_path = ''
as $$
  select c.deleted_at is null
    and c.status in ('draft', 'open', 'active')
    and now() < public.challenge_join_closes_at(c.start_date, c.time_zone);
$$;

-- Invites of existing challenges now last to the end of the first day.
update public.invites i
set expires_at = public.challenge_join_closes_at(c.start_date, c.time_zone)
from public.challenges c
where c.id = i.challenge_id;

create or replace function public.check_challenge_fields(
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
  if p_length_days is null or p_length_days not between 1 and 30 then
    raise exception 'a challenge lasts between 1 and 30 days';
  end if;
  if p_misses_allowed is null or p_misses_allowed < 0 or p_misses_allowed >= p_length_days then
    raise exception 'misses allowed must be between 0 and one less than the length';
  end if;
  if p_time_zone is null
    or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_time_zone) then
    raise exception 'unknown time zone %', p_time_zone;
  end if;
  if p_start_date is null or p_start_date < (now() at time zone p_time_zone)::date then
    raise exception 'the start date cannot be in the past';
  end if;
  if p_start_date > (now() at time zone p_time_zone)::date + 90 then
    raise exception 'the start date can be at most 90 days away';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Create, edit, delete
-- ---------------------------------------------------------------------------

create or replace function public.create_challenge(
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
     p_stake, p_misses_allowed, p_time_zone,
     -- A challenge for today starts right away.
     case when public.challenge_starts_at(p_start_date, p_time_zone) <= now() then 'active' else 'open' end)
  returning id into challenge;

  for attempt in 1..5 loop
    begin
      insert into public.invites (challenge_id, code, created_by, expires_at)
      values (challenge, public.invite_code(), me, public.challenge_join_closes_at(p_start_date, p_time_zone));
      exit;
    exception when unique_violation then
      if attempt = 5 then raise; end if;
    end;
  end loop;

  perform public.join_challenge(challenge, p_time_zone);
  return challenge;
end;
$$;

create or replace function public.update_challenge(
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
  if not public.challenge_is_open(c) then
    raise exception 'a challenge cannot change after its first day';
  end if;
  if c.status = 'active' and p_start_date is distinct from c.start_date then
    raise exception 'the start date cannot change once the challenge has started';
  end if;
  perform public.check_challenge_fields(
    p_title, p_rule, p_times_per_week, p_start_date, p_length_days, p_misses_allowed, c.time_zone);

  update public.challenges
  set title = trim(p_title), rule = trim(coalesce(p_rule, '')), times_per_week = p_times_per_week,
    start_date = p_start_date, length_days = p_length_days, misses_allowed = p_misses_allowed,
    -- Moving the start to today starts the challenge right away.
    status = case
      when status = 'open' and public.challenge_starts_at(p_start_date, c.time_zone) <= now() then 'active'
      else status
    end
  where id = c.id;
  update public.invites
  set expires_at = public.challenge_join_closes_at(p_start_date, c.time_zone)
  where challenge_id = c.id;
end;
$$;

create or replace function public.delete_challenge(p_id uuid) returns void
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
  if not public.challenge_is_open(c) then
    raise exception 'a challenge cannot be deleted after its first day';
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
-- Invite lookup, joining and leaving: open during the first day
-- ---------------------------------------------------------------------------

create or replace function public.invite_preview(p_code text) returns jsonb
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
    when c.status not in ('open', 'active') or not public.challenge_is_open(c) or now() >= i.expires_at
      then 'joining closed at the end of the first day'
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
    'join_closes_at', public.challenge_join_closes_at(c.start_date, c.time_zone),
    'already_member', already_member,
    'can_join', blocker is null,
    'blocker', blocker
  );
end;
$$;

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
  if not found or c.status not in ('open', 'active') or not public.challenge_is_open(c) then
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
  if not found or not public.challenge_is_open(c) then
    raise exception 'you can only leave before the end of the first day';
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
-- Automatic start at midnight
-- ---------------------------------------------------------------------------

-- Marks every challenge whose start date has arrived (creator's time zone)
-- as active. Returns how many it started. A scheduled job runs it every
-- minute; it can also be called by hand from the server.
create function public.start_due_challenges() returns integer
  language plpgsql security definer set search_path = ''
as $$
declare
  n integer;
begin
  update public.challenges
  set status = 'active'
  where status = 'open' and deleted_at is null
    and public.challenge_starts_at(start_date, time_zone) <= now();
  get diagnostics n = row_count;
  return n;
end;
$$;

grant execute on function public.start_due_challenges() to service_role;

-- Supabase has the pg_cron scheduler; the local test database does not.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('start-due-challenges', '* * * * *', 'select public.start_due_challenges()');
  end if;
end;
$$;
