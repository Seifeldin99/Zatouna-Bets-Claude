// Tests for the referee (supabase/migrations/*_referee.sql).
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
  await db.close();
});

const TZ = 'America/Toronto';

async function today(tz = TZ, plusDays = 0) {
  const { d } = await db.one(`select to_char((now() at time zone $1)::date + $2::int, 'YYYY-MM-DD') as d`, [
    tz,
    plusDays,
  ]);
  return d;
}

// Ana's challenge, started `startedDaysAgo` days ago, with one rejected check-in today.
async function rejectedToday({ lengthDays = 7, missesAllowed = 0, startedDaysAgo = 0 } = {}) {
  const creator = await db.createUser('Ana');
  await db.give(creator, 100);
  const challenge = await db.as(
    creator,
    async (c) =>
      (
        await c.query(`select create_challenge('pet_cat', 7, $1, $2, 10, $3, $4) as id`, [
          await today(),
          lengthDays,
          missesAllowed,
          TZ,
        ])
      ).rows[0].id,
  );
  if (startedDaysAgo > 0) {
    await db.owner.query(`update challenges set start_date = start_date - $2::int where id = $1`, [
      challenge,
      startedDaysAgo,
    ]);
  }
  const { id: member } = await db.one(`select id from challenge_members where challenge_id = $1 and user_id = $2`, [
    challenge,
    creator,
  ]);
  const checkIn = await rejected(creator, challenge, 'The cat was asleep under the blanket.');
  return { creator, challenge, member, checkIn };
}

// Starts a check-in and has the AI reject it. Returns the check-in id.
async function rejected(user, challengeId, note = '') {
  const r = await db.as(
    user,
    async (c) => (await c.query(`select begin_check_in($1, $2) as r`, [challengeId, note])).rows[0].r,
  );
  await db.as('service_role', (c) =>
    c.query(`select finish_check_in($1, 'likely_not_ok', 'No cat is visible.', 'test-model', 20)`, [r.id]),
  );
  return r.id;
}

async function callReferee(user, checkInId, explanation = 'The cat is under the blanket, you can see its tail.') {
  return db.as(
    user,
    async (c) => (await c.query(`select open_referee_case($1, $2) as id`, [checkInId, explanation])).rows[0].id,
  );
}

async function decide(user, caseId, accept, reason = 'Looked again: the tail is there.') {
  return db.as(
    user,
    async (c) => (await c.query(`select decide_referee_case($1, $2, $3) as d`, [caseId, accept, reason])).rows[0].d,
  );
}

// Pretends the verdict came `ago` earlier, bypassing the guard trigger the way a clock would.
async function backdate(checkInId, ago) {
  await db.owner.query(`alter table check_ins disable trigger check_ins_guard`);
  await db.owner.query(`update check_ins set decided_at = now() - $2::interval where id = $1`, [checkInId, ago]);
  await db.owner.query(`alter table check_ins enable trigger check_ins_guard`);
}

async function progress(user, challengeId) {
  return db.as(user, async (c) => (await c.query(`select challenge_progress($1) as p`, [challengeId])).rows[0].p);
}

async function queue(user, caseId = null) {
  return db.as(user, async (c) => (await c.query(`select referee_queue($1) as q`, [caseId])).rows[0].q);
}

function mine(p) {
  return p.members.find((m) => m.mine);
}

