// Tests for the token ledger (supabase/migrations/*_token_ledger.sql).
// Run with `npm run test:db`. Needs Postgres installed locally (initdb on PATH,
// or PG_BIN pointing at its bin folder).
import { after, before, beforeEach, afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, startServer, stopServer } from './db.mjs';

before(startServer);
after(stopServer);

let db;
beforeEach(async () => {
  db = await freshDb();
});
afterEach(async () => {
  // Tokens are never created or destroyed: every entry has a matching
  // opposite entry, and no wallet or pool is ever below zero.
  const { total } = await db.one(`select coalesce(sum(amount), 0)::int as total from ledger_entries`);
  assert.equal(total, 0, 'the ledger must always sum to zero');
  const { negative } = await db.one(
    `select count(*)::int as negative from ledger_balances where kind in ('wallet', 'pool') and balance < 0`,
  );
  assert.equal(negative, 0, 'no wallet or pool may be negative');
  await db.close();
});

// Creates a challenge where `finishers` of `members` people finish, ready to settle.
async function endedChallenge({ members, finishers, stake, fee = 10 }) {
  const creator = await db.createUser('creator');
  const challenge = await db.createChallenge({ creator, stake, fee });
  const users = [];
  for (let i = 0; i < members; i++) {
    const u = await db.createUser(`member${i}`);
    await db.give(u, stake);
    await db.join(u, challenge);
    users.push(u);
  }
  await db.setStatus(challenge, 'active');
  for (let i = 0; i < members; i++) {
    await db.setResult(challenge, users[i], i < finishers ? 'finished' : 'forfeited');
  }
  await db.setStatus(challenge, 'refereeing');
  return { challenge, users };
}

