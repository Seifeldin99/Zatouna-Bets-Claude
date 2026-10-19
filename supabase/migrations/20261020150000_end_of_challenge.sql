-- End of a challenge (product stories 8.1 to 8.5, 7.3 and 1.3; owner's
-- decisions of 2026-10-19): when a challenge ends, who finished, when the pool
-- is paid out, the results, and each user's token history.
--
-- Timing (owner's rules): the referee can be called within 24 hours of a
-- verdict, but at the end of the challenge only until 1 hour after the
-- member's last midnight. A case counts as accepted 48 hours after it was
-- sent, or 6 hours after the challenge ends, whichever comes first. The payout
-- runs as soon as nothing can change the result (1 hour after the end with no
-- case open, or when the last case is decided) and at the latest 6 hours
-- after the end. The three numbers are server settings.
--
-- The app fee is a server setting too, copied into each challenge when it is
-- created: 0% during testing (owner's decision), 10% later.

-- ---------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------
alter table public.app_settings
  -- Share of the forfeited stakes the app keeps, for challenges created from now on.
  add column app_fee_percent integer not null default 10 check (app_fee_percent between 0 and 100),
  -- After a member's last midnight, how long they can still call the referee.
  add column referee_call_hours_after_end integer not null default 1 check (referee_call_hours_after_end >= 0),
  -- After the challenge ends, when open cases count as accepted and the pool is paid out.
  add column finalize_hours_after_end integer not null default 6 check (finalize_hours_after_end >= 0),
  -- How long a case waits for support before it counts as accepted.
  add column referee_case_hours integer not null default 48 check (referee_case_hours >= 1),
  add constraint app_settings_finalize_after_calls check (finalize_hours_after_end >= referee_call_hours_after_end);

-- Testing: no fee (owner's decision, 2026-10-19). Set to 10 before real money.
update public.app_settings set app_fee_percent = 0, updated_at = now();

-- ---------------------------------------------------------------------------
-- 2. New columns
-- ---------------------------------------------------------------------------
alter table public.challenges add column settled_at timestamptz;
alter table public.challenge_members add column quit_at timestamptz;
-- When a case that support has not decided counts as accepted.
alter table public.referee_cases add column expires_at timestamptz;

-- ---------------------------------------------------------------------------
-- 3. When things end
-- ---------------------------------------------------------------------------

-- Midnight at the end of this member's last day, in their own time zone.
create function public.member_ends_at(m public.challenge_members, c public.challenges) returns timestamptz
  language sql stable set search_path = ''
as $$
  select public.challenge_starts_at(c.start_date + c.length_days, m.time_zone);
$$;

-- When the challenge ends: the last member's last midnight (the member
-- furthest west). Falls back to the creator's time zone.
create function public.challenge_ends_at(c public.challenges) returns timestamptz
  language sql stable set search_path = ''
as $$
  select coalesce(
    (select max(public.challenge_starts_at(c.start_date + c.length_days, m.time_zone))
     from public.challenge_members m where m.challenge_id = c.id),
    public.challenge_starts_at(c.start_date + c.length_days, c.time_zone));
$$;

-- When the pool is paid out at the latest, and open cases count as accepted.
create function public.challenge_finalizes_at(c public.challenges) returns timestamptz
  language sql stable set search_path = ''
as $$
  select public.challenge_ends_at(c)
    + make_interval(hours => (select finalize_hours_after_end from public.app_settings));
$$;

-- Existing cases get the new limit; decided ones keep it for the record.
alter table public.referee_cases disable trigger referee_cases_guard;
update public.referee_cases r
set expires_at = least(
  r.created_at + make_interval(hours => (select referee_case_hours from public.app_settings)),
  public.challenge_finalizes_at(c))
from public.challenges c
where c.id = r.challenge_id and r.expires_at is null;
alter table public.referee_cases enable trigger referee_cases_guard;
alter table public.referee_cases alter column expires_at set not null;

-- A case never changes except for its decision, and a decision is final.
create or replace function public.referee_cases_guard() returns trigger
  language plpgsql set search_path = ''
as $$
begin
  if new.check_in_id <> old.check_in_id or new.challenge_id <> old.challenge_id
    or new.member_id <> old.member_id or new.user_id <> old.user_id or new.day <> old.day
    or new.explanation <> old.explanation or new.created_at <> old.created_at
    or new.expires_at <> old.expires_at then
    raise exception 'a referee case cannot be changed';
  end if;
  if old.decision <> 'open' then
    raise exception 'a referee decision is final';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. New challenges copy the fee setting
-- ---------------------------------------------------------------------------
create or replace function public.create_challenge(
  p_template text, p_times_per_week integer, p_start_date date,
  p_length_days integer, p_stake integer, p_misses_allowed integer, p_time_zone text
) returns uuid
  language plpgsql security definer set search_path = ''
as $$
declare
  me constant uuid := (select auth.uid());
  t public.challenge_templates;
  challenge uuid;
begin
  if me is null then
    raise exception 'sign in first' using errcode = 'insufficient_privilege';
  end if;
  select * into t from public.challenge_templates where key = p_template;
  if not found then
    raise exception 'pick one of the challenge templates';
  end if;
  perform public.check_challenge_fields(
    p_times_per_week, p_start_date, p_length_days, p_misses_allowed, p_time_zone);
  if p_stake is null or p_stake < 1 then
    raise exception 'the stake must be at least 1 token';
  end if;

  insert into public.challenges
    (creator_id, template, title, rule, times_per_week, start_date, length_days, stake, misses_allowed,
     time_zone, app_fee_percent, status)
  values
    (me, t.key, t.title, t.rule, p_times_per_week, p_start_date, p_length_days, p_stake, p_misses_allowed,
     p_time_zone,
     (select app_fee_percent from public.app_settings),
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

-- ---------------------------------------------------------------------------
-- 5. Quitting is remembered, so the results can say so
-- ---------------------------------------------------------------------------
create or replace function public.quit_challenge(p_challenge_id uuid) returns void
  language plpgsql security definer set search_path = ''
as $$
declare
  me constant uuid := (select auth.uid());
  c public.challenges;
begin
  if me is null then
    raise exception 'sign in first' using errcode = 'insufficient_privilege';
  end if;
  select * into c from public.challenges where id = p_challenge_id for update;
  if not found or c.status <> 'active' then
    raise exception 'you can only quit a challenge that is running';
  end if;
  update public.challenge_members
  set result = 'forfeited', quit_at = now()
  where challenge_id = c.id and user_id = me and result = 'in_progress';
  if not found then
    raise exception 'you are not in this challenge, or your result is already decided';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Calling the referee: the last-day cut-off, and when a case expires
-- ---------------------------------------------------------------------------
create or replace function public.open_referee_case(p_check_in_id uuid, p_explanation text) returns uuid
  language plpgsql security definer set search_path = ''
as $$
declare
  me constant uuid := (select auth.uid());
  ci public.check_ins;
  c public.challenges;
  m public.challenge_members;
  s public.app_settings;
  v_explanation constant text := trim(coalesce(p_explanation, ''));
  closes_at timestamptz;
  new_id uuid;
begin
  if me is null then
    raise exception 'sign in first' using errcode = 'insufficient_privilege';
  end if;
  select * into ci from public.check_ins where id = p_check_in_id and user_id = me for update;
  if not found then
    raise exception 'unknown check-in';
  end if;
  select * into c from public.challenges where id = ci.challenge_id;
  if c.deleted_at is not null then
    raise exception 'this challenge is gone';
  end if;
  if c.status = 'settled' then
    raise exception 'this challenge is already paid out';
  end if;
  if ci.state <> 'rejected' then
    raise exception 'only a rejected check-in can go to the referee';
  end if;
  if ci.decided_at < now() - interval '24 hours' then
    raise exception 'the referee can be called within 24 hours of the verdict';
  end if;
  select * into m from public.challenge_members where id = ci.member_id;
  select * into s from public.app_settings;
  -- At the end of the challenge the call closes soon after the member's last
  -- midnight, so the payout is not held up (owner's rule, 2026-10-19).
  closes_at := public.member_ends_at(m, c) + make_interval(hours => s.referee_call_hours_after_end);
  if now() >= closes_at then
    raise exception 'the referee could be called until % after your last midnight',
      case when s.referee_call_hours_after_end = 1 then '1 hour' else s.referee_call_hours_after_end || ' hours' end;
  end if;
  if exists (select 1 from public.referee_cases where check_in_id = ci.id) then
    raise exception 'the referee was already called for this check-in';
  end if;
  if exists (
    select 1 from public.check_ins where member_id = ci.member_id and day = ci.day and state = 'accepted'
  ) then
    raise exception 'that day is already done';
  end if;
  if exists (
    select 1 from public.referee_cases where member_id = ci.member_id and day = ci.day and decision = 'open'
  ) then
    raise exception 'a referee case for that day is already waiting';
  end if;
  if length(v_explanation) = 0 then
    raise exception 'write a short explanation for the referee';
  end if;
  if length(v_explanation) > 500 then
    raise exception 'the explanation can be 500 characters at most';
  end if;
  insert into public.referee_cases (check_in_id, challenge_id, member_id, user_id, day, explanation, expires_at)
  values (ci.id, ci.challenge_id, ci.member_id, me, ci.day, v_explanation,
    least(now() + make_interval(hours => s.referee_case_hours), public.challenge_finalizes_at(c)))
  returning id into new_id;
  return new_id;
end;
$$;

-- Accepts one open case by rule (nobody decided it in time). Server only.
create function public.accept_referee_case_by_rule(p_case_id uuid, p_reason text) returns void
  language plpgsql security definer set search_path = ''
as $$
declare
  rc public.referee_cases;
begin
  select * into rc from public.referee_cases where id = p_case_id and decision = 'open' for update;
  if not found then return; end if;
  update public.referee_cases
  set decision = 'accepted', reason = p_reason, decided_at = now()
  where id = rc.id;
  perform set_config('zatouna.referee', 'on', true);
  update public.check_ins set state = 'accepted' where id = rc.check_in_id and state = 'rejected';
  perform set_config('zatouna.referee', 'off', true);
end;
$$;

-- Every open case past its time limit counts as accepted (ties go to the member).
create or replace function public.accept_stale_referee_cases() returns integer
  language plpgsql security definer set search_path = ''
as $$
declare
  rc record;
  n integer := 0;
begin
  for rc in
    select id from public.referee_cases
    where decision = 'open' and expires_at <= now()
    order by expires_at, created_at
  loop
    perform public.accept_referee_case_by_rule(rc.id, 'Not decided before the time limit, so it counts as accepted.');
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- The queue: open cases first, the one that expires soonest on top; then
-- decided cases, newest first. Each row says when it counts as accepted.
create or replace function public.referee_queue(p_case_id uuid default null) returns jsonb
  language sql stable security definer set search_path = ''
as $$
  select case when public.is_support() then coalesce(jsonb_agg(row order by
      decision <> 'open',
      case when decision = 'open' then expires_at end,
      created_at desc), '[]'::jsonb) end
  from (
    select rc.decision, rc.expires_at, rc.created_at, jsonb_build_object(
      'id', rc.id,
      'check_in_id', ci.id,
      'challenge_id', c.id,
      'challenge_title', c.title,
      'challenge_status', c.status,
      'rule', c.rule,
      'member_name', p.display_name,
      'day', rc.day,
      'attempt', ci.attempt,
      'note', ci.note,
      'photo_path', ci.photo_path,
      'ai_label', a.label,
      'ai_reason', a.reason,
      'explanation', rc.explanation,
      'decision', rc.decision,
      'reason', rc.reason,
      'created_at', rc.created_at,
      'expires_at', rc.expires_at,
      'decided_at', rc.decided_at) as row
    from public.referee_cases rc
    join public.check_ins ci on ci.id = rc.check_in_id
    join public.challenges c on c.id = rc.challenge_id
    join public.profiles p on p.id = rc.user_id
    left join public.ai_checks a on a.check_in_id = ci.id
    where p_case_id is null or rc.id = p_case_id
  ) cases;
$$;

-- ---------------------------------------------------------------------------
-- 7. Ending: active -> refereeing once every member's last day is over
-- ---------------------------------------------------------------------------
create function public.end_due_challenges() returns integer
  language plpgsql security definer set search_path = ''
as $$
declare
  n integer;
begin
  update public.challenges c
  set status = 'refereeing'
  where c.status = 'active' and c.deleted_at is null
    and public.challenge_ends_at(c) <= now();
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Settlement decides who finished, closes open cases, and pays out
-- ---------------------------------------------------------------------------
-- Settlement (PRODUCT.md 8, ARCHITECTURE.md rules 5 to 7). Runs on the server
-- only, from refereeing. Any case still open counts as accepted (story 7.3);
-- then every member still in progress is finished or forfeited by their
-- misses, and the pool is paid out. Running it again changes nothing.
create or replace function public.settle_challenge(p_challenge_id uuid) returns text
  language plpgsql security definer set search_path = ''
as $$
declare
  c public.challenges;
  m public.challenge_members;
  rc record;
  after_last date;
  pool uuid;
  pool_balance bigint;
  member_count integer;
  finisher_count integer;
  forfeited bigint;
  fee bigint;
  share bigint;
  revenue bigint;
  tx uuid;
  f record;
begin
  -- Rule 6: lock the challenge so only one settlement runs at a time.
  select * into c from public.challenges where id = p_challenge_id for update;
  if not found then
    raise exception 'no such challenge';
  end if;
  if c.status = 'settled' then
    return 'already settled';
  end if;
  if c.status <> 'refereeing' then
    raise exception 'challenge is %, it can only be settled from refereeing', c.status;
  end if;

  -- Story 7.3: ties go to the member.
  for rc in select id from public.referee_cases where challenge_id = c.id and decision = 'open' loop
    perform public.accept_referee_case_by_rule(rc.id, 'Not decided before the payout, so it counts as accepted.');
  end loop;

  -- Every day is over, so the misses are final: more than allowed forfeits.
  after_last := c.start_date + c.length_days;
  for m in select * from public.challenge_members where challenge_id = c.id and result = 'in_progress' loop
    update public.challenge_members
    set result = case when public.member_misses(m, c, after_last) > c.misses_allowed then 'forfeited' else 'finished' end
    where id = m.id;
  end loop;

  select count(*), count(*) filter (where result = 'finished')
  into member_count, finisher_count
  from public.challenge_members where challenge_id = c.id;

  pool := public.ledger_pool(c.id);
  select coalesce(sum(amount), 0) into pool_balance from public.ledger_entries where account_id = pool;
  if pool_balance <> c.stake::bigint * member_count then
    raise exception 'pool holds % but % members staked % each', pool_balance, member_count, c.stake;
  end if;

  update public.challenges set status = 'settled', settled_at = now() where id = c.id;
  if pool_balance = 0 then
    return 'settled (empty pool)';
  end if;

  -- Rule 5: a second settlement with the same key writes nothing.
  tx := public.ledger_begin('settlement', 'settle:' || c.id, c.id, 'Settlement: ' || c.title, null);
  if tx is null then
    raise exception 'settlement for % was already written', c.id;
  end if;

  forfeited := c.stake::bigint * (member_count - finisher_count);
  if finisher_count = 0 then
    share := 0;
  else
    fee := forfeited * c.app_fee_percent / 100;              -- rounded down
    share := (forfeited - fee) / finisher_count;             -- rounded down
  end if;
  revenue := pool_balance - (c.stake + share) * finisher_count; -- fee plus leftovers

  perform public.ledger_post(tx, pool, -pool_balance);
  if revenue > 0 then
    perform public.ledger_post(tx, public.ledger_system_account('app_revenue'), revenue);
  end if;
  for f in
    select user_id from public.challenge_members where challenge_id = c.id and result = 'finished'
  loop
    perform public.ledger_post(tx, public.ledger_wallet(f.user_id), c.stake + share);
  end loop;

  -- Rule 7: the pool must end at exactly zero.
  if (select coalesce(sum(amount), 0) from public.ledger_entries where account_id = pool) <> 0 then
    raise exception 'pool for % did not end at zero', c.id;
  end if;
  return 'settled';
end;
$$;

-- True once nothing can change the result: the referee can no longer be
-- called and no case is open, or the time limit after the end has passed.
create function public.challenge_ready_to_settle(c public.challenges) returns boolean
  language sql stable set search_path = ''
as $$
  select c.status = 'refereeing' and (
    now() >= public.challenge_finalizes_at(c)
    or (
      now() >= public.challenge_ends_at(c)
        + make_interval(hours => (select referee_call_hours_after_end from public.app_settings))
      and not exists (
        select 1 from public.referee_cases r where r.challenge_id = c.id and r.decision = 'open')));
$$;

-- The minute job: end challenges whose last day is over, accept cases past
-- their limit, and pay out every challenge where nothing can change. One
-- challenge that fails to settle is logged and does not block the others.
create function public.finish_due_challenges() returns jsonb
  language plpgsql security definer set search_path = ''
as $$
declare
  c public.challenges;
  ended integer;
  accepted integer;
  settled integer := 0;
  failed integer := 0;
begin
  ended := public.end_due_challenges();
  accepted := public.accept_stale_referee_cases();
  for c in
    select * from public.challenges where status = 'refereeing' and deleted_at is null order by created_at
  loop
    if public.challenge_ready_to_settle(c) then
      begin
        perform public.settle_challenge(c.id);
        settled := settled + 1;
      exception when others then
        failed := failed + 1;
        raise warning 'settlement of challenge % failed: %', c.id, sqlerrm;
      end;
    end if;
  end loop;
  return jsonb_build_object('ended', ended, 'cases_accepted', accepted, 'settled', settled, 'failed', failed);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. The results, for members
-- ---------------------------------------------------------------------------
-- Who finished, who forfeited (and whether they quit), what the pool held,
-- what the app kept, and what each member received. Payouts are null until
-- the challenge is settled.
create function public.challenge_results(p_challenge_id uuid) returns jsonb
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
    'forfeited', forfeited,
    'app_fee', fee,
    'leftover', case when app_total is null then null else app_total - fee end,
    'my_result', (select result from public.challenge_members where challenge_id = c.id and user_id = me),
    'my_payout', case when c.status = 'settled' then coalesce(my_payout, 0) end,
    'members', members);
end;
$$;

-- Your result in every settled challenge: for the Bets list and the Won count.
create function public.my_outcomes() returns jsonb
  language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'challenge_id', c.id,
      'result', m.result,
      'quit', m.quit_at is not null,
      'payout', coalesce(pay.amount, 0),
      'net', coalesce(pay.amount, 0) - c.stake,
      'settled_at', c.settled_at)
    order by c.settled_at desc), '[]'::jsonb)
  from public.challenge_members m
  join public.challenges c on c.id = m.challenge_id
  left join public.ledger_transactions t on t.idempotency_key = 'settle:' || c.id
  left join lateral (
    select e.amount from public.ledger_entries e
    join public.ledger_accounts a on a.id = e.account_id
    where e.transaction_id = t.id and a.kind = 'wallet' and a.user_id = m.user_id
    limit 1
  ) pay on true
  where m.user_id = (select auth.uid()) and c.status = 'settled';