describe('calling the referee', () => {
  test('a member contests their own rejected check-in once, with an explanation', async () => {
    const { creator, challenge, checkIn } = await rejectedToday();
    await assert.rejects(callReferee(creator, checkIn, '   '), /short explanation/);
    await assert.rejects(callReferee(creator, checkIn, 'x'.repeat(501)), /500 characters/);

    const caseId = await callReferee(creator, checkIn);
    const row = await db.one(`select decision, reason, explanation, user_id from referee_cases where id = $1`, [caseId]);
    assert.equal(row.decision, 'open');
    assert.equal(row.reason, '');
    assert.equal(row.explanation, 'The cat is under the blanket, you can see its tail.');
    assert.equal(row.user_id, creator);

    await assert.rejects(callReferee(creator, checkIn), /already called/);
    // A second attempt the same day cannot go to the referee while the first case waits.
    const again = await rejected(creator, challenge);
    await assert.rejects(callReferee(creator, again), /already waiting/);
  });

  test('only the member, only a rejected check-in, only within 24 hours', async () => {
    const { creator, challenge, checkIn } = await rejectedToday();
    const ben = await db.createUser('Ben');
    await db.give(ben, 10);
    await db.join(ben, challenge);
    await assert.rejects(callReferee(ben, checkIn), /unknown check-in/);

    // An accepted check-in has nothing to contest; a pending one is not decided yet.
    const r = await db.as(
      ben,
      async (c) => (await c.query(`select begin_check_in($1, '') as r`, [challenge])).rows[0].r,
    );
    await assert.rejects(callReferee(ben, r.id), /only a rejected/);
    await db.as('service_role', (c) => c.query(`select finish_check_in($1, 'likely_ok', 'Fine.', 'm', 1)`, [r.id]));
    await assert.rejects(callReferee(ben, r.id), /only a rejected/);

    // Move the verdict back in time (the guard normally forbids touching decided_at).
    await backdate(checkIn, '25 hours');
    await assert.rejects(callReferee(creator, checkIn), /within 24 hours/);
    await backdate(checkIn, '23 hours');
    await callReferee(creator, checkIn);
  });

  test('once the day is done, there is nothing to contest', async () => {
    const { creator, challenge, checkIn } = await rejectedToday();
    const r = await db.as(
      creator,
      async (c) => (await c.query(`select begin_check_in($1, '') as r`, [challenge])).rows[0].r,
    );
    await db.as('service_role', (c) => c.query(`select finish_check_in($1, 'likely_ok', 'Fine.', 'm', 1)`, [r.id]));
    await assert.rejects(callReferee(creator, checkIn), /already done/);
  });
});

