-- Welcome tokens for testing (owner's decision 2026-10-19). Every new
-- account starts with tokens, so testers and their friends can join
-- challenges at once. One setting holds the amount; setting it to 0 turns
-- the gift off (to do before real money). The gift is an ordinary ledger
-- transaction from the admin gifts account, so every ledger rule still holds.

-- ---------------------------------------------------------------------------
-- App settings: a single row of switches, readable by the server only
-- ---------------------------------------------------------------------------

create table public.app_settings (
  only_row boolean primary key default true check (only_row),
  -- Tokens a new account starts with. 0 turns the welcome gift off.
  welcome_tokens integer not null default 0 check (welcome_tokens >= 0),
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;

insert into public.app_settings (welcome_tokens) values (1000);

-- ---------------------------------------------------------------------------
-- Sign-up: profile, wallet, and the welcome gift
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare
  amount integer;
  tx uuid;
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 80));
  perform public.ledger_wallet(new.id);

  select welcome_tokens into amount from public.app_settings;
  if coalesce(amount, 0) > 0 then
    -- One welcome gift per account, ever: the key is the account id.
    tx := public.ledger_begin('gift', 'gift:welcome:' || new.id, null, 'Welcome tokens for testing', null);
    if tx is not null then
      perform public.ledger_post(tx, public.ledger_system_account('admin_gifts'), -amount);
      perform public.ledger_post(tx, public.ledger_wallet(new.id), amount);
    end if;
  end if;
  return new;
end;
$$;
