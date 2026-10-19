// Tests for the end of a challenge (supabase/migrations/*_end_of_challenge.sql):
// when it ends, the referee time limits, who finished, the payout, the
// results and the token history. Run with `npm run test:db`.
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

async function today(tz = TZ) {
  const { d } = await db.one(`select to_char((now() at time zone $1)::date, 'YYYY-MM-DD') as d`, [tz]);
  return d;
}

// The owner's three numbers, and the fee. Defaults: 1 hour to call, 6 hours
// to finalize, 48 hours per case, 0% fee during testing.
async function settings({ call, finalize, caseHours, fee } = {}) {
  await db.owner.query(
    `update app_settings set
       app_fee_percent = coalesce($1, app_fee_percent),
       referee_case_hours = coalesce($2, referee_case_hours),
       referee_call_hours_after_end = coalesce($3, referee_call_hours_after_end),
       finalize_hours_after_end = coalesce($4, finalize_hours_after_end)`,
    [fee ?? null, caseHours ?? null, call ?? null, finalize ?? null],
  );
}

async function user(name, tokens = 100, opts = {}) {
  const id = await db.createUser(name, opts);
  if (tokens > 0) await db.give(id, tokens);
  return id;
}

// A Pet Cat challenge starting today, created (and joined) by `creator`.
async function newChallenge(creator, { lengthDays = 1, missesAllowed = 0, stake = 100, times = 7 } = {}) {
  return db.as(
    creator,
    async (c) =>
      (
        await c.query(`select create_challenge('pet_cat', $1, $2, $3, $4, $5, $6) as id`, [
          times,
          await today(),
          lengthDays,
          stake,
          missesAllowed,
          TZ,
        ])
      ).rows[0].id,
  );
}

async function joinAs(userId, challengeId, tz = TZ) {
  return db.as(
    userId,
    async (c) => (await c.query(`select join_challenge($1, $2) as id`, [challengeId, tz])).rows[0].id,
  );
}

// A check-in for today with the AI's verdict. Returns the check-in id.
async function checkIn(userId, challengeId, label = 'likely_ok', note = '') {
  const r = await db.as(
    userId,
    async (c) => (await c.query(`select begin_check_in($1, $2) as r`, [challengeId, note])).rows[0].r,
  );
  await db.as('service_role', (c) =>
    c.query(`select finish_check_in($1, $2, 'Test verdict.', 'test-model', 20)`, [r.id, label]),
  );
  return r.id;
}

async function callReferee(userId, checkInId, explanation = 'The cat is there, look at the tail.') {
  return db.as(
    userId,
    async (c) => (await c.query(`select open_referee_case($1, $2) as id`, [checkInId, explanation])).rows[0].id,
  );
}

async function decide(userId, caseId, accept, reason = 'Looked again.') {
  return db.as(
    userId,
    async (c) => (await c.query(`select decide_referee_case($1, $2, $3) as d`, [caseId, accept, reason])).rows[0].d,
  );
}

// Moves the whole challenge `days` into the past, check-ins and cases
// included, so its last day is over. Bypasses the guards the way a clock would.
async function shiftBack(challengeId, days) {
  await db.owner.query(`alter table check_ins disable trigger check_ins_guard`);
  await db.owner.query(`alter table referee_cases disable trigger referee_cases_guard`);
  await db.owner.query(`update challenges set start_date = start_date - $2::int where id = $1`, [challengeId, days]);
  await db.owner.query(`update check_ins set day = day - $2::int where challenge_id = $1`, [challengeId, days]);
  await db.owner.query(`update referee_cases set day = day - $2::int where challenge_id = $1`, [challengeId, days]);
  await db.owner.query(`alter table check_ins enable trigger check_ins_guard`);
  await db.owner.query(`alter table referee_cases enable trigger referee_cases_guard`);
}

// What the minute job does: end, accept stale cases, settle what is ready.
async function finish() {
  return db.as('service_role', async (c) => (await c.query(`select finish_due_challenges() as r`)).rows[0].r);
}

