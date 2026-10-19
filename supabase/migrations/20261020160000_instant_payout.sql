-- Instant payout (owner's decision, 2026-10-19): the pool is paid out the
-- moment the challenge ends, unless something can still change the result:
-- a photo still being checked, a rejected photo whose owner can still call
-- the referee (up to 1 hour after their last midnight), or an open referee
-- case (decided by support, or counted as accepted at the time limit). The
-- 6-hour limit after the end still pays out whatever happens.

-- What the payout is waiting for: 'pending' (a photo is being checked),
-- 'calls' (someone can still call the referee on a rejected photo that
-- matters), 'cases' (a referee case is open), or null (nothing: pay out).
create function public.challenge_waiting_for(c public.challenges) returns text
  language sql stable set search_path = ''
as $$
  select case
    when exists (
      select 1 from public.check_ins ci
      where ci.challenge_id = c.id and ci.state = 'pending'
        and ci.created_at > now() - interval '3 minutes') then 'pending'
    when exists (
      select 1 from public.referee_cases r
      where r.challenge_id = c.id and r.decision = 'open') then 'cases'
    when exists (
      select 1 from public.check_ins ci
      join public.challenge_members m on m.id = ci.member_id
      where ci.challenge_id = c.id and ci.state = 'rejected'
        -- Within 24 hours of the verdict and before the member's cut-off.
        and ci.decided_at > now() - interval '24 hours'
        and now() < public.member_ends_at(m, c)
          + make_interval(hours => (select referee_call_hours_after_end from public.app_settings))
        -- Only a day that is not done, with no case yet, can still change.
        and not exists (
          select 1 from public.check_ins done
          where done.member_id = ci.member_id and done.day = ci.day and done.state = 'accepted')
        and not exists (select 1 from public.referee_cases r where r.check_in_id = ci.id)) then 'calls'
  end;
$$;

-- True once nothing can change the result, or the time limit after the end
-- has passed.
create or replace function public.challenge_ready_to_settle(c public.challenges) returns boolean
  language sql stable set search_path = ''
as $$
  select c.status = 'refereeing' and (
    now() >= public.challenge_finalizes_at(c)
    or public.challenge_waiting_for(c) is null);
$$;

-- The results tell the app what the payout waits for.
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
-- challenge_waiting_for stays closed to the app; challenge_results (already
-- granted to authenticated) is the way to read it.
