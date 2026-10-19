-- Daily check-ins (PRODUCT.md stories 5 and 6): one photo plus a note per
-- attempt, judged by an AI on the server. A member can retry as often as they
-- like until their own midnight. Friends only ever learn whether a day was
-- done. The referee (story 7) comes in the next step.

-- ---------------------------------------------------------------------------
-- 1. What the AI is told for each template (seeded from the owner's Gemini app)
-- ---------------------------------------------------------------------------
alter table public.challenge_templates add column ai_instruction text not null default '';

update public.challenge_templates t
set ai_instruction = v.instruction
from (values
  ('read_a_book',
   'The photo must show an open book that someone is reading right now. A closed book, a screen or an e-reader does not count.'),
  ('workout',
   'The photo must be taken in a gym or another workout setting, such as weights, machines, a track or a yoga mat in use. Sports clothes alone do not count.'),
  ('sunshine',
   'The photo must be taken outdoors in daylight, with the outdoors clearly visible. Cloudy is fine as long as it is daytime and outside. A view through a window does not count.'),
  ('journaling',
   'The photo must show a journal entry written by hand on paper. Typed text or a screen does not count.'),
  ('eating_fruits',
   'The photo must show a real fruit, whole or cut. A picture of a fruit, juice or candy does not count.'),
  ('learn_french',
   'The photo must show French text written by hand, at least 50 words long. Count the words and check that the language is French. Typed text or a screen does not count.'),
  ('pet_cat',
   'The photo must show a real cat. A drawing, a toy, a screen or another animal does not count.')
) as v (key, instruction)
where t.key = v.key;

alter table public.challenge_templates alter column ai_instruction drop default;
alter table public.challenge_templates
  add constraint challenge_templates_ai_instruction_present check (length(ai_instruction) > 0);

-- ---------------------------------------------------------------------------
-- 2. The check-ins and the AI's verdicts
-- ---------------------------------------------------------------------------
create table public.check_ins (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges (id),
  member_id uuid not null references public.challenge_members (id),
  user_id uuid not null references public.profiles (id),
  -- The member's own calendar day it counts for (their time zone, fixed at joining).
  day date not null,
  -- 1 for the first photo of the day, 2 for the first retry, and so on.
  attempt integer not null check (attempt >= 1),
  note text not null default '' check (length(note) <= 280),
  -- Where the photo lives in the private "check-ins" bucket.
  photo_path text not null unique,
  state text not null default 'pending' check (state in ('pending', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (member_id, day, attempt)
);
comment on table public.check_ins is 'One photo and note. A retry is a new row with the next attempt number.';
create index check_ins_member_day on public.check_ins (member_id, day);

create table public.ai_checks (
  check_in_id uuid primary key references public.check_ins (id),
  -- likely_ok accepts; unsure and likely_not_ok reject; failed is an AI error or timeout (also rejects).
  label text not null check (label in ('likely_ok', 'unsure', 'likely_not_ok', 'failed')),
  reason text not null,
  model text not null,
  took_ms integer not null check (took_ms >= 0),
  created_at timestamptz not null default now()
);
comment on table public.ai_checks is 'The AI''s verdict on one check-in, kept so models can be compared later.';

-- A check-in never changes except for its verdict, and a verdict is final.
create function public.check_ins_guard() returns trigger
  language plpgsql set search_path = ''
as $$
begin
  if new.challenge_id <> old.challenge_id or new.member_id <> old.member_id or new.user_id <> old.user_id
    or new.day <> old.day or new.attempt <> old.attempt or new.note <> old.note
    or new.photo_path <> old.photo_path or new.created_at <> old.created_at then
    raise exception 'a check-in cannot be changed';
  end if;
  if old.state <> 'pending' and (new.state <> old.state or new.decided_at is distinct from old.decided_at) then
    raise exception 'a check-in verdict is final';
  end if;
  return new;
end;
$$;

create trigger check_ins_guard
  before update on public.check_ins
  for each row execute function public.check_ins_guard();

alter table public.check_ins enable row level security;
alter table public.ai_checks enable row level security;
revoke all on public.check_ins, public.ai_checks from anon, authenticated;
grant select on public.check_ins, public.ai_checks to authenticated;

-- Friends never see another member's check-ins, only the day summary below.
create policy "Members read their own check-ins"
  on public.check_ins for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Members read the verdicts on their own check-ins"
  on public.ai_checks for select to authenticated
  using (exists (
    select 1 from public.check_ins ci where ci.id = check_in_id and ci.user_id = (select auth.uid())
  ));

-- ---------------------------------------------------------------------------
-- 3. Private photo storage
-- ---------------------------------------------------------------------------
-- Photos go to the private "check-ins" bucket at <challenge>/<user>/<check-in>.jpg.
-- A member can upload only the photo of a check-in they just started, and can
-- see only their own photos (through short-lived signed links).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('check-ins', 'check-ins', false, 5 * 1024 * 1024, array['image/jpeg'])
on conflict (id) do nothing;

create policy "Members upload the photo of their own pending check-in"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'check-ins'
    and exists (
      select 1 from public.check_ins ci
      where ci.photo_path = name and ci.user_id = (select auth.uid()) and ci.state = 'pending'
    )
  );

create policy "Members see their own check-in photos"
  on storage.objects for select to authenticated
  using (bucket_id = 'check-ins' and (storage.foldername(name))[2] = (select auth.uid())::text);

-- ---------------------------------------------------------------------------
-- 4. Days, weeks and misses
-- ---------------------------------------------------------------------------
-- The member's own calendar date right now.
create function public.member_today(m public.challenge_members) returns date
  language sql stable set search_path = ''
as $$
  select (now() at time zone m.time_zone)::date;
$$;

-- How many days a member needs in one 7-day week of the challenge. The last
-- week may be shorter and needs a fair share of "times a week", rounded up:
-- 3 times a week on a 10-day challenge means 3 in days 1 to 7, then 2 in
-- days 8 to 10 (owner's decision, 2026-10-19).
create function public.week_required(p_times_per_week integer, p_days_in_week integer) returns integer
  language sql immutable set search_path = ''
as $$
  select ceil(p_times_per_week * p_days_in_week / 7.0)::integer;
$$;

-- Misses so far, counted per week from the start date: a week is short once it
-- can no longer reach the required number, counting today and later days as
-- still possible. For a daily challenge this is simply every past day without
-- an accepted check-in.
create function public.member_misses(m public.challenge_members, c public.challenges, p_today date) returns integer
  language plpgsql stable set search_path = ''
as $$
declare
  last_day constant date := c.start_date + (c.length_days - 1);
  week_start date := c.start_date;
  week_end date;
  required integer;
  done integer;
  done_ahead integer;
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
    -- Days from today to the end of the week that are still open.
    remaining := greatest(0, week_end - greatest(p_today, week_start) + 1) - done_ahead;
    -- A week is short once the open days cannot make up the required count.
    total := total + greatest(0, required - done - remaining);
    week_start := week_start + 7;
  end loop;
  return total;
end;
$$;

-- Where the member stands in the current week: null outside the challenge days.
create function public.member_week(m public.challenge_members, c public.challenges, p_today date) returns jsonb
  language plpgsql stable set search_path = ''
as $$
declare
  last_day constant date := c.start_date + (c.length_days - 1);
  week_start date;
  week_end date;
  done integer;
  done_ahead integer;
begin
  if p_today < c.start_date or p_today > last_day then
    return null;
  end if;
  week_start := c.start_date + ((p_today - c.start_date) / 7) * 7;
  week_end := least(week_start + 6, last_day);
  select count(distinct day), count(distinct day) filter (where day >= p_today) into done, done_ahead
  from public.check_ins
  where member_id = m.id and state = 'accepted' and day between week_start and week_end;
  return jsonb_build_object(
    'starts', week_start, 'ends', week_end,
    'required', public.week_required(c.times_per_week, week_end - week_start + 1),
    'done', done, 'days_left', week_end - p_today + 1 - done_ahead);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Starting, finishing and writing off a check-in
-- ---------------------------------------------------------------------------
-- A check that never got its verdict (the app closed, the AI hung) is written
-- off after three minutes so the member can retry.
create function public.expire_check_in(p_id uuid) returns boolean
  language plpgsql set search_path = ''
as $$
declare
  ci public.check_ins;
begin
  select * into ci from public.check_ins where id = p_id for update;
  if not found or ci.state <> 'pending' or ci.created_at > now() - interval '3 minutes' then
    return false;
  end if;
  insert into public.ai_checks (check_in_id, label, reason, model, took_ms)
  values (ci.id, 'failed', 'The check did not finish. Please try again.', 'none', 0)
  on conflict (check_in_id) do nothing;
  update public.check_ins set state = 'rejected', decided_at = now() where id = ci.id;
  return true;
end;
$$;

-- Run by the scheduler every minute (and by the member's next attempt).
create function public.expire_stale_check_ins() returns integer
  language plpgsql security definer set search_path = ''
as $$
declare
  n integer := 0;
  ci record;
begin
  for ci in
    select id from public.check_ins
    where state = 'pending' and created_at <= now() - interval '3 minutes'
    order by created_at
  loop
    if public.expire_check_in(ci.id) then n := n + 1; end if;
  end loop;
  return n;
end;
$$;

-- Step 1 of a check-in: the app asks for a slot, uploads the photo to the
-- path returned, then asks the server function to judge it.
create function public.begin_check_in(p_challenge_id uuid, p_note text) returns jsonb
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
  today := public.member_today(m);
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

-- Step 2, server only: record the AI's verdict. Likely okay accepts; anything
-- else rejects. Calling it twice changes nothing.
create function public.finish_check_in(
  p_id uuid, p_label text, p_reason text, p_model text, p_took_ms integer
) returns text
  language plpgsql security definer set search_path = ''
as $$
declare
  ci public.check_ins;
  verdict text;
begin
  if p_label not in ('likely_ok', 'unsure', 'likely_not_ok', 'failed') then
    raise exception 'unknown verdict %', p_label;
  end if;
  select * into ci from public.check_ins where id = p_id for update;
  if not found then
    raise exception 'unknown check-in';
  end if;
  if ci.state <> 'pending' then
    return ci.state;
  end if;
  verdict := case when p_label = 'likely_ok' then 'accepted' else 'rejected' end;
  insert into public.ai_checks (check_in_id, label, reason, model, took_ms)
  values (ci.id, p_label, left(coalesce(p_reason, ''), 280), coalesce(p_model, 'unknown'), greatest(0, coalesce(p_took_ms, 0)));
  update public.check_ins set state = verdict, decided_at = now() where id = ci.id;
  return verdict;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. What the app shows
-- ---------------------------------------------------------------------------
-- Everyone's progress in one challenge. Each day is "done", "open" (today,
-- nothing accepted yet), "none" (a past day without an accepted check-in),
-- or "future". Only your own days can also read "checking" or "rejected":
-- attempts stay private while the day is open (story 3.2).
create function public.challenge_progress(p_challenge_id uuid) returns jsonb
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
        bool_or(state = 'rejected') as rejected
      into r
      from public.check_ins where member_id = m.id and day = d;
      status := case
        when coalesce(r.done, false) then 'done'
        when d > today then 'future'
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

-- Your own standing today in every running challenge, for the Home screen.
create function public.my_today() returns jsonb
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
-- 7. Who may call what
-- ---------------------------------------------------------------------------
grant execute on function public.begin_check_in(uuid, text) to authenticated;
grant execute on function public.challenge_progress(uuid) to authenticated;
grant execute on function public.my_today() to authenticated;
grant execute on function public.finish_check_in(uuid, text, text, text, integer) to service_role;
grant execute on function public.expire_stale_check_ins() to service_role;

-- Supabase has the pg_cron scheduler; the local test database does not.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('expire-stale-check-ins', '* * * * *', 'select public.expire_stale_check_ins()');
  end if;
end;
$$;