describe('accounts and gifts', () => {
  test('a new user gets a profile and an empty wallet', async () => {
    const ana = await db.createUser('Ana');
    const profile = await db.one(`select display_name, role from profiles where id = $1`, [ana]);
    assert.deepEqual(profile, { display_name: 'Ana', role: 'member' });
    const wallet = await db.as(ana, async (c) => (await c.query(`select kind, balance::int from ledger_balances`)).rows);
    assert.deepEqual(wallet, [{ kind: 'wallet', balance: 0 }]);
  });

  test('sign-up still works when the auth service inserts the user', async () => {
    // In Supabase the auth service, not the app, inserts into auth.users. It
    // has no rights on public tables and no execute right on our trigger.
    await db.owner.query('begin');
    await db.owner.query('set local role supabase_auth_admin');
    const { id } = (
      await db.owner.query(
        `insert into auth.users (email, raw_user_meta_data) values ('ben@test.local', '{"display_name": "Ben"}') returning id`,
      )
    ).rows[0];
    await db.owner.query('commit');
    const profile = await db.one(`select display_name from profiles where id = $1`, [id]);
    assert.equal(profile.display_name, 'Ben');
    assert.equal(await db.balanceOf(id), 0);
  });

  test('a new account starts with the welcome tokens while the setting is on', async () => {
    await db.owner.query(`update app_settings set welcome_tokens = 1000`);
    const ana = await db.createUser('Ana');
    assert.equal(await db.balanceOf(ana), 1000);
    assert.equal(await db.systemBalance('admin_gifts'), -1000);
    const history = await db.as(ana, async (c) =>
      (await c.query(`select kind, note, created_by, challenge_id from ledger_transactions`)).rows,
    );
    assert.deepEqual(history, [
      { kind: 'gift', note: 'Welcome tokens for testing', created_by: null, challenge_id: null },
    ]);

    // Also when the auth service itself inserts the user, as on Supabase.
    await db.owner.query('begin');
    await db.owner.query('set local role supabase_auth_admin');
    const { id } = (
      await db.owner.query(
        `insert into auth.users (email, raw_user_meta_data) values ('ben@test.local', '{"display_name": "Ben"}') returning id`,
      )
    ).rows[0];
    await db.owner.query('commit');
    assert.equal(await db.balanceOf(id), 1000);

    // Switched off, new accounts start empty again; existing ones keep theirs.
    await db.owner.query(`update app_settings set welcome_tokens = 0`);
    const carl = await db.createUser('Carl');
    assert.equal(await db.balanceOf(carl), 0);
    assert.equal(await db.balanceOf(ana), 1000);
  });

  test('the welcome amount is set to 1,000 by the migration itself', async () => {
    // The test template switches it off; the migration's own value is what
    // the live database gets.
    const { value } = await db.one(
      `select regexp_replace(pg_get_expr(d.adbin, d.adrelid), '[^0-9]', '', 'g') as value
       from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
       where d.adrelid = 'app_settings'::regclass and a.attname = 'welcome_tokens'`,
    );
    assert.equal(value, '0', 'the column default is 0 (off)');
    const { lines } = await db.one(
      `select count(*)::int as lines from pg_proc where proname = 'handle_new_user' and prosrc like '%welcome_tokens%'`,
    );
    assert.equal(lines, 1, 'sign-up reads the setting');
  });

  test('the app can neither read nor change the settings', async () => {
    const ana = await db.createUser('Ana');
    await assert.rejects(db.as(ana, (c) => c.query(`select * from app_settings`)), /permission denied/);
    await assert.rejects(
      db.as(ana, (c) => c.query(`update app_settings set welcome_tokens = 999999`)),
      /permission denied/,
    );
    await db.owner.query('begin');
    await db.owner.query('set local role anon');
    await assert.rejects(db.owner.query(`select * from app_settings`), /permission denied/);
    await db.owner.query('rollback');
  });

  test('a very long sign-up name is cut instead of breaking sign-up', async () => {
    const id = await db.createUser('x'.repeat(200));
    const { display_name } = await db.one(`select display_name from profiles where id = $1`, [id]);
    assert.equal(display_name.length, 80);
  });

  test('the admin gives tokens, which show in the balance and the history', async () => {
    const admin = await db.createUser('owner', { role: 'admin' });
    const ana = await db.createUser('Ana');
    await db.as(admin, (c) => c.query(`select admin_grant_tokens($1, 500, 'Welcome', $2)`, [ana, randomUUID()]));
    assert.equal(await db.balanceOf(ana), 500);
    assert.equal(await db.systemBalance('admin_gifts'), -500);

    const history = await db.as(ana, async (c) =>
      (
        await c.query(
          `select t.kind, t.note, e.amount::int from ledger_entries e
           join ledger_transactions t on t.id = e.transaction_id`,
        )
      ).rows,
    );
    assert.deepEqual(history, [{ kind: 'gift', note: 'Welcome', amount: 500 }]);
  });

  test('a retried gift with the same request id counts once', async () => {
    const admin = await db.createUser('owner', { role: 'admin' });
    const ana = await db.createUser('Ana');
    const request = randomUUID();
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        await db.as(
          admin,
          async (c) => (await c.query(`select admin_grant_tokens($1, 500, 'Welcome', $2) as id`, [ana, request])).rows[0].id,
        ),
      );
    }
    assert.equal(await db.balanceOf(ana), 500);
    assert.equal(new Set(ids).size, 1);
  });

  test('a request id cannot be reused for a different gift, and is required', async () => {
    const admin = await db.createUser('owner', { role: 'admin' });
    const ana = await db.createUser('Ana');
    const ben = await db.createUser('Ben');
    const request = randomUUID();
    await db.as(admin, (c) => c.query(`select admin_grant_tokens($1, 500, 'Welcome', $2)`, [ana, request]));
    await assert.rejects(
      db.as(admin, (c) => c.query(`select admin_grant_tokens($1, 500, 'Welcome', $2)`, [ben, request])),
      /already used for a different gift/,
    );
    await assert.rejects(
      db.as(admin, (c) => c.query(`select admin_grant_tokens($1, 900, 'Welcome', $2)`, [ana, request])),
      /already used for a different gift/,
    );
    await assert.rejects(
      db.as(admin, (c) => c.query(`select admin_grant_tokens($1, 500, 'Welcome', null)`, [ana])),
      /request id is required/,
    );
    assert.equal(await db.balanceOf(ana), 500);
    assert.equal(await db.balanceOf(ben), 0);
  });

  test('gifts must be a positive whole number to a real user', async () => {
    const admin = await db.createUser('owner', { role: 'admin' });
    const ana = await db.createUser('Ana');
    for (const amount of [0, -5]) {
      await assert.rejects(
        db.as(admin, (c) => c.query(`select admin_grant_tokens($1, $2, 'x', $3)`, [ana, amount, randomUUID()])),
        /positive whole number/,
      );
    }
    await assert.rejects(
      db.as(admin, (c) => c.query(`select admin_grant_tokens($1, 5, 'x', $2)`, [randomUUID(), randomUUID()])),
      /no such user/,
    );
    assert.equal(await db.balanceOf(ana), 0);
  });

  test('a normal member or support cannot give tokens, not even to themselves', async () => {
    const ana = await db.createUser('Ana');
    const sam = await db.createUser('Sam', { role: 'support' });
    for (const who of [ana, sam]) {
      await assert.rejects(
        db.as(who, (c) => c.query(`select admin_grant_tokens($1, 500, 'free', $2)`, [who, randomUUID()])),
        /only the admin/,
      );
      assert.equal(await db.balanceOf(who), 0);
    }
  });
});

