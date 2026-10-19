-- Token ledger (plan step 5). See docs/ARCHITECTURE.md, "The token ledger".
--
-- Tokens only ever move between accounts inside a balanced transaction.
-- Balances are sums of entries, never stored numbers. The phone can read its
-- own history but cannot write: every token move goes through one of the
-- functions at the end of this file.
--
-- challenges and challenge_members only carry the columns the ledger needs.
-- The challenge feature (plan step 6.1) adds the rest.

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  role text not null default 'member' check (role in ('member', 'support', 'admin')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;

create policy "Users read their own profile"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));

-- Every new account gets a profile, named from the sign-up form.
create function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', ''));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Accounts that existed before this migration.
insert into public.profiles (id, display_name)
select id, coalesce(raw_user_meta_data ->> 'display_name', '') from auth.users
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Challenges and members (ledger columns only)
-- ---------------------------------------------------------------------------

create table public.challenges (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles (id),
  title text not null check (length(title) between 1 and 80),
  stake integer not null check (stake > 0),
  app_fee_percent integer not null default 10 check (app_fee_percent between 0 and 100),
  status text not null default 'draft'
    check (status in ('draft', 'open', 'active', 'refereeing', 'settled')),
  created_at timestamptz not null default now()
);

create table public.challenge_members (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges (id),
  user_id uuid not null references public.profiles (id),
  time_zone text not null,
  joined_at timestamptz not null default now(),
  result text not null default 'in_progress'
    check (result in ('in_progress', 'finished', 'forfeited')),
  unique (challenge_id, user_id)
);

-- A challenge's status only moves forward (ARCHITECTURE.md, "Data model").
create function public.challenges_status_forward_only() returns trigger
  language plpgsql set search_path = ''
as $$
declare
  steps constant text[] := array['draft', 'open', 'active', 'refereeing', 'settled'];
begin
  if array_position(steps, new.status) < array_position(steps, old.status) then
    raise exception 'challenge status cannot go back from % to %', old.status, new.status;
  end if;
  return new;
end;
$$;

create trigger challenges_status_forward_only
  before update of status on public.challenges
  for each row execute function public.challenges_status_forward_only();

create function public.is_challenge_member(p_challenge_id uuid) returns boolean
  language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.challenge_members
    where challenge_id = p_challenge_id and user_id = (select auth.uid())
  );
$$;

alter table public.challenges enable row level security;
alter table public.challenge_members enable row level security;
revoke all on public.challenges, public.challenge_members from anon, authenticated;
grant select on public.challenges, public.challenge_members to authenticated;

create policy "Creators and members read a challenge"
  on public.challenges for select to authenticated
  using (creator_id = (select auth.uid()) or public.is_challenge_member(id));

create policy "Members see who else is in their challenges"
  on public.challenge_members for select to authenticated
  using (public.is_challenge_member(challenge_id));

-- ---------------------------------------------------------------------------
-- Ledger tables
-- ---------------------------------------------------------------------------

create table public.ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('wallet', 'pool', 'admin_gifts', 'app_revenue')),
  -- Set null when the user is deleted, so their history stays as "deleted user".
  user_id uuid references public.profiles (id) on delete set null,
  challenge_id uuid references public.challenges (id),
  created_at timestamptz not null default now(),
  constraint ledger_accounts_owner check (
    (kind = 'wallet' and challenge_id is null)
    or (kind = 'pool' and user_id is null and challenge_id is not null)
    or (kind in ('admin_gifts', 'app_revenue') and user_id is null and challenge_id is null)
  )
);

create unique index ledger_accounts_one_wallet on public.ledger_accounts (user_id) where kind = 'wallet';
create unique index ledger_accounts_one_pool on public.ledger_accounts (challenge_id) where kind = 'pool';
create unique index ledger_accounts_one_system on public.ledger_accounts (kind)
  where kind in ('admin_gifts', 'app_revenue');

insert into public.ledger_accounts (kind) values ('admin_gifts'), ('app_revenue');

