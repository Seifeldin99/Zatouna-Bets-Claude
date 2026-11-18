-- Grace period after midnight (owner's decision, 2026-11-18).
--
-- A member who has not completed a day by their midnight gets a little
-- longer, the grace period (one hour, a server setting), to still complete
-- it. During that hour a check-in counts for the day before, as long as that
-- day still needs one; the day counts as missed only once the grace period is
-- over. On the last day the challenge waits for a member who is still in their
-- grace period, and only for them: when everyone's last day is already done,
-- the payout still runs at midnight. The referee call for a last-day photo
-- closes one hour after the member's day ends, grace period included.

-- ---------------------------------------------------------------------------
-- 1. The setting
-- ---------------------------------------------------------------------------
alter table public.app_settings
  -- How long after midnight a member can still complete the day before.
  add column grace_minutes integer not null default 60
    check (grace_minutes >= 0 and grace_minutes < 1440);

create function public.grace_period() returns interval
  language sql stable set search_path = ''
as $$
  select make_interval(mins => (select grace_minutes from public.app_settings));
$$;

-- ---------------------------------------------------------------------------
-- 2. Which day a check-in counts for
-- ---------------------------------------------------------------------------
-- The calendar day at a moment, in the member's own time zone.
create function public.member_day_at(m public.challenge_members, p_at timestamptz) returns date
  language sql stable set search_path = ''
as $$
  select (p_at at time zone m.time_zone)::date;
$$;

-- The day before p_at's day, when p_at is still inside that day's grace
-- period and the day still needs a check-in: it is one of the challenge's
-- days, it is not done, and its week is still short of the required count (a
-- daily challenge needs every day). Null otherwise.
create function public.member_grace_day(m public.challenge_members, c public.challenges, p_at timestamptz) returns date
  language plpgsql stable set search_path = ''
as $$
declare
  grace constant interval := public.grace_period();
  d constant date := public.member_day_at(m, p_at);
  prev constant date := d - 1;
  last_day constant date := c.start_date + (c.length_days - 1);
  week_start date;
  week_end date;
  done integer;
begin
  if grace <= interval '0' then
    return null;
  end if;
  if p_at >= public.challenge_starts_at(d, m.time_zone) + grace then
    return null;
  end if;
  if prev < c.start_date or prev > last_day then
    return null;
  end if;
  if exists (
    select 1 from public.check_ins where member_id = m.id and day = prev and state = 'accepted'
  ) then
    return null;
  end if;
  week_start := c.start_date + ((prev - c.start_date) / 7) * 7;
  week_end := least(week_start + 6, last_day);
  select count(distinct day) into done
  from public.check_ins
  where member_id = m.id and state = 'accepted' and day between week_start and week_end;
  if done >= public.week_required(c.times_per_week, week_end - week_start + 1) then
    return null;
  end if;
  return prev;
end;
$$;

-- The day a check-in made at p_at counts for: the day before while its grace
-- period runs and it still needs one, otherwise the calendar day.
create function public.member_check_in_day(m public.challenge_members, c public.challenges, p_at timestamptz) returns date
  language sql stable set search_path = ''
as $$
  select coalesce(public.member_grace_day(m, c, p_at), public.member_day_at(m, p_at));
$$;

-- ---------------------------------------------------------------------------
-- 3. A check-in goes to the day it counts for
-- ---------------------------------------------------------------------------
create or replace function public.begin_check_in(p_challenge_id uuid, p_note text) returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  me constant uuid := (select auth.uid());
  c public.challenges;
  m public.challenge_members;
  today date;
  last_day date;
  n integer;
  stale record;
  new_id uuid;
  path text;
begin
  if me is null then
    raise exception 'sign in first' using errcode = 'insufficient_privilege';
  end if;
  -- Lock the membership: one attempt at a time per member.
  select * into m from public.challenge_members
  where challenge_id = p_challenge_id and user_id = me for update;
  if not found then
    raise exception 'you are not in this challenge';
  end if;
  select * into c from public.challenges where id = p_challenge_id;
  if c.deleted_at is not null or c.status <> 'active' then
    raise exception 'this challenge is not running';
  end if;
  -- During the grace period this is the day before, when it still needs one.
  today := public.member_check_in_day(m, c, now());
  last_day := c.start_date + (c.length_days - 1);
  if today < c.start_date then
    raise exception 'this challenge has not started yet';
  end if;
  if today > last_day then
    raise exception 'this challenge has ended';
  end if;
  if m.result <> 'in_progress' then
    raise exception 'you are no longer in this challenge';
  end if;
  if public.member_misses(m, c, today) > c.misses_allowed then
    raise exception 'you missed too many days, so your stake is lost';
  end if;
  if length(coalesce(p_note, '')) > 280 then
    raise exception 'the note can be 280 characters at most';
  end if;

  for stale in
    select id from public.check_ins
    where member_id = m.id and state = 'pending' and created_at <= now() - interval '3 minutes'
  loop
    perform public.expire_check_in(stale.id);
  end loop;

  if exists (select 1 from public.check_ins where member_id = m.id and day = today and state = 'accepted') then
    raise exception 'today is already done';
  end if;
  if exists (select 1 from public.check_ins where member_id = m.id and day = today and state = 'pending') then
    raise exception 'your last photo is still being checked';
  end if;

  select coalesce(max(attempt), 0) + 1 into n from public.check_ins where member_id = m.id and day = today;
  new_id := gen_random_uuid();
  path := c.id || '/' || me || '/' || new_id || '.jpg';
  insert into public.check_ins (id, challenge_id, member_id, user_id, day, attempt, note, photo_path)
  values (new_id, c.id, m.id, me, today, n, trim(coalesce(p_note, '')), path);

  return jsonb_build_object('id', new_id, 'photo_path', path, 'day', today, 'attempt', n);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Progress is judged by the day a check-in would count for
-- ---------------------------------------------------------------------------
-- "today" is the day a check-in now would count for, so during the grace
-- period the day before still reads as open (not missed) and the new calendar
-- day as ahead. The app also gets when that day ends and when its grace
-- period ends, for the countdown.
create or replace function public.challenge_progress(p_challenge_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare
  me constant uuid := (select auth.uid());
  c public.challenges;
  m public.challenge_members;
  last_day date;
  members jsonb := '[]'::jsonb;
  days jsonb;
  d date;
  today date;
  day_ends_at timestamptz;
  mine boolean;
  r record;
  status text;
  done_days integer;
  misses integer;
begin
  select * into c from public.challenges where id = p_challenge_id and deleted_at is null;
  if not found or not exists (
    select 1 from public.challenge_members where challenge_id = c.id and user_id = me
  ) then
    raise exception 'you are not in this challenge';
  end if;
  last_day := c.start_date + (c.length_days - 1);

  for m in select * from public.challenge_members where challenge_id = c.id order by joined_at loop
    mine := m.user_id = me;
    today := public.member_check_in_day(m, c, now());
    day_ends_at := public.challenge_starts_at(today + 1, m.time_zone);
    days := '[]'::jsonb;
    done_days := 0;
    d := c.start_date;
    while d <= last_day loop
      select
        bool_or(state = 'accepted') as done,
        bool_or(state = 'pending' and created_at > now() - interval '3 minutes') as checking,
        bool_or(state = 'rejected') as rejected,
        exists (
          select 1 from public.referee_cases rc where rc.member_id = m.id and rc.day = d and rc.decision = 'open'
        ) as referee
      into r
      from public.check_ins where member_id = m.id and day = d;
      status := case
        when coalesce(r.done, false) then 'done'
        when d > today then 'future'
        when coalesce(r.referee, false) and (mine or d < today) then 'referee'
        when d < today then 'none'
        when mine and coalesce(r.checking, false) then 'checking'
        when mine and coalesce(r.rejected, false) then 'rejected'
        else 'open'
      end;
      if status = 'done' then done_days := done_days + 1; end if;
      days := days || jsonb_build_object('day', d, 'status', status);
      d := d + 1;
    end loop;
    misses := public.member_misses(m, c, today);
    members := members || jsonb_build_object(
      'member_id', m.id,
      'user_id', m.user_id,
      'mine', mine,
      'result', m.result,
      'today', today,
      'in_grace', today < public.member_day_at(m, now()),
      'day_ends_at', day_ends_at,
      'grace_ends_at', day_ends_at + public.grace_period(),
      'days_done', done_days,
      'misses', misses,
      'misses_left', c.misses_allowed - misses,
      'out', m.result = 'forfeited' or misses > c.misses_allowed,
      'can_check_in', mine and m.result = 'in_progress' and c.status = 'active'
        and misses <= c.misses_allowed and today between c.start_date and last_day
        and not exists (
          select 1 from public.check_ins where member_id = m.id and day = today and state = 'accepted'
        ),
      'week', public.member_week(m, c, today),
      'days', days);
  end loop;
  return jsonb_build_object('challenge_id', c.id, 'members', members);
end;
$$;

create or replace function public.my_today() returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare
  me constant uuid := (select auth.uid());
  m public.challenge_members;
  c public.challenges;
  today date;
  day_ends_at timestamptz;
  misses integer;
  standing text;
  items jsonb := '[]'::jsonb;
begin
  for m in select * from public.challenge_members where user_id = me loop
    select * into c from public.challenges where id = m.challenge_id and deleted_at is null and status = 'active';
    if not found then continue; end if;
    today := public.member_check_in_day(m, c, now());
    day_ends_at := public.challenge_starts_at(today + 1, m.time_zone);
    misses := public.member_misses(m, c, today);
    standing := case
      when m.result = 'forfeited' or misses > c.misses_allowed then 'out'
      when today < c.start_date then 'not_started'
      when today > c.start_date + (c.length_days - 1) then 'ended'
      when exists (select 1 from public.check_ins where member_id = m.id and day = today and state = 'accepted') then 'done'
      when exists (select 1 from public.check_ins where member_id = m.id and day = today and state = 'pending'
                   and created_at > now() - interval '3 minutes') then 'checking'
      when exists (select 1 from public.referee_cases where member_id = m.id and day = today and decision = 'open') then 'referee'
      when exists (select 1 from public.check_ins where member_id = m.id and day = today and state = 'rejected') then 'rejected'
      else 'open'
    end;
    items := items || jsonb_build_object(
      'challenge_id', c.id, 'status', standing, 'misses_left', c.misses_allowed - misses,
      'today', today,
      'in_grace', today < public.member_day_at(m, now()),
      'day_ends_at', day_ends_at,
      'grace_ends_at', day_ends_at + public.grace_period(),
      'week', public.member_week(m, c, today));
  end loop;
  return items;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The last day ends after the grace period, but only for a member who
--    still needs it
-- ---------------------------------------------------------------------------
-- A member's challenge ends at the midnight after their last day. When that
-- day is not done by then, and they could still complete it (they have not
-- quit, they are not out, and the day still counts for something), it ends
-- after their grace period instead. Once the day is done, it ends at midnight
-- again, so the payout does not wait a minute longer than it has to. Whether
-- the member finished or forfeited at settlement changes nothing here, so the
-- results keep showing when their day really ended.
create or replace function public.member_ends_at(m public.challenge_members, c public.challenges) returns timestamptz
  language sql stable set search_path = ''
as $$
  select public.challenge_starts_at(c.start_date + c.length_days, m.time_zone)
    + case
        when m.quit_at is null
          and public.member_grace_day(m, c, public.challenge_starts_at(c.start_date + c.length_days, m.time_zone)) is not null
          and public.member_misses(m, c, c.start_date + (c.length_days - 1)) <= c.misses_allowed
        then public.grace_period()
        else interval '0'
      end;
$$;

-- The challenge ends when the last member's challenge has ended.
create or replace function public.challenge_ends_at(c public.challenges) returns timestamptz
  language sql stable set search_path = ''
as $$
  select coalesce(
    (select max(public.member_ends_at(m, c)) from public.challenge_members m where m.challenge_id = c.id),
    public.challenge_starts_at(c.start_date + c.length_days, c.time_zone));
$$;

-- ---------------------------------------------------------------------------
-- 6. The results tell each member when their own day ended and until when
--    they could call the referee
-- ---------------------------------------------------------------------------
create or replace function public.challenge_results(p_challenge_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare
  me constant uuid := (select auth.uid());
  c public.challenges;
  s public.app_settings;
  settlement uuid;
  members jsonb;
  member_count integer;
  finisher_count integer;
  forfeited bigint;
  fee bigint;
  app_total bigint;
  my_payout bigint;
begin
  select * into c from public.challenges where id = p_challenge_id and deleted_at is null;
  if not found or not exists (
    select 1 from public.challenge_members where challenge_id = c.id and user_id = me
  ) then
    raise exception 'you are not in this challenge';
  end if;
  select * into s from public.app_settings;
  select id into settlement from public.ledger_transactions where idempotency_key = 'settle:' || c.id;

  select count(*), count(*) filter (where result = 'finished')
  into member_count, finisher_count
  from public.challenge_members where challenge_id = c.id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'member_id', m.id,
      'user_id', m.user_id,
      'name', p.display_name,
      'mine', m.user_id = me,
      'result', m.result,
      'quit', m.quit_at is not null,
      'ends_at', public.member_ends_at(m, c),
      'calls_close_at', public.member_ends_at(m, c) + make_interval(hours => s.referee_call_hours_after_end),
      'payout', pay.amount)
    order by m.result = 'finished' desc, pay.amount desc nulls last, m.joined_at), '[]'::jsonb)
  into members
  from public.challenge_members m
  join public.profiles p on p.id = m.user_id
  left join lateral (
    select e.amount from public.ledger_entries e
    join public.ledger_accounts a on a.id = e.account_id
    where e.transaction_id = settlement and a.kind = 'wallet' and a.user_id = m.user_id
    limit 1
  ) pay on true
  where m.challenge_id = c.id;

  if c.status = 'settled' then
    forfeited := c.stake::bigint * (member_count - finisher_count);
    fee := case when finisher_count = 0 then forfeited else forfeited * c.app_fee_percent / 100 end;
    select coalesce(sum(e.amount), 0) into app_total
    from public.ledger_entries e join public.ledger_accounts a on a.id = e.account_id
    where e.transaction_id = settlement and a.kind = 'app_revenue';
    select e.amount into my_payout
    from public.ledger_entries e join public.ledger_accounts a on a.id = e.account_id
    where e.transaction_id = settlement and a.kind = 'wallet' and a.user_id = me;
  end if;

  return jsonb_build_object(
    'challenge_id', c.id,
    'status', c.status,
    'stake', c.stake,
    'fee_percent', c.app_fee_percent,
    'pool', c.stake::bigint * member_count,
    'ends_at', public.challenge_ends_at(c),
    'calls_close_at', public.challenge_ends_at(c) + make_interval(hours => s.referee_call_hours_after_end),
    'pays_out_by', public.challenge_finalizes_at(c),
    'settled_at', c.settled_at,
    'open_cases', (select count(*) from public.referee_cases where challenge_id = c.id and decision = 'open'),
    'waiting_for', case when c.status = 'settled' then null else public.challenge_waiting_for(c) end,
    'forfeited', forfeited,
    'app_fee', fee,
    'leftover', case when app_total is null then null else app_total - fee end,
    'my_result', (select result from public.challenge_members where challenge_id = c.id and user_id = me),
    'my_payout', case when c.status = 'settled' then coalesce(my_payout, 0) end,
    'members', members);
end;
$$;

-- grace_period, member_day_at, member_grace_day and member_check_in_day stay
-- closed to the app: only the functions above call them. begin_check_in,
-- challenge_progress, my_today and challenge_results keep their grants.