describe('staking', () => {
  test('joining moves the stake from the wallet to the pool', async () => {
    const ana = await db.createUser('Ana');
    await db.give(ana, 500);
    const challenge = await db.createChallenge({ creator: ana, stake: 100 });
    await db.join(ana, challenge);
    assert.equal(await db.balanceOf(ana), 400);
    assert.equal(await db.poolBalance(challenge), 100);
  });

  test('you cannot join without enough tokens', async () => {
    const ana = await db.createUser('Ana');
    await db.give(ana, 50);
    const challenge = await db.createChallenge({ creator: ana, stake: 100 });
    await assert.rejects(db.join(ana, challenge), /not enough tokens/);
    assert.equal(await db.balanceOf(ana), 50);
    assert.equal((await db.one(`select count(*)::int as n from challenge_members`)).n, 0);
  });

  test('two joins at the same moment cannot overdraw a wallet', async () => {
    const ana = await db.createUser('Ana');
    await db.give(ana, 100);
    const first = await db.createChallenge({ creator: ana, stake: 100 });
    const second = await db.createChallenge({ creator: ana, stake: 100 });

    // Two separate connections, both inside an open transaction at once.
    const [c1, c2] = [await db.connect(), await db.connect()];
    const results = await Promise.allSettled([db.join(ana, first, c1), db.join(ana, second, c2)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.match(results.find((r) => r.status === 'rejected').reason.message, /not enough tokens/);
    assert.equal(await db.balanceOf(ana), 0);
  });

  test('ten people joining the same challenge at once all get in', async () => {
    const creator = await db.createUser('creator');
    const challenge = await db.createChallenge({ creator, stake: 10 });
    const joins = [];
    for (let i = 0; i < 10; i++) {
      const u = await db.createUser(`p${i}`);
      await db.give(u, 10);
      joins.push(db.join(u, challenge, await db.connect()));
    }
    await Promise.all(joins);
    assert.equal(await db.poolBalance(challenge), 100);
  });

  test('you cannot join twice, join a full challenge, or join after the start', async () => {
    const creator = await db.createUser('creator');
    const challenge = await db.createChallenge({ creator, stake: 10 });
    const people = [];
    for (let i = 0; i < 11; i++) {
      const u = await db.createUser(`p${i}`);
      await db.give(u, 100);
      people.push(u);
    }
    for (const u of people.slice(0, 10)) await db.join(u, challenge);
    await assert.rejects(db.join(people[0], challenge), /already joined/);
    await assert.rejects(db.join(people[10], challenge), /full/);

    const started = await db.createChallenge({ creator, stake: 10, status: 'active' });
    await assert.rejects(db.join(people[10], started), /not open/);
    const draft = await db.createChallenge({ creator, stake: 10, status: 'draft' });
    await assert.rejects(db.join(people[10], draft), /not open/);
    assert.equal(await db.balanceOf(people[10]), 100);
  });

  test('a join needs a real time zone', async () => {
    const ana = await db.createUser('Ana');
    await db.give(ana, 100);
    const challenge = await db.createChallenge({ creator: ana, stake: 10 });
    await assert.rejects(
      db.as(ana, (c) => c.query(`select join_challenge($1, 'Mars/Olympus')`, [challenge])),
      /unknown time zone/,
    );
    await assert.rejects(db.as(ana, (c) => c.query(`select join_challenge($1, null)`, [challenge])), /unknown time zone/);
    assert.equal(await db.balanceOf(ana), 100);
  });

  test('leaving before the start gives the stake back; rejoining works', async () => {
    const ana = await db.createUser('Ana');
    await db.give(ana, 100);
    const challenge = await db.createChallenge({ creator: ana, stake: 100 });
    await db.join(ana, challenge);
    await db.as(ana, (c) => c.query(`select leave_challenge($1)`, [challenge]));
    assert.equal(await db.balanceOf(ana), 100);
    assert.equal(await db.poolBalance(challenge), 0);
    await assert.rejects(db.as(ana, (c) => c.query(`select leave_challenge($1)`, [challenge])), /not in this challenge/);

    await db.join(ana, challenge);
    assert.equal(await db.balanceOf(ana), 0);
  });

  test('after the start you cannot leave, but you can quit once and lose the stake', async () => {
    const ana = await db.createUser('Ana');
    await db.give(ana, 100);
    const challenge = await db.createChallenge({ creator: ana, stake: 100 });
    await db.join(ana, challenge);
    await assert.rejects(db.as(ana, (c) => c.query(`select quit_challenge($1)`, [challenge])), /only quit a challenge that is running/);
    await db.setStatus(challenge, 'active');
    await assert.rejects(db.as(ana, (c) => c.query(`select leave_challenge($1)`, [challenge])), /only leave before/);
    await db.as(ana, (c) => c.query(`select quit_challenge($1)`, [challenge]));
    const m = await db.one(`select result from challenge_members where user_id = $1`, [ana]);
    assert.equal(m.result, 'forfeited');
    assert.equal(await db.balanceOf(ana), 0);
    await assert.rejects(db.as(ana, (c) => c.query(`select quit_challenge($1)`, [challenge])), /already decided/);
  });

  test('the stake and the fee are frozen once a challenge is open', async () => {
    const creator = await db.createUser('creator');
    const draft = await db.createChallenge({ creator, stake: 10, status: 'draft' });
    await db.owner.query(`update challenges set stake = 20, app_fee_percent = 5 where id = $1`, [draft]);
    const open = await db.createChallenge({ creator, stake: 10 });
    await assert.rejects(db.owner.query(`update challenges set stake = 20 where id = $1`, [open]), /cannot change/);
    await assert.rejects(db.owner.query(`update challenges set app_fee_percent = 0 where id = $1`, [open]), /cannot change/);
  });
});

describe('settlement', () => {
  // The examples from ARCHITECTURE.md, "The token ledger", plus edge cases.
  const examples = [
    { members: 4, finishers: 3, stake: 100, each: 130, revenue: 10 },
    { members: 4, finishers: 2, stake: 100, each: 190, revenue: 20 },
    { members: 5, finishers: 2, stake: 50, each: 117, revenue: 16 },
    { members: 3, finishers: 0, stake: 50, each: 0, revenue: 150 },
    { members: 3, finishers: 3, stake: 50, each: 50, revenue: 0 },
    { members: 1, finishers: 1, stake: 75, each: 75, revenue: 0 },
    { members: 1, finishers: 0, stake: 75, each: 0, revenue: 75 },
    // 14 forfeited; 10% of 14 is 1.4, rounded down to 1; the finisher gets 7 + 13.
    { members: 3, finishers: 1, stake: 7, each: 20, revenue: 1 },
    // 15 forfeited; 10% of 15 is 1.5, rounded DOWN to 1 (not up to 2); the finisher gets 5 + 14.
    { members: 4, finishers: 1, stake: 5, each: 19, revenue: 1 },
    { members: 2, finishers: 1, stake: 100, fee: 0, each: 200, revenue: 0 },
    { members: 2, finishers: 1, stake: 100, fee: 100, each: 100, revenue: 100 },
  ];
  for (const ex of examples) {
    test(`${ex.members} join at ${ex.stake}, ${ex.finishers} finish (fee ${ex.fee ?? 10}%): each finisher gets ${ex.each}, the app ${ex.revenue}`, async () => {
      const { challenge, users } = await endedChallenge(ex);
      assert.equal(await db.settle(challenge), 'settled');
      for (let i = 0; i < ex.members; i++) {
        assert.equal(await db.balanceOf(users[i]), i < ex.finishers ? ex.each : 0);
      }
      assert.equal(await db.systemBalance('app_revenue'), ex.revenue);
      assert.equal(await db.poolBalance(challenge), 0);
      const c = await db.one(`select status from challenges where id = $1`, [challenge]);
      assert.equal(c.status, 'settled');
    });
  }

  test('settling twice pays nothing extra', async () => {
    const { challenge, users } = await endedChallenge({ members: 4, finishers: 3, stake: 100 });
    assert.equal(await db.settle(challenge), 'settled');
    assert.equal(await db.settle(challenge), 'already settled');
    assert.equal(await db.settle(challenge), 'already settled');
    assert.equal(await db.balanceOf(users[0]), 130);
    assert.equal(await db.systemBalance('app_revenue'), 10);
    const n = await db.one(`select count(*)::int as n from ledger_transactions where kind = 'settlement'`);
    assert.equal(n.n, 1);
  });

  test('two settlements at the same moment pay once', async () => {
    const { challenge, users } = await endedChallenge({ members: 4, finishers: 3, stake: 100 });
    const [c1, c2] = [await db.connect(), await db.connect()];
    const results = await Promise.all([db.settle(challenge, c1), db.settle(challenge, c2)]);
    assert.deepEqual(results.sort(), ['already settled', 'settled']);
    assert.equal(await db.balanceOf(users[0]), 130);
    assert.equal(await db.systemBalance('app_revenue'), 10);
  });

  test('a settlement that is undone leaves no trace, and can be done later', async () => {
    const { challenge, users } = await endedChallenge({ members: 4, finishers: 3, stake: 100 });
    const c = await db.connect();
    await c.query('begin');
    await c.query(`set local role service_role`);
    await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    assert.equal((await c.query(`select settle_challenge($1) as r`, [challenge])).rows[0].r, 'settled');
    await c.query('rollback'); // e.g. the server crashed before commit
    assert.equal(await db.balanceOf(users[0]), 0);
    assert.equal(await db.poolBalance(challenge), 400);
    assert.equal((await db.one(`select status from challenges where id = $1`, [challenge])).status, 'refereeing');
    assert.equal(await db.settle(challenge), 'settled');
    assert.equal(await db.balanceOf(users[0]), 130);
  });

  test('settlement waits until the challenge is in refereeing and every result is decided', async () => {
    const creator = await db.createUser('creator');
    const challenge = await db.createChallenge({ creator, stake: 10 });
    const ana = await db.createUser('Ana');
    await db.give(ana, 10);
    await db.join(ana, challenge);
    await assert.rejects(db.settle(challenge), /only be settled from refereeing/);
    await db.setStatus(challenge, 'active');
    await assert.rejects(db.settle(challenge), /only be settled from refereeing/);
    await db.setStatus(challenge, 'refereeing');
    await assert.rejects(db.settle(challenge), /finished or forfeited/);
    assert.equal(await db.poolBalance(challenge), 10);
    await assert.rejects(db.settle(randomUUID()), /no such challenge/);
  });

  test('settlement refuses a pool that does not match the stakes', async () => {
    const { challenge } = await endedChallenge({ members: 2, finishers: 1, stake: 100 });
    // Simulate a corrupted member list: a member row without a stake.
    const ghost = await db.createUser('ghost');
    await db.owner.query(
      `insert into challenge_members (challenge_id, user_id, time_zone, result) values ($1, $2, 'UTC', 'finished')`,
      [challenge, ghost],
    );
    await assert.rejects(db.settle(challenge), /pool holds 200 but 3 members staked 100/);
    assert.equal(await db.poolBalance(challenge), 200);
    assert.equal((await db.one(`select status from challenges where id = $1`, [challenge])).status, 'refereeing');
  });

  test('the app cannot start a settlement, only the server can', async () => {
    const { challenge, users } = await endedChallenge({ members: 2, finishers: 1, stake: 100 });
    const admin = await db.createUser('owner', { role: 'admin' });
    for (const who of [users[0], admin]) {
      await assert.rejects(db.as(who, (c) => c.query(`select settle_challenge($1)`, [challenge])), /permission denied/);
    }
  });
});

describe('ledger safety rules', () => {
  test('the phone cannot write to the ledger directly', async () => {
    const ana = await db.createUser('Ana');
    await db.give(ana, 100);
    const wallet = (await db.one(`select id from ledger_accounts where user_id = $1`, [ana])).id;
    const tx = (await db.one(`select id from ledger_transactions limit 1`)).id;

    const attempts = [
      [`insert into ledger_transactions (kind, idempotency_key) values ('gift', 'x')`],
      [`insert into ledger_entries (transaction_id, account_id, amount) values ($1, $2, 1000)`, [tx, wallet]],
      [`insert into ledger_accounts (kind, user_id) values ('wallet', $1)`, [ana]],
      [`update ledger_entries set amount = 1000`],
      [`delete from ledger_entries`],
      [`select ledger_begin('gift', 'y', null, '', null)`],
      [`select ledger_post($1, $2, 1000)`, [tx, wallet]],
      [`select ledger_wallet($1)`, [ana]],
      [`select ledger_pool($1)`, [randomUUID()]],
      [`update profiles set role = 'admin'`],
      [`insert into challenges (creator_id, title, stake) values ($1, 'mine', 1)`, [ana]],
      [`update challenges set status = 'settled'`],
      [`update challenge_members set result = 'finished'`],
      [`insert into challenge_members (challenge_id, user_id, time_zone) values ($1, $2, 'UTC')`, [randomUUID(), ana]],
    ];
    for (const [sql, params] of attempts) {
      await assert.rejects(db.as(ana, (c) => c.query(sql, params)), /permission denied/, sql);
    }
    assert.equal(await db.balanceOf(ana), 100);
  });

  test('functions added later are closed to the app until a migration opens them', async () => {
    await db.owner.query(`create function public.later() returns int language sql as 'select 1'`);
    const ana = await db.createUser('Ana');
    await assert.rejects(db.as(ana, (c) => c.query(`select later()`)), /permission denied/);
    await db.owner.query('begin');
    await db.owner.query('set local role anon');
    await assert.rejects(db.owner.query(`select later()`), /permission denied/);
    await db.owner.query('rollback');
  });

  test('signed-out visitors can read nothing', async () => {
    const ana = await db.createUser('Ana');
    await db.give(ana, 100);
    await db.owner.query('begin');
    await db.owner.query('set local role anon');
    for (const table of ['ledger_entries', 'ledger_accounts', 'ledger_transactions', 'ledger_balances', 'profiles', 'challenges', 'challenge_members']) {
      await db.owner.query('savepoint s');
      await assert.rejects(db.owner.query(`select * from ${table}`), /permission denied/, table);
      await db.owner.query('rollback to savepoint s');
    }
    await db.owner.query('rollback');
  });

  test("you can only see your own wallet and profile, not someone else's", async () => {
    const ana = await db.createUser('Ana');
    const ben = await db.createUser('Ben');
    await db.give(ana, 100);
    await db.give(ben, 200);
    const seen = await db.as(ana, async (c) => (await c.query(`select user_id, balance::int from ledger_balances`)).rows);
    assert.deepEqual(seen, [{ user_id: ana, balance: 100 }]);
    const entries = await db.as(ana, async (c) => (await c.query(`select amount::int from ledger_entries`)).rows);
    assert.deepEqual(entries, [{ amount: 100 }]);
    const profiles = await db.as(ana, async (c) => (await c.query(`select id from profiles`)).rows);
    assert.deepEqual(profiles, [{ id: ana }]);
  });

  test('members see their challenge and its pool; outsiders see neither', async () => {
    const ana = await db.createUser('Ana');
    const ben = await db.createUser('Ben');
    const creator = await db.createUser('creator');
    await db.give(ana, 100);
    const challenge = await db.createChallenge({ creator, stake: 40 });
    await db.join(ana, challenge);
    const rows = async (who) =>
      db.as(who, async (c) => ({
        pools: (await c.query(`select balance::int from ledger_balances where kind = 'pool'`)).rows,
        challenges: (await c.query(`select id from challenges`)).rows,
        members: (await c.query(`select user_id from challenge_members`)).rows,
      }));
    assert.deepEqual(await rows(ana), { pools: [{ balance: 40 }], challenges: [{ id: challenge }], members: [{ user_id: ana }] });
    assert.deepEqual(await rows(creator), { pools: [], challenges: [{ id: challenge }], members: [] });
    assert.deepEqual(await rows(ben), { pools: [], challenges: [], members: [] });
  });

  test('entries can never be changed or deleted, even by the database owner', async () => {
    const ana = await db.createUser('Ana');
    await db.give(ana, 100);
    await assert.rejects(db.owner.query(`update ledger_entries set amount = amount * 10`), /append-only/);
    await assert.rejects(db.owner.query(`delete from ledger_entries`), /append-only/);
    await assert.rejects(db.owner.query(`truncate ledger_entries cascade`), /append-only/);
    await assert.rejects(db.owner.query(`update ledger_transactions set note = 'x'`), /append-only/);
    await assert.rejects(db.owner.query(`delete from ledger_transactions`), /append-only/);
    assert.equal(await db.balanceOf(ana), 100);
  });

  test('an unbalanced or empty transaction is refused, even from the database owner', async () => {
    const ana = await db.createUser('Ana');
    await db.owner.query('begin');
    const tx = (
      await db.owner.query(`insert into ledger_transactions (kind, idempotency_key) values ('gift', 'oops') returning id`)
    ).rows[0].id;
    await db.owner.query(`insert into ledger_entries (transaction_id, account_id, amount) values ($1, ledger_wallet($2), 999)`, [tx, ana]);
    await assert.rejects(db.owner.query('commit'), /not balanced/);
    assert.equal(await db.balanceOf(ana), 0);

    await db.owner.query('begin');
    await db.owner.query(`insert into ledger_transactions (kind, idempotency_key) values ('gift', 'empty')`);
    await assert.rejects(db.owner.query('commit'), /not balanced/);
    assert.equal((await db.one(`select count(*)::int as n from ledger_transactions`)).n, 0);
  });

  test('a wallet cannot go below zero, even from the database owner', async () => {
    const ana = await db.createUser('Ana');
    await db.give(ana, 100);
    await db.owner.query('begin');
    const tx = (
      await db.owner.query(`insert into ledger_transactions (kind, idempotency_key) values ('correction', 'c1') returning id`)
    ).rows[0].id;
    await db.owner.query(
      `insert into ledger_entries (transaction_id, account_id, amount)
       values ($1, ledger_wallet($2), -150), ($1, ledger_system_account('app_revenue'), 150)`,
      [tx, ana],
    );
    await assert.rejects(db.owner.query('commit'), /not enough tokens/);
    assert.equal(await db.balanceOf(ana), 100);
  });

  test('spends at the same moment cannot overdraw a wallet, even from the database owner', async () => {
    // Raw inserts skip the app functions (and their orderly locking), so this
    // proves the table rule alone holds: at most two of four 40-token spends
    // from a 100-token wallet can go through, whatever order they run in.
    const ana = await db.createUser('Ana');
    await db.give(ana, 100);
    const spend = async (key) => {
      const c = await db.connect();
      await c.query('begin');
      try {
        const tx = (
          await c.query(`insert into ledger_transactions (kind, idempotency_key) values ('correction', $1) returning id`, [key])
        ).rows[0].id;
        await c.query(
          `insert into ledger_entries (transaction_id, account_id, amount)
           values ($1, ledger_wallet($2), -40), ($1, ledger_system_account('app_revenue'), 40)`,
          [tx, ana],
        );
        await c.query('commit');
      } catch (err) {
        await c.query('rollback');
        throw err;
      }
    };
    const results = await Promise.allSettled(['c1', 'c2', 'c3', 'c4'].map(spend));
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    assert.ok(succeeded <= 2, `${succeeded} spends went through`);
    for (const r of results) {
      if (r.status === 'rejected') assert.match(r.reason.message, /not enough tokens|deadlock detected/);
    }
    assert.equal(await db.balanceOf(ana), 100 - 40 * succeeded);
  });

  test('entries cannot be added to an older transaction', async () => {
    const ana = await db.createUser('Ana');
    await db.give(ana, 100);
    const tx = (await db.one(`select id from ledger_transactions limit 1`)).id;
    await assert.rejects(
      db.owner.query(`insert into ledger_entries (transaction_id, account_id, amount) values ($1, ledger_wallet($2), 5)`, [tx, ana]),
      /together with their ledger transaction/,
    );
  });

  test('a challenge status never goes back', async () => {
    const creator = await db.createUser('creator');
    const challenge = await db.createChallenge({ creator, stake: 10, status: 'active' });
    await assert.rejects(db.setStatus(challenge, 'open'), /cannot go back/);
    await assert.rejects(db.setStatus(challenge, 'draft'), /cannot go back/);
    await db.setStatus(challenge, 'refereeing');
  });
});

describe('many challenges at random', () => {
  // A small deterministic random number generator, so a failure can be replayed.
  function rng(seed) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  for (const seed of [1, 2, 3]) {
    test(`seed ${seed}: every balance matches the rules in PRODUCT.md`, async () => {
      const random = rng(seed);
      const pick = (n) => Math.floor(random() * n);
      const expected = new Map(); // user -> expected wallet balance
      let expectedRevenue = 0;

      const users = [];
      for (let i = 0; i < 6; i++) {
        const u = await db.createUser(`u${i}`);
        const gift = pick(4) * 100;
        if (gift > 0) await db.give(u, gift);
        expected.set(u, gift);
        users.push(u);
      }

      for (let round = 0; round < 5; round++) {
        const stake = 10 + pick(90);
        const challenge = await db.createChallenge({ creator: users[0], stake, title: `Round ${round}` });
        const members = new Set();
        for (const u of users) {
          if (random() < 0.7) {
            if (expected.get(u) >= stake) {
              await db.join(u, challenge);
              expected.set(u, expected.get(u) - stake);
              members.add(u);
            } else {
              await assert.rejects(db.join(u, challenge), /not enough tokens/);
            }
          }
        }
        for (const u of [...members]) {
          if (random() < 0.2) {
            await db.as(u, (c) => c.query(`select leave_challenge($1)`, [challenge]));
            expected.set(u, expected.get(u) + stake);
            members.delete(u);
          }
        }
        await db.setStatus(challenge, 'active');
        const finishers = [];
        for (const u of members) {
          if (random() < 0.2) {
            await db.as(u, (c) => c.query(`select quit_challenge($1)`, [challenge]));
          } else if (random() < 0.6) {
            await db.setResult(challenge, u, 'finished');
            finishers.push(u);
          } else {
            await db.setResult(challenge, u, 'forfeited');
          }
        }
        await db.setStatus(challenge, 'refereeing');
        assert.match(await db.settle(challenge), /settled/);

        // PRODUCT.md 8.1 to 8.3, computed independently of the database.
        const forfeited = stake * (members.size - finishers.length);
        const fee = Math.floor((forfeited * 10) / 100);
        const share = finishers.length ? Math.floor((forfeited - fee) / finishers.length) : 0;
        for (const u of finishers) expected.set(u, expected.get(u) + stake + share);
        expectedRevenue += stake * members.size - (stake + share) * finishers.length;
        assert.equal(await db.poolBalance(challenge), 0);
      }

      for (const u of users) assert.equal(await db.balanceOf(u), expected.get(u), `wallet of ${u}`);
      assert.equal(await db.systemBalance('app_revenue'), expectedRevenue);
    });
  }
});