async function statusOf(challengeId) {
  return (await db.one(`select status from challenges where id = $1`, [challengeId])).status;
}

async function results(userId, challengeId) {
  return db.as(userId, async (c) => (await c.query(`select challenge_results($1) as r`, [challengeId])).rows[0].r);
}

async function outcomes(userId) {
  return db.as(userId, async (c) => (await c.query(`select my_outcomes() as r`)).rows[0].r);
}

async function history(userId) {
  return db.as(userId, async (c) => (await c.query(`select my_token_history() as r`)).rows[0].r);
}

async function queue(userId) {
  return db.as(userId, async (c) => (await c.query(`select referee_queue() as q`)).rows[0].q);
}

describe('when a challenge ends', () => {
  test('a challenge ends at the last midnight of the member furthest west', async () => {
    const ana = await user('Ana');
    const ben = await user('Ben');
    const chloe = await user('Chloe');
    const challenge = await newChallenge(ana, { lengthDays: 3 });
    await joinAs(ben, challenge, 'Pacific/Honolulu');
    await joinAs(chloe, challenge, 'Asia/Tokyo');
    const row = await db.one(
      `select challenge_ends_at(c) = challenge_starts_at(c.start_date + c.length_days, 'Pacific/Honolulu') as west,
              challenge_ends_at(c) > challenge_starts_at(c.start_date + c.length_days, 'Asia/Tokyo') as later_than_east,
              challenge_finalizes_at(c) = challenge_ends_at(c) + interval '6 hours' as six_hours
       from challenges c where c.id = $1`,
      [challenge],
    );
    assert.deepEqual(row, { west: true, later_than_east: true, six_hours: true });
    const ends = await db.one(
      `select member_ends_at(m, c) = challenge_starts_at(c.start_date + c.length_days, m.time_zone) as own
       from challenge_members m join challenges c on c.id = m.challenge_id where m.user_id = $1`,
      [chloe],
    );
    assert.equal(ends.own, true);
  });

  test("once every member's last day is over, the challenge moves on by itself", async () => {
    const ana = await user('Ana');
    const challenge = await newChallenge(ana, { lengthDays: 1 });
    assert.equal(await statusOf(challenge), 'active', 'a challenge for today starts at once');
    let r = await finish();
    assert.equal(r.ended, 0, 'the last day is still running');
    assert.equal(await statusOf(challenge), 'active');
    await shiftBack(challenge, 2);
    r = await finish();
    assert.equal(r.ended, 1);
    assert.notEqual(await statusOf(challenge), 'active');
    assert.equal((await finish()).ended, 0, 'ended only once');
  });

  test('the referee can be called 24 hours after a verdict, but on the last day only until the cut-off', async () => {
    const ana = await user('Ana', 200);
    // A week-long challenge on its fourth day: the 24 hours apply, the cut-off is far away.
    const running = await newChallenge(ana, { lengthDays: 7, missesAllowed: 6 });
    const earlier = await checkIn(ana, running, 'likely_not_ok');
    await shiftBack(running, 3);
    await settings({ call: 0 });
    await callReferee(ana, earlier);
    // A one-day challenge whose day ended at last midnight.
    const ended = await newChallenge(ana, { lengthDays: 1 });
    const lastDay = await checkIn(ana, ended, 'likely_not_ok');
    await shiftBack(ended, 1);
    await assert.rejects(callReferee(ana, lastDay), /until 0 hours after your last midnight/);
    await settings({ call: 48, finalize: 48 });
    await callReferee(ana, lastDay);
    const rc = await db.one(`select decision from referee_cases where check_in_id = $1`, [lastDay]);
    assert.equal(rc.decision, 'open');
  });

  test('a case expires 48 hours after it is sent, or when the challenge finalizes, whichever is sooner', async () => {
    const ana = await user('Ana', 200);
    const week = await newChallenge(ana, { lengthDays: 7, missesAllowed: 6 });
    const weekCase = await callReferee(ana, await checkIn(ana, week, 'likely_not_ok'));
    const day = await newChallenge(ana, { lengthDays: 1 });
    const dayCase = await callReferee(ana, await checkIn(ana, day, 'likely_not_ok'));
    const rows = await db.one(
      `select
         (select expires_at = created_at + interval '48 hours' from referee_cases where id = $1) as week_limit,
         (select r.expires_at = challenge_finalizes_at(c) from referee_cases r join challenges c on c.id = r.challenge_id where r.id = $2) as day_limit`,
      [weekCase, dayCase],
    );
    assert.deepEqual(rows, { week_limit: true, day_limit: true });
    // The limit is fixed when the case is sent; nobody edits it afterwards.
    await assert.rejects(
      db.owner.query(`update referee_cases set expires_at = now() where id = $1`, [weekCase]),
      /cannot be changed/,
    );
  });

  test('the queue shows the case that expires soonest first, with its limit', async () => {
    const ana = await user('Ana');
    const ben = await user('Ben');
    const admin = await user('Seif', 0, { role: 'admin' });
    const challenge = await newChallenge(ana, { lengthDays: 7, missesAllowed: 6 });
    await joinAs(ben, challenge);
    const slow = await callReferee(ana, await checkIn(ana, challenge, 'likely_not_ok'));
    await settings({ caseHours: 1 });
    const soon = await callReferee(ben, await checkIn(ben, challenge, 'likely_not_ok'));
    const q = await queue(admin);
    assert.deepEqual(
      q.map((c) => c.id),
      [soon, slow],
    );
    assert.ok(q[0].expires_at < q[1].expires_at);
    assert.equal(q[0].challenge_status, 'active');
    await decide(admin, slow, false, 'No cat.');
    assert.deepEqual(
      (await queue(admin)).map((c) => c.decision),
      ['open', 'rejected'],
      'open cases first',
    );
  });
});

