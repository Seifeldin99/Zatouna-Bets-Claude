-- First-day fixes from the code review (owner's picks, 2026-10-20).
--
-- QW1: once a member has checked in, they can no longer leave, and once
-- anyone has checked in, the creator can no longer delete the challenge.
-- Before this, both failed with a database error, because the check-in still
-- pointed at the membership being removed.
-- QW2: a friend can no longer join once their own first day is over in their
-- time zone. Before this, a friend ahead of the creator could join after
-- their own midnight and was counted as having missed day 1 at once.
-- QW7: quitting (which forfeits the stake) starts on the second day, as
-- product story 4.3 says. On the first day a member leaves instead.

-- ---------------------------------------------------------------------------
-- Leaving: closed once you have checked in
-- ---------------------------------------------------------------------------

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
  -- A check-in being saved at this moment holds a lock on the challenge row
  -- (its link to the challenge), so the lock above waits for it and this
  -- check sees it.
  if exists (select 1 from public.check_ins where member_id = m.id) then
    raise exception 'you have already checked in, so you can no longer leave this challenge';
  end if;

  tx := public.ledger_begin('refund', 'refund:' || m.id, c.id, 'Left: ' || c.title, me);
  perform public.ledger_post(tx, public.ledger_pool(c.id), -c.stake);
  perform public.ledger_post(tx, public.ledger_wallet(me), c.stake);
  delete from public.challenge_members where id = m.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Deleting: closed once anyone has checked in
-- ---------------------------------------------------------------------------

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
  -- As in leave_challenge, the lock on the challenge row waits for a
  -- check-in being saved at this moment, so this check sees it.
  if exists (select 1 from public.check_ins where challenge_id = c.id) then
    raise exception 'someone has already checked in, so this challenge can no longer be deleted';
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
-- Joining: closed once your own first day is over
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
  if not found or c.status not in ('open', 'active') or not public.challenge_is_open(c) then
    raise exception 'this challenge is not open for joining';
  end if;
  if p_time_zone is null
    or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_time_zone) then
    raise exception 'unknown time zone %', p_time_zone;
  end if;
  -- Your days run on your own time zone. Past your own midnight at the end of
  -- the start date, day 1 would already count as missed.
  if (now() at time zone p_time_zone)::date > c.start_date then
    raise exception 'your first day of this challenge is already over in your time zone, so you can no longer join';
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

-- ---------------------------------------------------------------------------
-- Quitting: from the second day on
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
  -- The first day is still open (creator's time zone): leaving refunds the
  -- stake, so quitting must not take it.
  if public.challenge_is_open(c) then
    if exists (
      select 1 from public.check_ins ci
      join public.challenge_members m on m.id = ci.member_id
      where m.challenge_id = c.id and m.user_id = me
    ) then
      raise exception 'you can quit from the second day of the challenge';
    end if;
    raise exception 'on the first day you can leave instead, and get your stake back';
  end if;
  update public.challenge_members
  set result = 'forfeited', quit_at = now()
  where challenge_id = c.id and user_id = me and result = 'in_progress';
  if not found then
    raise exception 'you are not in this challenge, or your result is already decided';
  end if;
end;
$$;