$$;

-- ---------------------------------------------------------------------------
-- 10. Token history (story 1.3): every change to your wallet, newest first
-- ---------------------------------------------------------------------------
create function public.my_token_history(p_limit integer default 200) returns jsonb
  language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(line), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', e.id,
      'at', e.created_at,
      'amount', e.amount,
      'kind', t.kind,
      'note', t.note,
      'challenge_id', t.challenge_id,
      'challenge_title', c.title) as line
    from public.ledger_entries e
    join public.ledger_accounts a on a.id = e.account_id
    join public.ledger_transactions t on t.id = e.transaction_id
    left join public.challenges c on c.id = t.challenge_id
    where a.kind = 'wallet' and a.user_id = (select auth.uid())
    order by e.created_at desc, e.id desc
    limit greatest(1, least(coalesce(p_limit, 200), 500))
  ) lines;
$$;

-- ---------------------------------------------------------------------------
-- 11. Who may call what
-- ---------------------------------------------------------------------------
grant execute on function public.challenge_results(uuid) to authenticated;
grant execute on function public.my_outcomes() to authenticated;
grant execute on function public.my_token_history(integer) to authenticated;
grant execute on function public.end_due_challenges() to service_role;
grant execute on function public.finish_due_challenges() to service_role;
-- member_ends_at, challenge_ends_at, challenge_finalizes_at,
-- challenge_ready_to_settle and accept_referee_case_by_rule stay closed:
-- only the functions above call them.

-- ---------------------------------------------------------------------------
-- 12. The minute job replaces the hourly sweep
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    if exists (select 1 from cron.job where jobname = 'accept-stale-referee-cases') then
      perform cron.unschedule('accept-stale-referee-cases');
    end if;
    perform cron.schedule('finish-due-challenges', '* * * * *', 'select public.finish_due_challenges()');
  end if;
end;
$$;