describe('the payout', () => {
  // Ana and Ben, 100 each, one day. Ana's photo was accepted; Ben's was not.
  async function twoMembers({ fee = 0 } = {}) {
    await settings({ fee });
    const ana = await user('Ana');
    const ben = await user('Ben');
    const challenge = await newChallenge(ana, { lengthDays: 1 });
    await joinAs(ben, challenge);
    await checkIn(ana, challenge, 'likely_ok');
    const bensCheckIn = await checkIn(ben, challenge, 'likely_not_ok');
    return { ana, ben, challenge, bensCheckIn };
  }

  test('finishers get their stake back and split the forfeited stakes; no fee during testing', async () => {
    const { ana, ben, challenge } = await twoMembers();
    await shiftBack(challenge, 2);
    await settings({ call: 0, finalize: 0 });
    const r = await finish();
    assert.deepEqual(r, { ended: 1, cases_accepted: 0, settled: 1, failed: 0 });
    assert.equal(await statusOf(challenge), 'settled');
    assert.equal(await db.balanceOf(ana), 200);
    assert.equal(await db.balanceOf(ben), 0);
    assert.equal(await db.systemBalance('app_revenue'), 0);
    assert.equal(await db.poolBalance(challenge), 0);

    const res = await results(ana, challenge);
    assert.equal(res.status, 'settled');
    assert.equal(res.pool, 200);
    assert.equal(res.forfeited, 100);
    assert.equal(res.app_fee, 0);
    assert.equal(res.leftover, 0);
    assert.equal(res.my_result, 'finished');
    assert.equal(res.my_payout, 200);
    assert.ok(res.settled_at);
    assert.deepEqual(
      res.members.map((m) => [m.name, m.result, m.quit, m.payout, m.mine]),
      [
        ['Ana', 'finished', false, 200, true],
        ['Ben', 'forfeited', false, null, false],
      ],
    );
    assert.deepEqual(
      (await outcomes(ana)).map((o) => [o.result, o.payout, o.net]),
      [['finished', 200, 100]],
    );
    assert.deepEqual(
      (await outcomes(ben)).map((o) => [o.result, o.payout, o.net]),
      [['forfeited', 0, -100]],
    );
    const stranger = await user('Zed');
    await assert.rejects(results(stranger, challenge), /not in this challenge/);
    assert.deepEqual(await outcomes(stranger), []);
  });

  test('with the fee on, the app takes its share of the forfeited stakes', async () => {
    const { ana, ben, challenge } = await twoMembers({ fee: 10 });
    const c = await db.one(`select app_fee_percent from challenges where id = $1`, [challenge]);
    assert.equal(c.app_fee_percent, 10, 'copied from the setting when the challenge was created');
    await shiftBack(challenge, 2);
    await settings({ call: 0, finalize: 0 });
    await finish();
    assert.equal(await db.balanceOf(ana), 190);
    assert.equal(await db.balanceOf(ben), 0);
    assert.equal(await db.systemBalance('app_revenue'), 10);
    const res = await results(ben, challenge);
    assert.equal(res.app_fee, 10);
    assert.equal(res.my_result, 'forfeited');
    assert.equal(res.my_payout, 0);
  });

  test('the payout waits for an open referee case, and runs once it is decided', async () => {
    const { ana, ben, challenge, bensCheckIn } = await twoMembers();
    const admin = await user('Seif', 0, { role: 'admin' });
    const caseId = await callReferee(ben, bensCheckIn);
    await shiftBack(challenge, 2);
    await settings({ call: 0, finalize: 48 });
    let r = await finish();
    assert.deepEqual(r, { ended: 1, cases_accepted: 0, settled: 0, failed: 0 });
    assert.equal(await statusOf(challenge), 'refereeing');
    let res = await results(ben, challenge);
    assert.equal(res.status, 'refereeing');
    assert.equal(res.open_cases, 1);
    assert.equal(res.my_payout, null);
    assert.equal(res.members.find((m) => m.name === 'Ben').result, 'in_progress');
    assert.equal(await db.balanceOf(ana), 0, 'nothing paid yet');

    assert.equal(await decide(admin, caseId, true, 'The tail is there.'), 'accepted');
    r = await finish();
    assert.equal(r.settled, 1);
    assert.equal(await db.balanceOf(ana), 100, 'everyone finished: stakes come back');
    assert.equal(await db.balanceOf(ben), 100);
    assert.equal(await db.systemBalance('app_revenue'), 0);
    res = await results(ben, challenge);
    assert.equal(res.my_result, 'finished');
    assert.equal(res.forfeited, 0);
  });

  test('at the time limit an open case counts as accepted and the pool is paid out', async () => {
    const { ana, ben, challenge, bensCheckIn } = await twoMembers();
    const caseId = await callReferee(ben, bensCheckIn);
    await shiftBack(challenge, 2);
    await settings({ call: 0, finalize: 0 });
    const r = await finish();
    assert.equal(r.settled, 1);
    const rc = await db.one(`select decision, decided_by, reason from referee_cases where id = $1`, [caseId]);
    assert.equal(rc.decision, 'accepted');
    assert.equal(rc.decided_by, null);
    assert.match(rc.reason, /counts as accepted/);
    assert.equal(await db.balanceOf(ana), 100);
    assert.equal(await db.balanceOf(ben), 100);
    await assert.rejects(callReferee(ben, bensCheckIn), /already/);
  });

  test('a member who quit shows as quit; when nobody finishes the pool goes to the app', async () => {
    const ana = await user('Ana');
    const ben = await user('Ben');
    const challenge = await newChallenge(ana, { lengthDays: 7 });
    await joinAs(ben, challenge);
    await db.as(ben, (c) => c.query(`select quit_challenge($1)`, [challenge]));
    await shiftBack(challenge, 8);
    await settings({ call: 0, finalize: 0 });
    await finish();
    const res = await results(ana, challenge);
    assert.deepEqual(
      res.members.map((m) => [m.name, m.result, m.quit, m.payout]),
      [
        ['Ana', 'forfeited', false, null],
        ['Ben', 'forfeited', true, null],
      ],
    );
    assert.equal(res.app_fee, 200);
    assert.equal(await db.systemBalance('app_revenue'), 200);
    assert.deepEqual((await outcomes(ben)).map((o) => o.quit), [true]);
  });

  test('the job settles each challenge once, and a broken one does not block the others', async () => {
    const { ana, challenge } = await twoMembers();
    await db.give(ana, 50);
    const other = await newChallenge(ana, { lengthDays: 1, stake: 50 });
    await checkIn(ana, other, 'likely_ok');
    await shiftBack(challenge, 2);
    await shiftBack(other, 2);
    // Corrupt the second challenge's pool: a member row without a stake.
    const ghost = await user('Ghost', 0);
    await db.owner.query(
      `insert into challenge_members (challenge_id, user_id, time_zone) values ($1, $2, 'UTC')`,
      [other, ghost],
    );
    await settings({ call: 0, finalize: 0 });
    const r = await finish();
    assert.deepEqual(r, { ended: 2, cases_accepted: 0, settled: 1, failed: 1 });
    assert.equal(await statusOf(challenge), 'settled');
    assert.equal(await statusOf(other), 'refereeing', 'left for a human to look at');
    assert.deepEqual(await finish(), { ended: 0, cases_accepted: 0, settled: 0, failed: 1 });
    const n = await db.one(`select count(*)::int as n from ledger_transactions where kind = 'settlement'`);
    assert.equal(n.n, 1);
    assert.equal(await db.balanceOf(ana), 200, 'paid once; the 50 stays in the broken pool');
  });

  test('the app cannot end, sweep or settle; only the server can', async () => {
    const ana = await user('Ana');
    const admin = await user('Seif', 0, { role: 'admin' });
    const challenge = await newChallenge(ana);
    for (const who of [ana, admin]) {
      for (const call of [
        'select end_due_challenges()',
        'select finish_due_challenges()',
        `select settle_challenge('${challenge}')`,
        `select accept_referee_case_by_rule('${challenge}', 'x')`,
      ]) {
        await assert.rejects(db.as(who, (c) => c.query(call)), /permission denied/);
      }
    }
  });
});