describe('while the case is open', () => {
  test('the day waits for the referee instead of counting as a miss; friends see it once the day is over', async () => {
    // 7 days, 2 misses allowed. Ben joins on the first day; then the challenge is moved
    // two days into the past, so day 1 was missed and yesterday is about to be.
    const { creator, challenge } = await rejectedToday({ missesAllowed: 2 });
    const ben = await db.createUser('Ben');
    await db.give(ben, 10);
    await db.join(ben, challenge);
    await db.owner.query(`update challenges set start_date = start_date - 2 where id = $1`, [challenge]);
    const yesterday = await today(TZ, -1);
    const { id: member } = await db.one(`select id from challenge_members where challenge_id = $1 and user_id = $2`, [challenge, creator]);
    // A rejected attempt yesterday, written straight into the table.
    const { id: old } = await db.one(
      `insert into check_ins (challenge_id, member_id, user_id, day, attempt, photo_path, state, decided_at)
       values ($1::uuid, $2::uuid, $3::uuid, $4::date, 1, $1::text || '/' || $3::text || '/' || gen_random_uuid() || '.jpg', 'rejected', now() - interval '20 hours')
       returning id`,
      [challenge, member, creator, yesterday],
    );
    let p = await progress(creator, challenge);
    assert.equal(mine(p).misses, 2, 'day 1 and yesterday are missed');
    assert.equal(mine(p).misses_left, 0);

    await callReferee(creator, old);
    p = await progress(creator, challenge);
    assert.equal(mine(p).misses, 1, 'yesterday waits for the referee');
    assert.equal(mine(p).misses_left, 1);
    assert.equal(mine(p).days[1].status, 'referee');
    assert.equal(mine(p).days[2].status, 'rejected', "today's attempt is still private");

    const ana = (await progress(ben, challenge)).members.find((m) => m.user_id === creator);
    assert.equal(ana.days[1].status, 'referee', 'friends see a finished day waiting for the referee');
    assert.equal(ana.days[2].status, 'open', 'friends do not see the open day differently');
    assert.equal(ana.misses, 1);

    // Today's rejected attempt can go to the referee too; friends keep seeing "open".
    const todayCase = await db.one(`select id from check_ins where member_id = $1 and day = $2`, [member, await today()]);
    await callReferee(creator, todayCase.id, 'Please look again.');
    p = await progress(creator, challenge);
    assert.equal(mine(p).days[2].status, 'referee');
    assert.equal((await progress(ben, challenge)).members.find((m) => m.user_id === creator).days[2].status, 'open');
    const home = await db.as(creator, async (c) => (await c.query(`select my_today() as t`)).rows[0].t);
    assert.equal(home[0].status, 'referee');
  });

  test('members read only their own cases; the app cannot write them', async () => {
    const { creator, challenge, checkIn } = await rejectedToday();
    const ben = await db.createUser('Ben');
    await db.give(ben, 10);
    await db.join(ben, challenge);
    const caseId = await callReferee(creator, checkIn);
    const see = async (user) =>
      db.as(user, async (c) => (await c.query(`select id from referee_cases`)).rows.map((r) => r.id));
    assert.deepEqual(await see(creator), [caseId]);
    assert.deepEqual(await see(ben), []);
    await assert.rejects(
      db.as(creator, (c) => c.query(`update referee_cases set decision = 'accepted' where id = $1`, [caseId])),
      /permission denied/,
    );
    await assert.rejects(
      db.as(creator, (c) => c.query(`delete from referee_cases where id = $1`, [caseId])),
      /permission denied/,
    );
    assert.equal(await queue(creator), null, 'members get nothing from the support queue');
  });
});

