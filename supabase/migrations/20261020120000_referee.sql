-- The referee: a member whose check-in was rejected asks support to overrule
-- the AI (product stories 7.1 to 7.3). Support (the admin during testing)
-- accepts or rejects each case with a reason; the decision is final.
-- Only server functions write here; the app reads.

-- ---------------------------------------------------------------------------
-- 1. Who counts as support
-- ---------------------------------------------------------------------------
create function public.is_support() returns boolean
  language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles where id = (select auth.uid()) and role in ('support', 'admin')
  );
$$;

-- ---------------------------------------------------------------------------
-- 2. Referee cases
-- ---------------------------------------------------------------------------
create table public.referee_cases (
  id uuid primary key default gen_random_uuid(),
  check_in_id uuid not null unique references public.check_ins (id),
  challenge_id uuid not null references public.challenges (id),
  member_id uuid not null references public.challenge_members (id),
  user_id uuid not null references public.profiles (id),
  day date not null,
  explanation text not null check (length(explanation) between 1 and 500),
  decision text not null default 'open' check (decision in ('open', 'accepted', 'rejected')),
  reason text not null default '' check (length(reason) <= 500),
  -- Null for a case the 48-hour rule decided.
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create index referee_cases_open on public.referee_cases (created_at) where decision = 'open';
create index referee_cases_member_day on public.referee_cases (member_id, day);

-- A case never changes except for its decision, and a decision is final.
create function public.referee_cases_guard() returns trigger
  language plpgsql set search_path = ''
as $$
begin
  if new.check_in_id <> old.check_in_id or new.challenge_id <> old.challenge_id
    or new.member_id <> old.member_id or new.user_id <> old.user_id or new.day <> old.day
    or new.explanation <> old.explanation or new.created_at <> old.created_at then
    raise exception 'a referee case cannot be changed';
  end if;
  if old.decision <> 'open' then
    raise exception 'a referee decision is final';
  end if;
  return new;
end;
$$;

create trigger referee_cases_guard
  before update on public.referee_cases
  for each row execute function public.referee_cases_guard();

alter table public.referee_cases enable row level security;
revoke all on public.referee_cases from anon, authenticated;
grant select on public.referee_cases to authenticated;

create policy "Members read their own referee cases"
  on public.referee_cases for select to authenticated
  using (user_id = (select auth.uid()) or public.is_support());

-- Support sees the photo of a check-in that went to the referee. The check
-- runs with the function's own rights, since support cannot read other
-- members' check-in rows directly.
create function public.is_referee_photo(p_name text) returns boolean
  language sql stable security definer set search_path = ''
as $$
  select public.is_support() and exists (
    select 1 from public.referee_cases rc
    join public.check_ins ci on ci.id = rc.check_in_id
    where ci.photo_path = p_name
  );
$$;

create policy "Support sees photos under referee review"
  on storage.objects for select to authenticated
  using (bucket_id = 'check-ins' and public.is_referee_photo(name));

-- ---------------------------------------------------------------------------
-- 3. The one exception to "a verdict is final": support accepting a case
-- ---------------------------------------------------------------------------
create or replace function public.check_ins_guard() returns trigger
  language plpgsql set search_path = ''
as $$
begin
  if new.challenge_id <> old.challenge_id or new.member_id <> old.member_id or new.user_id <> old.user_id
    or new.day <> old.day or new.attempt <> old.attempt or new.note <> old.note
    or new.photo_path <> old.photo_path or new.created_at <> old.created_at then
    raise exception 'a check-in cannot be changed';
  end if;
  -- decide_referee_case sets this flag for the one update it makes.
  if old.state = 'rejected' and new.state = 'accepted'
    and new.decided_at is not distinct from old.decided_at
    and current_setting('zatouna.referee', true) = 'on' then
    return new;
  end if;
  if old.state <> 'pending' and (new.state <> old.state or new.decided_at is distinct from old.decided_at) then
    raise exception 'a check-in verdict is final';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Calling the referee, and deciding
-- ---------------------------------------------------------------------------
create function public.open_referee_case(p_check_in_id uuid, p_explanation text) returns uuid
  language plpgsql security definer set search_path = ''
as $$
declare
  me constant uuid := (select auth.uid());
  ci public.check_ins;
  c public.challenges;
  v_explanation constant text := trim(coalesce(p_explanation, ''));
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
  if ci.state <> 'rejected' then
    raise exception 'only a rejected check-in can go to the referee';
  end if;
  if ci.decided_at < now() - interval '24 hours' then
    raise exception 'the referee can be called within 24 hours of the verdict';
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
  insert into public.referee_cases (check_in_id, challenge_id, member_id, user_id, day, explanation)
  values (ci.id, ci.challenge_id, ci.member_id, me, ci.day, v_explanation)
  returning id into new_id;
  return new_id;
end;
$$;

-- Accepting makes the check-in accepted, so the day counts like any other.
create function public.decide_referee_case(p_case_id uuid, p_accept boolean, p_reason text) returns text
  language plpgsql security definer set search_path = ''
as $$
declare
  me constant uuid := (select auth.uid());
  rc public.referee_cases;
  v_reason constant text := trim(coalesce(p_reason, ''));
begin
  if not public.is_support() then
    raise exception 'only support can decide referee cases' using errcode = 'insufficient_privilege';
  end if;
  select * into rc from public.referee_cases where id = p_case_id for update;
  if not found then
    raise exception 'unknown referee case';
  end if;
  if rc.decision <> 'open' then
    raise exception 'this case is already decided';
  end if;
  if length(v_reason) = 0 then
    raise exception 'write a short reason for the member';
  end if;
  if length(v_reason) > 500 then
    raise exception 'the reason can be 500 characters at most';
  end if;
  update public.referee_cases
  set decision = case when p_accept then 'accepted' else 'rejected' end,
      reason = v_reason, decided_by = me, decided_at = now()
  where id = rc.id;
  if p_accept then
    perform set_config('zatouna.referee', 'on', true);
    update public.check_ins set state = 'accepted' where id = rc.check_in_id and state = 'rejected';
    perform set_config('zatouna.referee', 'off', true);
  end if;
  return case when p_accept then 'accepted' else 'rejected' end;
end;
$$;

-- Story 7.3: a case nobody decided within 48 hours of the end of the
-- challenge counts as accepted. Ties go to the member.
create function public.accept_stale_referee_cases() returns integer
  language plpgsql security definer set search_path = ''
as $$
declare
  rc record;
  n integer := 0;
begin
  for rc in
    select r.id
    from public.referee_cases r
    join public.challenges c on c.id = r.challenge_id
    where r.decision = 'open'
      and ((c.start_date + c.length_days)::timestamp at time zone c.time_zone) + interval '48 hours' <= now()
    order by r.created_at
  loop
    update public.referee_cases
    set decision = 'accepted',
        reason = 'Not decided within 48 hours of the end of the challenge, so it counts as accepted.',
        decided_at = now()
    where id = rc.id;
    perform set_config('zatouna.referee', 'on', true);
    update public.check_ins ci set state = 'accepted'
    from public.referee_cases r where r.id = rc.id and ci.id = r.check_in_id and ci.state = 'rejected';
    perform set_config('zatouna.referee', 'off', true);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Misses and progress know about open cases
-- ---------------------------------------------------------------------------
-- A day with an open case is neither done nor missed yet (story 7.1).
create or replace function public.member_misses(m public.challenge_members, c public.challenges, p_today date) returns integer
  language plpgsql stable set search_path = ''
as $$
declare
  last_day constant date := c.start_date + (c.length_days - 1);
  week_start date := c.start_date;
  week_end date;
  required integer;
  done integer;
  done_ahead integer;
  waiting integer;
  remaining integer;
  total integer := 0;
begin
  while week_start <= last_day loop
    week_end := least(week_start + 6, last_day);
    required := public.week_required(c.times_per_week, week_end - week_start + 1);
    -- Days already done this week, and how many of those are today or later.
    select count(distinct day), count(distinct day) filter (where day >= p_today) into done, done_ahead
    from public.check_ins
    where member_id = m.id and state = 'accepted' and day between week_start and week_end;
    -- Past days of this week that wait for the referee and are not done.
    select count(distinct r.day) into waiting
    from public.referee_cases r
    where r.member_id = m.id and r.decision = 'open' and r.day between week_start and week_end
      and r.day < p_today
      and not exists (
        select 1 from public.check_ins ci where ci.member_id = m.id and ci.day = r.day and ci.state = 'accepted'
      );
    -- Days from today to the end of the week that are still open.
    remaining := greatest(0, week_end - greatest(p_today, week_start) + 1) - done_ahead;
    -- A week is short once the open days cannot make up the required count.
    total := total + greatest(0, required - done - remaining - waiting);
    week_start := week_start + 7;
  end loop;
  return total;
end;
$$;

-- Each day is "done", "open" (today, nothing accepted yet), "none" (a past
-- day without an accepted check-in), "future", or "referee" (an open case).
-- Only your own days can also read "checking" or "rejected", and only you see
-- "referee" on a day that is still open (story 3.2).
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
    today := public.member_today(m);
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
  misses integer;
  standing text;
  items jsonb := '[]'::jsonb;
begin
  for m in select * from public.challenge_members where user_id = me loop
    select * into c from public.challenges where id = m.challenge_id and deleted_at is null and status = 'active';
    if not found then continue; end if;
    today := public.member_today(m);
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
      'week', public.member_week(m, c, today));
  end loop;
  return items;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The support queue
-- ---------------------------------------------------------------------------
-- Every case (open first, newest first) with what support needs to decide:
-- the rule, the note, the AI's reason and the member's explanation. With an
-- id, just that case.
create function public.referee_queue(p_case_id uuid default null) returns jsonb
  language sql stable security definer set search_path = ''
as $$
  select case when public.is_support() then coalesce(jsonb_agg(row order by row->>'decision' <> 'open', row->>'created_at' desc), '[]'::jsonb) end
  from (
    select jsonb_build_object(
      'id', rc.id,
      'check_in_id', ci.id,
      'challenge_id', c.id,
      'challenge_title', c.title,
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
-- 7. Who may call what
-- ---------------------------------------------------------------------------
grant execute on function public.is_support() to authenticated;
grant execute on function public.is_referee_photo(text) to authenticated;
grant execute on function public.open_referee_case(uuid, text) to authenticated;
grant execute on function public.decide_referee_case(uuid, boolean, text) to authenticated;
grant execute on function public.referee_queue(uuid) to authenticated;
grant execute on function public.accept_stale_referee_cases() to service_role;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('accept-stale-referee-cases', '17 * * * *', 'select public.accept_stale_referee_cases()');
  end if;
end;
$$;