describe('the token history', () => {
  test('lists every change to your wallet, newest first, and nobody else’s', async () => {
    await db.owner.query(`update app_settings set welcome_tokens = 1000`);
    const ana = await db.createUser('Ana');
    const ben = await db.createUser('Ben');
    await db.give(ana, 50);
    const challenge = await newChallenge(ana, { lengthDays: 1, stake: 100 });
    await joinAs(ben, challenge);
    await checkIn(ana, challenge, 'likely_ok');
    await shiftBack(challenge, 2);
    await settings({ call: 0, finalize: 0 });
    await finish();

    const lines = await history(ana);
    assert.deepEqual(
      lines.map((l) => [l.kind, l.amount, l.challenge_title]),
      [
        ['settlement', 200, 'Pet Cat'],
        ['stake', -100, 'Pet Cat'],
        ['gift', 50, null],
        ['gift', 1000, null],
      ],
    );
    assert.equal(lines[1].note, 'Stake: Pet Cat');
    assert.equal(lines[3].note, 'Welcome tokens for testing');
    assert.ok(lines.every((l) => l.at && l.id));
    assert.equal(
      lines.reduce((sum, l) => sum + l.amount, 0),
      await db.balanceOf(ana),
      'the balance is the sum of the lines',
    );
    assert.deepEqual(
      (await history(ben)).map((l) => [l.kind, l.amount]),
      [
        ['stake', -100],
        ['gift', 1000],
      ],
    );
    const nobody = await db.as(ben, async (c) => (await c.query(`select my_token_history(1) as r`)).rows[0].r);
    assert.equal(nobody.length, 1);
  });
});