describe('deciding', () => {
  test('support accepts a case: the check-in becomes accepted and the day counts', async () => {
    const { creator, challenge, checkIn } = await rejectedToday();
    const admin = await db.createUser('Seif', { role: 'admin' });
    const caseId = await callReferee(creator, checkIn);

    const open = await queue(admin);
    assert.equal(open.length, 1);
    assert.equal(open[0].id, caseId);
    assert.equal(open[0].challenge_title, 'Pet Cat');
    assert.equal(open[0].note, 'The cat was asleep under the blanket.');
    assert.equal(open[0].ai_reason, 'No cat is visible.');
    assert.equal(open[0].decision, 'open');
    assert.ok(open[0].photo_path);

    assert.equal(await decide(admin, caseId, true), 'accepted');
    const ci = await db.one(`select state from check_ins where id = $1`, [checkIn]);
    assert.equal(ci.state, 'accepted');
    const rc = await db.one(`select decision, reason, decided_by from referee_cases where id = $1`, [caseId]);
    assert.deepEqual(rc, { decision: 'accepted', reason: 'Looked again: the tail is there.', decided_by: admin });
    const p = await progress(creator, challenge);
    assert.equal(mine(p).days[0].status, 'done');
    assert.equal(mine(p).days_done, 1);

    await assert.rejects(decide(admin, caseId, false), /already decided/);
    const one = await queue(admin, caseId);
    assert.equal(one[0].decision, 'accepted');
    // The member sees the decision and the reason.
    const seen = await db.as(
      creator,
      async (c) => (await c.query(`select decision, reason from referee_cases where id = $1`, [caseId])).rows[0],
    );
    assert.deepEqual(seen, { decision: 'accepted', reason: 'Looked again: the tail is there.' });
  });

  test('support rejects a case: the day is missed again', async () => {
    const { creator, challenge, checkIn } = await rejectedToday({ startedDaysAgo: 1, missesAllowed: 1 });
    const support = await db.createUser('Sam', { role: 'support' });
    const caseId = await callReferee(creator, checkIn);
    await assert.rejects(decide(support, caseId, false, ''), /short reason/);
    assert.equal(await decide(support, caseId, false, 'The photo shows a blanket, not a cat.'), 'rejected');
    const ci = await db.one(`select state from check_ins where id = $1`, [checkIn]);
    assert.equal(ci.state, 'rejected');
    const p = await progress(creator, challenge);
    assert.equal(mine(p).days[1].status, 'rejected');
    // The member may still retry today.
    assert.equal(mine(p).can_check_in, true);
  });

  test('only support decides; nobody edits a decided case or a check-in by hand', async () => {
    const { creator, checkIn } = await rejectedToday();
    const ben = await db.createUser('Ben');
    const caseId = await callReferee(creator, checkIn);
    await assert.rejects(decide(creator, caseId, true), /only support/);
    await assert.rejects(decide(ben, caseId, true), /only support/);
    await assert.rejects(
      db.owner.query(`update check_ins set state = 'accepted' where id = $1`, [checkIn]),
      /verdict is final/,
    );
    const admin = await db.createUser('Seif', { role: 'admin' });
    await decide(admin, caseId, true);
    await assert.rejects(
      db.owner.query(`update referee_cases set decision = 'rejected' where id = $1`, [caseId]),
      /decision is final/,
    );
    await assert.rejects(
      db.owner.query(`update referee_cases set explanation = 'x' where id = $1`, [caseId]),
      /cannot be changed/,
    );
  });

  test('a case nobody decided within 48 hours of the end counts as accepted', async () => {
    const { creator, challenge, checkIn } = await rejectedToday({ lengthDays: 1 });
    const caseId = await callReferee(creator, checkIn);
    const sweep = () =>
      db.as('service_role', async (c) => (await c.query(`select accept_stale_referee_cases() as n`)).rows[0].n);
    assert.equal(await sweep(), 0, 'the challenge is still running');
    // End the challenge three days ago.
    await db.owner.query(`update challenges set start_date = start_date - 3 where id = $1`, [challenge]);
    await db.owner.query(`update referee_cases set day = day - 3 where id = $1`, [caseId]).catch(() => {});
    assert.equal(await sweep(), 1);
    const rc = await db.one(`select decision, decided_by, reason from referee_cases where id = $1`, [caseId]);
    assert.equal(rc.decision, 'accepted');
    assert.equal(rc.decided_by, null);
    assert.match(rc.reason, /48 hours/);
    const ci = await db.one(`select state from check_ins where id = $1`, [checkIn]);
    assert.equal(ci.state, 'accepted');
    await assert.rejects(db.as(creator, (c) => c.query(`select accept_stale_referee_cases()`)), /permission denied/);
  });

  test('support sees the photo of a case, and nothing else in the bucket', async () => {
    const { creator, challenge, checkIn } = await rejectedToday();
    const admin = await db.createUser('Seif', { role: 'admin' });
    const ben = await db.createUser('Ben');
    await db.give(ben, 10);
    await db.join(ben, challenge);
    const { photo_path: contested } = await db.one(`select photo_path from check_ins where id = $1`, [checkIn]);
    const other = await rejected(creator, challenge);
    const { photo_path: plain } = await db.one(`select photo_path from check_ins where id = $1`, [other]);
    await db.owner.query(`insert into storage.objects (bucket_id, name) values ('check-ins', $1), ('check-ins', $2)`, [
      contested,
      plain,
    ]);
    const see = async (user) =>
      db.as(user, async (c) => (await c.query(`select name from storage.objects order by name`)).rows.map((o) => o.name));
    assert.deepEqual(await see(admin), [], 'no case yet, no photo');
    await callReferee(creator, checkIn);
    assert.deepEqual(await see(admin), [contested]);
    assert.deepEqual(await see(creator), [contested, plain].sort());
    assert.deepEqual(await see(ben), [], 'a fellow member never sees the photo');
  });
});