create table public.ledger_transactions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('gift', 'stake', 'refund', 'settlement', 'correction')),
  -- One key per real-world event, e.g. stake:<member> or settle:<challenge>.
  idempotency_key text not null unique,
  challenge_id uuid references public.challenges (id),
  note text not null default '',
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.ledger_entries (
  id bigint generated always as identity primary key,
  transaction_id uuid not null references public.ledger_transactions (id),
  account_id uuid not null references public.ledger_accounts (id),
  amount bigint not null check (amount <> 0),
  created_at timestamptz not null default now()
);

create index ledger_entries_account on public.ledger_entries (account_id);
create index ledger_entries_transaction on public.ledger_entries (transaction_id);

-- Rule 1: append-only. Mistakes are fixed with a new reversing transaction.
create function public.ledger_append_only() returns trigger
  language plpgsql set search_path = ''
as $$
begin
  raise exception 'the token ledger is append-only: % on % is not allowed', tg_op, tg_table_name;
end;
$$;

create trigger ledger_transactions_append_only
  before update or delete on public.ledger_transactions
  for each row execute function public.ledger_append_only();
create trigger ledger_transactions_no_truncate
  before truncate on public.ledger_transactions
  for each statement execute function public.ledger_append_only();
create trigger ledger_entries_append_only
  before update or delete on public.ledger_entries
  for each row execute function public.ledger_append_only();
create trigger ledger_entries_no_truncate
  before truncate on public.ledger_entries
  for each statement execute function public.ledger_append_only();

-- The checks below run as security definer: deferred checks fire at commit as
-- whoever is signed in, and must see every entry, not just the caller's.

-- Rule 2: balanced. Checked at commit, once all of a transaction's entries exist.
create function public.ledger_check_balanced() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare
  entry_count integer;
  total bigint;
begin
  select count(*), coalesce(sum(amount), 0) into entry_count, total
  from public.ledger_entries where transaction_id = new.id;
  if entry_count < 2 or total <> 0 then
    raise exception 'ledger transaction % is not balanced (% entries, sum %)', new.id, entry_count, total;
  end if;
  return null;
end;
$$;

create constraint trigger ledger_transactions_balanced
  after insert on public.ledger_transactions
  deferrable initially deferred
  for each row execute function public.ledger_check_balanced();

-- Entries can only be added in the same database transaction that created
-- their ledger transaction (now() is fixed for a whole database transaction);
-- otherwise a later insert could unbalance it.
create function public.ledger_entry_same_transaction() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.ledger_transactions t
    where t.id = new.transaction_id and t.created_at = now()
  ) then
    raise exception 'entries can only be added together with their ledger transaction';
  end if;
  return new;
end;
$$;

create trigger ledger_entries_same_transaction
  before insert on public.ledger_entries
  for each row execute function public.ledger_entry_same_transaction();

-- Rule 3: no overdraft. Wallets and pools never go below zero. The account row
-- is locked first so two transactions at the same moment are checked one
-- after the other, each seeing the other's entries.
create function public.ledger_check_not_negative() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare
  account_kind text;
  balance bigint;
begin
  if new.amount > 0 then
    return null;
  end if;
  select kind into account_kind from public.ledger_accounts where id = new.account_id for update;
  if account_kind in ('wallet', 'pool') then
    select coalesce(sum(amount), 0) into balance
    from public.ledger_entries where account_id = new.account_id;
    if balance < 0 then
      raise exception 'not enough tokens: % % would go to %', account_kind, new.account_id, balance
        using errcode = 'check_violation';
    end if;
  end if;
  return null;
end;
$$;

create constraint trigger ledger_entries_not_negative
  after insert on public.ledger_entries
  deferrable initially deferred
  for each row execute function public.ledger_check_not_negative();

-- Rule 4: only the server writes. The phone may read its own wallet and the
-- pools of its challenges, nothing more.
alter table public.ledger_accounts enable row level security;
alter table public.ledger_transactions enable row level security;
alter table public.ledger_entries enable row level security;
revoke all on public.ledger_accounts, public.ledger_transactions, public.ledger_entries
  from anon, authenticated;
grant select on public.ledger_accounts, public.ledger_transactions, public.ledger_entries
  to authenticated;

create function public.can_read_ledger_account(p_account_id uuid) returns boolean
  language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.ledger_accounts a
    where a.id = p_account_id
      and ((a.kind = 'wallet' and a.user_id = (select auth.uid()))
        or (a.kind = 'pool' and public.is_challenge_member(a.challenge_id)))
  );
