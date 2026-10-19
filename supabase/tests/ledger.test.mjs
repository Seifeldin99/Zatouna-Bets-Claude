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
  test('a new user gets a profile and starts at 0 tokens', async () => {
    const ana = await db.createUser('Ana');
    const profile = await db.one(`select display_name, role from profiles where id = $1`, [ana]);
    assert.deepEqual(profile, { display_name: 'Ana', role: 'member' });
    assert.equal(await db.balanceOf(ana), 0);
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
    for (let i = 0; i < 3; i++) {
      await db.as(admin, (c) => c.query(`select admin_grant_tokens($1, 500, 'Welcome', $2)`, [ana, request]));
    }
    assert.equal(await db.balanceOf(ana), 500);
  });

  test('a normal member cannot give tokens, not even to themselves', async () => {
    const ana = await db.createUser('Ana');
    await assert.rejects(
      db.as(ana, (c) => c.query(`select admin_grant_tokens($1, 500, 'free', $2)`, [ana, randomUUID()])),
      /only the admin/,
    );
    assert.equal(await db.balanceOf(ana), 0);
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
    assert.equal(await db.balanceOf(people[10]), 100);
  });

  test('leaving before the start gives the stake back; rejoining works', async () => {
    const ana = await db.createUser('Ana');
    await db.give(ana, 100);
    const challenge = await db.createChallenge({ creator: ana, stake: 100 });
    await db.join(ana, challenge);
    await db.as(ana, (c) => c.query(`select leave_challenge($1)`, [challenge]));
    assert.equal(await db.balanceOf(ana), 100);
    assert.equal(await db.poolBalance(challenge), 0);

    await db.join(ana, challenge);
    assert.equal(await db.balanceOf(ana), 0);
  });

  test('after the start you cannot leave, but you can quit and lose the stake', async () => {
    const ana = await db.createUser('Ana');
    await db.give(ana, 100);
    const challenge = await db.createChallenge({ creator: ana, stake: 100 });
    await db.join(ana, challenge);
    await db.setStatus(challenge, 'active');
    await assert.rejects(
      db.as(ana, (c) => c.query(`select leave_challenge($1)`, [challenge])),
      /only leave before/,
    );
    await db.as(ana, (c) => c.query(`select quit_challenge($1)`, [challenge]));
    const m = await db.one(`select result from challenge_members where user_id = $1`, [ana]);
    assert.equal(m.result, 'forfeited');
    assert.equal(await db.balanceOf(ana), 0);
  });
});

