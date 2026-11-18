// Tests for the first-day fixes (supabase/migrations/*_day_one_fixes.sql):
// leaving and deleting close once someone has checked in, joining closes at
// the end of your own first day, and quitting starts on the second day.
// Run with `npm run test:db`.
import { after, before, beforeEach, afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, startServer, stopServer } from './db.mjs';

before(startServer);
after(stopServer);

let db;
beforeEach(async () => {
  db = await freshDb();
});
afterEach(async () => {
  const { total } = await db.one(`select coalesce(sum(amount), 0)::int as total from ledger_entries`);
  assert.equal(total, 0, 'the ledger must always sum to zero');
  const { negative } = await db.one(
    `select count(*)::int as negative from ledger_balances where kind in ('wallet', 'pool') and balance < 0`,
  );
  assert.equal(negative, 0, 'no wallet or pool may be negative');
  await db.close();
});

const TZ = 'America/Toronto';
// UTC-12 and UTC+14 are always on different dates, so these tests don't
// depend on the time of day they run at.
const FAR_WEST = 'Etc/GMT+12';
const FAR_EAST = 'Etc/GMT-14';

async function today(tz = TZ, plusDays = 0) {
  const { d } = await db.one(`select to_char((now() at time zone $1)::date + $2::int, 'YYYY-MM-DD') as d`, [
    tz,
    plusDays,
  ]);
  return d;
}

async function user(name, tokens = 100) {
  const id = await db.createUser(name);
  if (tokens > 0) await db.give(id, tokens);
  return id;
}

// A Pet Cat challenge by `creator`, starting today in their time zone.
async function newChallenge(creator, { tz = TZ, startInDays = 0, stake = 10, misses = 0 } = {}) {
  const start = await today(tz, startInDays);
  return db.as(
    creator,
    async (c) =>
      (await c.query(`select create_challenge('pet_cat', 7, $1, 7, $2, $3, $4) as id`, [start, stake, misses, tz]))
        .rows[0].id,
  );
}

async function joinAs(userId, challengeId, tz = TZ) {
  return db.as(
    userId,
    async (c) => (await c.query(`select join_challenge($1, $2) as id`, [challengeId, tz])).rows[0].id,
  );
}

// A check-in for today with the AI's verdict. Returns the check-in id.
async function checkIn(userId, challengeId, label = 'likely_ok') {
  const r = await db.as(
    userId,
    async (c) => (await c.query(`select begin_check_in($1, '') as r`, [challengeId])).rows[0].r,
  );
  await db.as('service_role', (c) =>
    c.query(`select finish_check_in($1, $2, 'Test verdict.', 'test-model', 20)`, [r.id, label]),
  );
  return r.id;
}

const leave = (userId, challengeId, client) =>
  db.as(userId, (c) => c.query(`select leave_challenge($1)`, [challengeId]), client);
const del = (userId, challengeId, client) =>
  db.as(userId, (c) => c.query(`select delete_challenge($1)`, [challengeId]), client);
const quit = (userId, challengeId) => db.as(userId, (c) => c.query(`select quit_challenge($1)`, [challengeId]));

// Opens a transaction on the owner connection as `userId` and leaves it open,
// so a second call can be made to wait for it.
async function beginAs(userId) {
  await db.owner.query('begin');
  await db.owner.query(`set local role authenticated`);
  await db.owner.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ role: 'authenticated', sub: userId }),
  ]);
}

async function resultOf(userId, challengeId) {
  return (
    await db.one(`select result from challenge_members where challenge_id = $1 and user_id = $2`, [
      challengeId,
      userId,
    ])
  ).result;
}