$$;

create policy "Users read their wallet and their challenges' pools"
  on public.ledger_accounts for select to authenticated
  using (public.can_read_ledger_account(id));

create policy "Users read entries of accounts they can see"
  on public.ledger_entries for select to authenticated
  using (public.can_read_ledger_account(account_id));

create policy "Users read transactions that touch their accounts"
  on public.ledger_transactions for select to authenticated
  using (exists (
    select 1 from public.ledger_entries e
    where e.transaction_id = ledger_transactions.id and public.can_read_ledger_account(e.account_id)
  ));

-- Balances, always computed from entries. Reads go through the caller's RLS.
create view public.ledger_balances with (security_invoker = true) as
  select a.id as account_id, a.kind, a.user_id, a.challenge_id,
    coalesce(sum(e.amount), 0)::bigint as balance
  from public.ledger_accounts a
  left join public.ledger_entries e on e.account_id = a.id
  group by a.id;

revoke all on public.ledger_balances from anon, authenticated;
grant select on public.ledger_balances to authenticated;

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable from the app)
-- ---------------------------------------------------------------------------

create function public.ledger_system_account(p_kind text) returns uuid
  language sql stable set search_path = ''
as $$
  select id from public.ledger_accounts where kind = p_kind;
$$;

create function public.ledger_wallet(p_user_id uuid) returns uuid
  language plpgsql set search_path = ''
as $$
declare
  account uuid;
begin
  insert into public.ledger_accounts (kind, user_id) values ('wallet', p_user_id)
  on conflict (user_id) where kind = 'wallet' do nothing;
  select id into account from public.ledger_accounts where kind = 'wallet' and user_id = p_user_id;
  return account;
end;
$$;

create function public.ledger_pool(p_challenge_id uuid) returns uuid
  language plpgsql set search_path = ''
as $$
declare
  account uuid;
begin
  insert into public.ledger_accounts (kind, challenge_id) values ('pool', p_challenge_id)
  on conflict (challenge_id) where kind = 'pool' do nothing;
  select id into account from public.ledger_accounts where kind = 'pool' and challenge_id = p_challenge_id;
  return account;
end;
$$;

-- Starts a ledger transaction. Returns null if one with this key already
-- exists (rule 5), in which case the caller must not write any entries.
create function public.ledger_begin(
  p_kind text, p_key text, p_challenge_id uuid, p_note text, p_created_by uuid
) returns uuid
  language plpgsql set search_path = ''
as $$
declare
  tx uuid;
begin
  insert into public.ledger_transactions (kind, idempotency_key, challenge_id, note, created_by)
  values (p_kind, p_key, p_challenge_id, coalesce(p_note, ''), p_created_by)
  on conflict (idempotency_key) do nothing
  returning id into tx;
  return tx;
end;
$$;

create function public.ledger_post(p_transaction_id uuid, p_account_id uuid, p_amount bigint)
  returns void
  language sql set search_path = ''
as $$
  insert into public.ledger_entries (transaction_id, account_id, amount)
  values (p_transaction_id, p_account_id, p_amount);
$$;

-- ---------------------------------------------------------------------------
-- Token moves
-- ---------------------------------------------------------------------------

-- Admin gives tokens to a tester (PRODUCT.md 1.2). p_request_id makes a retried
-- request count once.
create function public.admin_grant_tokens(
  p_user_id uuid, p_amount integer, p_note text, p_request_id uuid
) returns uuid
  language plpgsql security definer set search_path = ''
as $$
declare
  tx uuid;
begin
  if (select auth.role()) is distinct from 'service_role' and not exists (
    select 1 from public.profiles where id = (select auth.uid()) and role = 'admin'
  ) then
    raise exception 'only the admin can give tokens' using errcode = 'insufficient_privilege';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'the amount must be a positive whole number';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'no such user';
  end if;

  tx := public.ledger_begin('gift', 'gift:' || p_request_id, null, p_note, (select auth.uid()));
  if tx is null then
    return (select id from public.ledger_transactions where idempotency_key = 'gift:' || p_request_id);
  end if;
  perform public.ledger_post(tx, public.ledger_system_account('admin_gifts'), -p_amount);
  perform public.ledger_post(tx, public.ledger_wallet(p_user_id), p_amount);
  return tx;