describe('settlement', () => {
  // The examples from ARCHITECTURE.md, "The token ledger".
  const examples = [
    { members: 4, finishers: 3, stake: 100, each: 130, revenue: 10 },
    { members: 4, finishers: 2, stake: 100, each: 190, revenue: 20 },
    { members: 5, finishers: 2, stake: 50, each: 117, revenue: 16 },
    { members: 3, finishers: 0, stake: 50, each: 0, revenue: 150 },
    { members: 3, finishers: 3, stake: 50, each: 50, revenue: 0 },
  ];
  for (const ex of examples) {
    test(`${ex.members} join at ${ex.stake}, ${ex.finishers} finish: each finisher gets ${ex.each}, the app ${ex.revenue}`, async () => {
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

  test('settlement waits until the challenge is in refereeing and every result is decided', async () => {
    const creator = await db.createUser('creator');
    const challenge = await db.createChallenge({ creator, stake: 10 });
    const ana = await db.createUser('Ana');
    await db.give(ana, 10);
    await db.join(ana, challenge);
    await db.setStatus(challenge, 'active');
    await assert.rejects(db.settle(challenge), /only be settled from refereeing/);
    await db.setStatus(challenge, 'refereeing');
    await assert.rejects(db.settle(challenge), /finished or forfeited/);
    assert.equal(await db.poolBalance(challenge), 10);
  });

  test('the app cannot start a settlement, only the server can', async () => {
    const { challenge, users } = await endedChallenge({ members: 2, finishers: 1, stake: 100 });
    await assert.rejects(
      db.as(users[0], (c) => c.query(`select settle_challenge($1)`, [challenge])),
      /permission denied/,
    );
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
      [`update ledger_entries set amount = 1000`],
      [`delete from ledger_entries`],
      [`select ledger_post($1, $2, 1000)`, [tx, wallet]],
      [`select ledger_wallet($1)`, [ana]],
      [`update profiles set role = 'admin'`],
      [`update challenge_members set result = 'finished'`],
    ];
    for (const [sql, params] of attempts) {
      await assert.rejects(db.as(ana, (c) => c.query(sql, params)), /permission denied/, sql);
    }
    assert.equal(await db.balanceOf(ana), 100);
  });

  test('signed-out visitors can read nothing', async () => {
    const ana = await db.createUser('Ana');
    await db.give(ana, 100);
    await db.owner.query('begin');
    await db.owner.query('set local role anon');
    for (const table of ['ledger_entries', 'ledger_accounts', 'ledger_transactions', 'profiles', 'challenges']) {
      await db.owner.query('savepoint s');
      await assert.rejects(db.owner.query(`select * from ${table}`), /permission denied/, table);
      await db.owner.query('rollback to savepoint s');
    }
    await db.owner.query('rollback');
  });

  test("you can only see your own wallet, not someone else's", async () => {
    const ana = await db.createUser('Ana');
    const ben = await db.createUser('Ben');
    await db.give(ana, 100);
    await db.give(ben, 200);
    const seen = await db.as(ana, async (c) => (await c.query(`select user_id, balance::int from ledger_balances`)).rows);
    assert.deepEqual(seen, [{ user_id: ana, balance: 100 }]);
  });

  test('members can see their challenge pool', async () => {
    const ana = await db.createUser('Ana');
    await db.give(ana, 100);
    const challenge = await db.createChallenge({ creator: ana, stake: 40 });
    await db.join(ana, challenge);
    const pool = await db.as(ana, async (c) =>
      (await c.query(`select balance::int from ledger_balances where kind = 'pool'`)).rows,
    );
    assert.deepEqual(pool, [{ balance: 40 }]);
  });

  test('entries can never be changed or deleted, even by the database owner', async () => {
    const ana = await db.createUser('Ana');
    await db.give(ana, 100);
    await assert.rejects(db.owner.query(`update ledger_entries set amount = amount * 10`), /append-only/);
    await assert.rejects(db.owner.query(`delete from ledger_entries`), /append-only/);
    await assert.rejects(db.owner.query(`truncate ledger_entries cascade`), /append-only/);
    await assert.rejects(db.owner.query(`delete from ledger_transactions`), /append-only/);
    assert.equal(await db.balanceOf(ana), 100);
  });

  test('an unbalanced transaction is refused, even from the database owner', async () => {
    const ana = await db.createUser('Ana');
    await db.owner.query('begin');
    const tx = (
      await db.owner.query(`insert into ledger_transactions (kind, idempotency_key) values ('gift', 'oops') returning id`)
    ).rows[0].id;
    await db.owner.query(`insert into ledger_entries (transaction_id, account_id, amount) values ($1, ledger_wallet($2), 999)`, [
      tx,
      ana,
    ]);
    await assert.rejects(db.owner.query('commit'), /not balanced/);
    assert.equal(await db.balanceOf(ana), 0);
  });

  test('entries cannot be added to an older transaction', async () => {
    const ana = await db.createUser('Ana');
    await db.give(ana, 100);
    const tx = (await db.one(`select id from ledger_transactions limit 1`)).id;
    await assert.rejects(
      db.owner.query(`insert into ledger_entries (transaction_id, account_id, amount) values ($1, ledger_wallet($2), 5)`, [
        tx,
        ana,
      ]),
      /together with their ledger transaction/,
    );
  });

  test('a challenge status never goes back', async () => {
    const creator = await db.createUser('creator');
    const challenge = await db.createChallenge({ creator, stake: 10, status: 'active' });
    await assert.rejects(db.setStatus(challenge, 'open'), /cannot go back/);
  });
});
