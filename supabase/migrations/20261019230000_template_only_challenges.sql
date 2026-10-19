-- Challenges come from the seven templates only (owner's decision, 2026-10-19):
-- no custom titles or rules in the first draft. The template texts live in
-- one table, the server copies the title and the rule from the chosen
-- template, and the app only sends which template it picked.

-- 1. The templates. Only migrations change them.
create table public.challenge_templates (
  key text primary key check (key ~ '^[a-z_]{2,40}$'),
  position integer not null unique,
  title text not null check (length(title) between 1 and 80),
  goal text not null check (length(goal) between 1 and 280),
  recommendation text not null check (length(recommendation) between 1 and 280),
  -- What counts as one check-in; copied into the challenge as its rule.
  rule text not null check (length(rule) between 1 and 280)
);
comment on table public.challenge_templates is
  'The preset challenges a creator picks from. Changed only by migrations.';

alter table public.challenge_templates enable row level security;
revoke all on public.challenge_templates from anon, authenticated;
grant select on public.challenge_templates to authenticated;
create policy "Signed-in users read the templates"
  on public.challenge_templates for select to authenticated using (true);

insert into public.challenge_templates (key, position, title, goal, recommendation, rule) values
  ('read_a_book', 1, 'Read a Book',
   'Build a consistent reading habit and improve focus by spending dedicated time each day reading a book.',
   'Choose a book you enjoy and aim to read in a distraction-free environment.',
   'A photo of the open book you are currently reading.'),
  ('workout', 2, 'Workout',
   'Stay active daily.',
   'Alternate between lifting, HIIT, cardio, stretching and recovery to avoid fatigue and injury.',
   'A photo taken in a gym or any workout environment.'),
  ('sunshine', 3, 'Sunshine',
   'Spend time outdoors daily to support mental well-being, energy levels and routine.',
   'Getting sunlight first thing in the morning is ideal.',
   'A photo taken outdoors during daytime.'),
  ('journaling', 4, 'Journaling',
   'Develop a habit of reflection and self-expression through journaling.',
   'Use journaling for reflection, gratitude or tracking personal progress.',
   'A photo of a handwritten journal entry.'),
  ('eating_fruits', 5, 'Eating Fruits',
   'Improve daily nutrition by building a habit of eating fruits.',
   'Use fruits as a healthier alternative to reduce sweets.',
   'A photo of a fruit.'),
  ('learn_french', 6, 'Learn French',
   'Improve your French by practising writing consistently.',
   'The best way to learn is active practice. If you can''t free-write yet, copy from a resource until you are comfortable writing on your own.',
   'A photo of handwritten French text of at least 50 words.'),
  ('pet_cat', 7, 'Pet Cat',
   'Spend quality time with your feline friend.',
   'Take a moment to relax and pet a cat.',
   'A photo of a cat.');

-- 2. Every challenge records its template. Existing challenges were all made
-- from a template (their titles match), so they are matched by title.
alter table public.challenges
  add column template text references public.challenge_templates (key);

update public.challenges c
set template = t.key
from public.challenge_templates t
where c.template is null and c.title = t.title;

do $$
declare
  stray text;
begin
  select string_agg(distinct title, ', ') into stray from public.challenges where template is null;
  if stray is not null then
    raise exception 'these challenges match no template: %', stray;
  end if;
end;
$$;

alter table public.challenges alter column template set not null;

-- 3. Creating and editing no longer take a title or a rule.
drop function public.check_challenge_fields(text, text, integer, date, integer, integer, text);
drop function public.create_challenge(text, text, integer, date, integer, integer, integer, text);
drop function public.update_challenge(uuid, text, text, integer, date, integer, integer);

create function public.check_challenge_fields(
  p_times_per_week integer, p_start_date date, p_length_days integer, p_misses_allowed integer, p_time_zone text
) returns void
  language plpgsql set search_path = ''
as $$
begin
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

create function public.create_challenge(
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
     time_zone, status)
  values
    (me, t.key, t.title, t.rule, p_times_per_week, p_start_date, p_length_days, p_stake, p_misses_allowed,
     p_time_zone,
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

create function public.update_challenge(
  p_id uuid, p_times_per_week integer, p_start_date date, p_length_days integer, p_misses_allowed integer
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
    p_times_per_week, p_start_date, p_length_days, p_misses_allowed, c.time_zone);

  update public.challenges
  set times_per_week = p_times_per_week, start_date = p_start_date, length_days = p_length_days,
    misses_allowed = p_misses_allowed,
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

grant execute on function public.create_challenge(text, integer, date, integer, integer, integer, text)
  to authenticated;
grant execute on function public.update_challenge(uuid, integer, date, integer, integer) to authenticated;