end;
$$;

-- Join a challenge by staking (PRODUCT.md 4.1). Fails without enough tokens.
create function public.join_challenge(p_challenge_id uuid, p_time_zone text) returns uuid
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
  select * into c from public.challenges where id = p_challenge_id for update;
  if not found or c.status <> 'open' then
    raise exception 'this challenge is not open for joining';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_time_zone) then
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

-- Leave before the start and get the stake back (PRODUCT.md 4.2).
create function public.leave_challenge(p_challenge_id uuid) returns void
  language plpgsql security definer set search_path = ''
as $$
declare
  me constant uuid := (select auth.uid());
  c public.challenges;
  m public.challenge_members;
  tx uuid;
begin
  select * into c from public.challenges where id = p_challenge_id for update;
  if not found or c.status not in ('draft', 'open') then
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

-- Quit after the start: the stake stays in the pool and is lost at
-- settlement (PRODUCT.md 4.3).
create function public.quit_challenge(p_challenge_id uuid) returns void
  language plpgsql security definer set search_path = ''
as $$
begin
  update public.challenge_members m
  set result = 'forfeited'
  from public.challenges c
  where c.id = m.challenge_id and m.challenge_id = p_challenge_id
    and m.user_id = (select auth.uid()) and m.result = 'in_progress' and c.status = 'active';
  if not found then
    raise exception 'you can only quit a challenge that is running and that you are still in';
  end if;
end;
$$;

-- Settlement (PRODUCT.md 8, ARCHITECTURE.md rules 5 to 7). Runs on the server
-- only. Running it again on a settled challenge changes nothing.
create function public.settle_challenge(p_challenge_id uuid) returns text
  language plpgsql security definer set search_path = ''
as $$
declare
  c public.challenges;
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
  -- Open referee cases are closed as accepted here once referee_cases exists
  -- (plan step 6.4). Until then, every member's result must already be decided.
  if exists (select 1 from public.challenge_members where challenge_id = c.id and result = 'in_progress') then
    raise exception 'every member must be finished or forfeited before settlement';
  end if;

  select count(*), count(*) filter (where result = 'finished')
  into member_count, finisher_count
  from public.challenge_members where challenge_id = c.id;

  pool := public.ledger_pool(c.id);
  select coalesce(sum(amount), 0) into pool_balance from public.ledger_entries where account_id = pool;
  if pool_balance <> c.stake::bigint * member_count then
    raise exception 'pool holds % but % members staked % each', pool_balance, member_count, c.stake;
  end if;

  update public.challenges set status = 'settled' where id = c.id;
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

-- ---------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------

-- New functions are callable by everyone by default, so close them all first.
revoke execute on function
  public.handle_new_user(),
  public.challenges_status_forward_only(),
  public.is_challenge_member(uuid),
  public.ledger_append_only(),
  public.ledger_check_balanced(),
  public.ledger_entry_same_transaction(),
  public.ledger_check_not_negative(),
  public.can_read_ledger_account(uuid),
  public.ledger_system_account(text),
  public.ledger_wallet(uuid),
  public.ledger_pool(uuid),
  public.ledger_begin(text, text, uuid, text, uuid),
  public.ledger_post(uuid, uuid, bigint),
  public.admin_grant_tokens(uuid, integer, text, uuid),
  public.join_challenge(uuid, text),
  public.leave_challenge(uuid),
  public.quit_challenge(uuid),
  public.settle_challenge(uuid)
from public, anon, authenticated, service_role;

grant execute on function public.admin_grant_tokens(uuid, integer, text, uuid) to authenticated, service_role;
grant execute on function public.join_challenge(uuid, text) to authenticated;
grant execute on function public.leave_challenge(uuid) to authenticated;
grant execute on function public.quit_challenge(uuid) to authenticated;
-- Used inside RLS policies, which run as the reading user.
grant execute on function public.is_challenge_member(uuid) to authenticated;
grant execute on function public.can_read_ledger_account(uuid) to authenticated;
grant execute on function public.settle_challenge(uuid) to service_role;