describe('leaving and deleting on day 1 (QW1)', () => {
  test('a member who checked in cannot leave and keeps their place; one who did not can leave', async () => {
    const ana = await user('Ana');
    const ben = await user('Ben');
    const cy = await user('Cy');
    const challenge = await newChallenge(ana);
    await joinAs(ben, challenge);
    await joinAs(cy, challenge);
    await checkIn(ben, challenge);

    await assert.rejects(leave(ben, challenge), /already checked in, so you can no longer leave/);
    assert.equal(await resultOf(ben, challenge), 'in_progress');
    assert.equal(await db.balanceOf(ben), 90);

    await leave(cy, challenge);
    assert.equal(await db.balanceOf(cy), 100);
    assert.equal(await db.poolBalance(challenge), 20);
  });

  test('a rejected photo counts as having checked in', async () => {
    const ana = await user('Ana');
    const ben = await user('Ben');
    const challenge = await newChallenge(ana);
    await joinAs(ben, challenge);
    await checkIn(ben, challenge, 'likely_not_ok');
    await assert.rejects(leave(ben, challenge), /already checked in/);
    assert.equal(await db.balanceOf(ben), 90);
  });

  test('the creator cannot delete once anyone has checked in, and can before', async () => {
    const ana = await user('Ana');
    const ben = await user('Ben');
    const first = await newChallenge(ana);
    await joinAs(ben, first);
    await checkIn(ben, first);
    await assert.rejects(del(ana, first), /someone has already checked in, so this challenge can no longer be deleted/);
    assert.equal(await db.poolBalance(first), 20);
    assert.equal((await db.one(`select deleted_at from challenges where id = $1`, [first])).deleted_at, null);

    const second = await newChallenge(ana);
    await joinAs(ben, second);
    await del(ana, second);
    assert.equal(await db.balanceOf(ana), 90);
    assert.equal(await db.balanceOf(ben), 90);
  });

  test('a check-in and a leave at the same moment: the leave waits and gets a plain answer', async () => {
    const ana = await user('Ana');
    const ben = await user('Ben');
    const challenge = await newChallenge(ana);
    await joinAs(ben, challenge);
    const other = await db.connect();
    await beginAs(ben);
    await db.owner.query(`select begin_check_in($1, '')`, [challenge]);
    const leaving = leave(ben, challenge, other);
    await new Promise((r) => setTimeout(r, 100));
    await db.owner.query('commit');
    await assert.rejects(leaving, /already checked in/);
    assert.equal(await db.balanceOf(ben), 90);
  });

  test('a leave and a check-in at the same moment: the check-in waits and finds you gone', async () => {
    const ana = await user('Ana');
    const ben = await user('Ben');
    const challenge = await newChallenge(ana);
    await joinAs(ben, challenge);
    const other = await db.connect();
    await beginAs(ben);
    await db.owner.query(`select leave_challenge($1)`, [challenge]);
    const checking = db.as(ben, (c) => c.query(`select begin_check_in($1, '')`, [challenge]), other);
    await new Promise((r) => setTimeout(r, 100));
    await db.owner.query('commit');
    await assert.rejects(checking, /not in this challenge/);
    assert.equal(await db.balanceOf(ben), 100);
  });

  test('a check-in and a delete at the same moment: the delete waits and gets a plain answer', async () => {
    const ana = await user('Ana');
    const ben = await user('Ben');
    const challenge = await newChallenge(ana);
    await joinAs(ben, challenge);
    const other = await db.connect();
    await beginAs(ben);
    await db.owner.query(`select begin_check_in($1, '')`, [challenge]);
    const deleting = del(ana, challenge, other);
    await new Promise((r) => setTimeout(r, 100));
    await db.owner.query('commit');
    await assert.rejects(deleting, /someone has already checked in/);
    assert.equal(await db.poolBalance(challenge), 20);
  });
});

describe('joining closes at the end of your own first day (QW2)', () => {
  test('a friend whose first day is already over cannot join, and keeps their tokens', async () => {
    const ana = await user('Ana');
    const ben = await user('Ben');
    const challenge = await newChallenge(ana, { tz: FAR_WEST });
    await assert.rejects(
      joinAs(ben, challenge, FAR_EAST),
      /your first day of this challenge is already over in your time zone, so you can no longer join/,
    );
    assert.equal(await db.balanceOf(ben), 100);
    assert.equal((await db.one(`select count(*)::int as n from challenge_members where challenge_id = $1`, [challenge])).n, 1);
  });

  test('a friend whose first day has not started yet can join, and is not out', async () => {
    const ana = await user('Ana');
    const ben = await user('Ben');
    const challenge = await newChallenge(ana, { tz: FAR_EAST });
    await joinAs(ben, challenge, FAR_WEST);
    const p = await db.as(ben, async (c) => (await c.query(`select challenge_progress($1) as p`, [challenge])).rows[0].p);
    const mine = p.members.find((m) => m.mine);
    assert.equal(mine.misses, 0);
    assert.equal(mine.out, false);
  });

  test('a friend in the same time zone can join a challenge that starts tomorrow', async () => {
    const ana = await user('Ana');
    const ben = await user('Ben');
    const challenge = await newChallenge(ana, { startInDays: 1 });
    await joinAs(ben, challenge);
    assert.equal(await db.balanceOf(ben), 90);
  });
});

describe('quitting starts on the second day (QW7)', () => {
  test('on day 1 the server refuses to quit and points to leaving; the stake is safe', async () => {
    const ana = await user('Ana');
    const ben = await user('Ben');
    const challenge = await newChallenge(ana);
    await joinAs(ben, challenge);
    await assert.rejects(quit(ben, challenge), /on the first day you can leave instead/);
    assert.equal(await resultOf(ben, challenge), 'in_progress');

    await checkIn(ben, challenge);
    await assert.rejects(quit(ben, challenge), /you can quit from the second day/);
    assert.equal(await resultOf(ben, challenge), 'in_progress');
  });

  test('from day 2 a member can quit and forfeits the stake', async () => {
    const ana = await user('Ana');
    const ben = await user('Ben');
    const challenge = await newChallenge(ana);
    await joinAs(ben, challenge);
    await db.owner.query(`update challenges set start_date = start_date - 1 where id = $1`, [challenge]);
    await quit(ben, challenge);
    assert.equal(await resultOf(ben, challenge), 'forfeited');
  });
});
