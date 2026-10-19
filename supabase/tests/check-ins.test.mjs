// Tests for daily check-ins (supabase/migrations/*_check_ins.sql).
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

// Today's date in a time zone, as the server sees it.
async function today(tz = TZ, plusDays = 0) {
  const { d } = await db.one(`select to_char((now() at time zone $1)::date + $2::int, 'YYYY-MM-DD') as d`, [
    tz,
    plusDays,
  ]);
  return d;
}

// A creator with tokens and a challenge that started `startedDaysAgo` days
// ago (0 = today, so it is active at once).
async function running({ timesPerWeek = 7, lengthDays = 7, missesAllowed = 0, startedDaysAgo = 0, tz = TZ } = {}) {
  const creator = await db.createUser('Ana');
  await db.give(creator, 100);
  const challenge = await db.as(
    creator,
    async (c) =>
      (
        await c.query(`select create_challenge('pet_cat', $1, $2, $3, 10, $4, $5) as id`, [
          timesPerWeek,
          await today(tz),
          lengthDays,
          missesAllowed,
          tz,
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
  return { creator, challenge, member };
}

async function begin(user, challengeId, note = '') {
  return db.as(user, async (c) => (await c.query(`select begin_check_in($1, $2) as r`, [challengeId, note])).rows[0].r);
}

async function finish(id, label, reason = 'Looks right.', model = 'test-model', ms = 25) {
  return db.as(
    'service_role',
    async (c) =>
      (await c.query(`select finish_check_in($1, $2, $3, $4, $5) as v`, [id, label, reason, model, ms])).rows[0].v,
  );
}

async function upload(user, path, bucket = 'check-ins') {
  return db.as(user, (c) => c.query(`insert into storage.objects (bucket_id, name) values ($2, $1)`, [path, bucket]));
}

async function progress(user, challengeId) {
  return db.as(user, async (c) => (await c.query(`select challenge_progress($1) as p`, [challengeId])).rows[0].p);
}

async function myToday(user) {
  return db.as(user, async (c) => (await c.query(`select my_today() as t`)).rows[0].t);
}

// Writes an accepted check-in straight into the table for a past day.
async function acceptedOn(challengeId, memberId, userId, day) {
  await db.owner.query(
    `insert into check_ins (challenge_id, member_id, user_id, day, attempt, photo_path, state, decided_at)
     values ($1::uuid, $2::uuid, $3::uuid, $4::date, 1, $1::text || '/' || $3::text || '/' || gen_random_uuid() || '.jpg', 'accepted', now())`,
    [challengeId, memberId, userId, day],
  );
}

function mine(p) {
  return p.members.find((m) => m.mine);
}

describe('checking in', () => {
  test('a check-in starts pending and is accepted when the AI says likely okay', async () => {
    const { creator, challenge, member } = await running();
    const r = await begin(creator, challenge, '  Reading on the sofa.  ');
    assert.equal(r.day, await today());
    assert.equal(r.attempt, 1);
    assert.equal(r.photo_path, `${challenge}/${creator}/${r.id}.jpg`);
    const row = await db.one(`select * from check_ins where id = $1`, [r.id]);
    assert.equal(row.state, 'pending');
    assert.equal(row.member_id, member);
    assert.equal(row.note, 'Reading on the sofa.');
    assert.equal(row.decided_at, null);

    assert.equal(await finish(r.id, 'likely_ok', 'A cat is clearly visible.'), 'accepted');
    const after = await db.one(`select state, decided_at from check_ins where id = $1`, [r.id]);
    assert.equal(after.state, 'accepted');
    assert.ok(after.decided_at);
    const ai = await db.one(`select * from ai_checks where check_in_id = $1`, [r.id]);
    assert.equal(ai.label, 'likely_ok');
    assert.equal(ai.reason, 'A cat is clearly visible.');
    assert.equal(ai.model, 'test-model');
    assert.equal(ai.took_ms, 25);

    // Finishing twice changes nothing.
    assert.equal(await finish(r.id, 'likely_not_ok', 'No cat.'), 'accepted');
    assert.equal((await db.one(`select count(*)::int as n from ai_checks`)).n, 1);
    assert.equal((await db.one(`select state from check_ins where id = $1`, [r.id])).state, 'accepted');

    await assert.rejects(begin(creator, challenge), /today is already done/);
    const p = await progress(creator, challenge);
    assert.equal(mine(p).days[0].status, 'done');
    assert.equal(mine(p).days_done, 1);
    assert.equal(mine(p).can_check_in, false);
  });

  test('unsure and likely not okay both reject, and every retry is a new numbered attempt', async () => {
    const { creator, challenge } = await running();
    const first = await begin(creator, challenge);
    assert.equal(await finish(first.id, 'unsure', 'Hard to tell.'), 'rejected');
    let p = await progress(creator, challenge);
    assert.equal(mine(p).days[0].status, 'rejected');
    assert.equal(mine(p).can_check_in, true);

    const second = await begin(creator, challenge);
    assert.equal(second.attempt, 2);
    assert.equal(await finish(second.id, 'likely_not_ok', 'That is a dog.'), 'rejected');

    const third = await begin(creator, challenge);
    assert.equal(third.attempt, 3);
    assert.equal(await finish(third.id, 'failed', 'The AI check failed.'), 'rejected');

    const fourth = await begin(creator, challenge);
    assert.equal(fourth.attempt, 4);
    assert.equal(await finish(fourth.id, 'likely_ok'), 'accepted');
    p = await progress(creator, challenge);
    assert.equal(mine(p).days[0].status, 'done');
    assert.equal(mine(p).days_done, 1);
    assert.equal((await db.one(`select count(*)::int as n from check_ins`)).n, 4);

    await assert.rejects(finish(fourth.id, 'maybe'), /unknown verdict/);
    await assert.rejects(finish('00000000-0000-0000-0000-000000000000', 'likely_ok'), /unknown check-in/);
  });

  test('a photo still being checked blocks another attempt; a stuck one is written off after three minutes', async () => {
    const { creator, challenge, member } = await running();
    const first = await begin(creator, challenge);
    await assert.rejects(begin(creator, challenge), /still being checked/);
    let p = await progress(creator, challenge);
    assert.equal(mine(p).days[0].status, 'checking');

    // Pretend the first attempt was started four minutes ago and never finished.
    await db.owner.query(`alter table check_ins disable trigger check_ins_guard`);
    await db.owner.query(`update check_ins set created_at = now() - interval '4 minutes' where id = $1`, [first.id]);
    await db.owner.query(`alter table check_ins enable trigger check_ins_guard`);
    p = await progress(creator, challenge);
    assert.equal(mine(p).days[0].status, 'open', 'a stuck check is not shown as checking');

    const second = await begin(creator, challenge);
    assert.equal(second.attempt, 2);
    const stuck = await db.one(
      `select c.state, a.label, a.reason from check_ins c join ai_checks a on a.check_in_id = c.id where c.id = $1`,
      [first.id],
    );
    assert.deepEqual(stuck, { state: 'rejected', label: 'failed', reason: 'The check did not finish. Please try again.' });
    assert.equal(await finish(first.id, 'likely_ok'), 'rejected', 'a late verdict for a written-off check is ignored');

    // The scheduler does the same for everyone.
    await db.owner.query(`alter table check_ins disable trigger check_ins_guard`);
    await db.owner.query(`update check_ins set created_at = now() - interval '4 minutes' where id = $1`, [second.id]);
    await db.owner.query(`alter table check_ins enable trigger check_ins_guard`);
    const swept = await db.as(
      'service_role',
      async (c) => (await c.query(`select expire_stale_check_ins() as n`)).rows[0].n,
    );
    assert.equal(swept, 1);
    assert.equal((await db.one(`select state from check_ins where id = $1`, [second.id])).state, 'rejected');
    assert.equal(
      (await db.one(`select count(*)::int as n from check_ins where member_id = $1`, [member])).n,
      2,
    );
  });

  test('only today counts, only while the challenge runs, and only for members still in it', async () => {
    const creator = await db.createUser('Ana');
    await db.give(creator, 100);
    const open = await db.as(
      creator,
      async (c) =>
        (
          await c.query(`select create_challenge('pet_cat', 7, $1, 7, 10, 0, $2) as id`, [await today(TZ, 1), TZ])
        ).rows[0].id,
    );
    await assert.rejects(begin(creator, open), /not running/);

    const ended = await running({ lengthDays: 3, startedDaysAgo: 5 });
    await assert.rejects(begin(ended.creator, ended.challenge), /has ended/);

    const { challenge } = await running();
    const ben = await db.createUser('Ben');
    await assert.rejects(begin(ben, challenge), /not in this challenge/);
    await db.give(ben, 10);
    await db.join(ben, challenge);
    await db.setResult(challenge, ben, 'forfeited');
    await assert.rejects(begin(ben, challenge), /no longer in this challenge/);

    const long = await running();
    await assert.rejects(begin(long.creator, long.challenge, 'x'.repeat(281)), /280 characters at most/);

    await db.owner.query('begin');
    await db.owner.query('set local role anon');
    await assert.rejects(db.owner.query(`select begin_check_in($1, '')`, [challenge]), /permission denied/);
    await db.owner.query('rollback');
  });

  test("each member's day follows their own time zone", async () => {
    // Kiritimati is a day ahead of Pago Pago at every hour of the day.
    const east = 'Pacific/Kiritimati';
    const west = 'Pacific/Pago_Pago';
    const { creator, challenge } = await running({ tz: east });
    const ben = await db.createUser('Ben');
    await db.give(ben, 10);
    await db.as(ben, (c) => c.query(`select join_challenge($1, $2)`, [challenge, west]));

    const r = await begin(creator, challenge);
    assert.equal(r.day, await today(east));
    await assert.rejects(begin(ben, challenge), /not started yet/);

    const p = await progress(ben, challenge);
    const benRow = p.members.find((m) => m.user_id === ben);
    assert.equal(benRow.today, await today(west));
    assert.equal(benRow.days[0].status, 'future');
    assert.equal(benRow.can_check_in, false);
    assert.equal(benRow.misses, 0);
  });
});

describe('what friends see', () => {
  test('friends learn whether a day is done, never the photo, the note or the attempts', async () => {
    const { creator, challenge } = await running();
    const ben = await db.createUser('Ben');
    await db.give(ben, 10);
    await db.join(ben, challenge);

    const first = await begin(creator, challenge, 'My cat Mo');
    await finish(first.id, 'likely_not_ok', 'No cat in sight.');
    const second = await begin(creator, challenge);

    const asBen = await progress(ben, challenge);
    const anaForBen = asBen.members.find((m) => m.user_id === creator);
    assert.equal(anaForBen.mine, false);
    assert.equal(anaForBen.days[0].status, 'open', 'rejected and pending attempts stay private');
    assert.equal(anaForBen.days_done, 0);
    for (const key of ['note', 'photo_path', 'attempts', 'check_ins']) assert.equal(key in anaForBen, false);

    const asAna = await progress(creator, challenge);
    assert.equal(mine(asAna).days[0].status, 'checking');

    const rows = async (user, table) =>
      db.as(user, async (c) => (await c.query(`select * from ${table}`)).rows.length);
    assert.equal(await rows(ben, 'check_ins'), 0);
    assert.equal(await rows(ben, 'ai_checks'), 0);
    assert.equal(await rows(creator, 'check_ins'), 2);
    assert.equal(await rows(creator, 'ai_checks'), 1);

    await finish(second.id, 'likely_ok');
    const done = await progress(ben, challenge);
    assert.equal(done.members.find((m) => m.user_id === creator).days[0].status, 'done');

    const carl = await db.createUser('Carl');
    await assert.rejects(progress(carl, challenge), /not in this challenge/);
  });

  test('a member uploads only the photo of their own pending check-in, and sees only their own photos', async () => {
    const { creator, challenge } = await running();
    const ben = await db.createUser('Ben');
    await db.give(ben, 10);
    await db.join(ben, challenge);

    const r = await begin(creator, challenge);
    await assert.rejects(upload(ben, r.photo_path), /row-level security/);
    await assert.rejects(upload(creator, `${challenge}/${creator}/not-a-check-in.jpg`), /row-level security/);
    await db.owner.query(`insert into storage.buckets (id, name) values ('other', 'other') on conflict do nothing`);
    await assert.rejects(upload(creator, r.photo_path, 'other'), /row-level security/);
    await upload(creator, r.photo_path);

    const see = async (user) =>
      db.as(user, async (c) => (await c.query(`select name from storage.objects`)).rows.map((o) => o.name));
    assert.deepEqual(await see(creator), [r.photo_path]);
    assert.deepEqual(await see(ben), []);

    await finish(r.id, 'likely_ok');
    const again = await db.one(`select count(*)::int as n from storage.objects`);
    assert.equal(again.n, 1);
    const later = await db.one(`select gen_random_uuid() as id`);
    await assert.rejects(
      upload(creator, `${challenge}/${creator}/${later.id}.jpg`),
      /row-level security/,
      'a path that belongs to no check-in is refused',
    );
    // Ben's next attempt is rejected before any photo lands: the path is closed for uploads.
    const b = await begin(ben, challenge);
    await finish(b.id, 'likely_not_ok');
    await assert.rejects(upload(ben, b.photo_path), /row-level security/, 'a decided check-in cannot get a photo');
  });

  test('the templates tell the AI what to look for', async () => {
    const ana = await db.createUser('Ana');
    const rows = await db.as(
      ana,
      async (c) => (await c.query(`select key, ai_instruction from challenge_templates order by position`)).rows,
    );
    assert.equal(rows.length, 7);
    for (const row of rows) assert.ok(row.ai_instruction.length > 20, row.key);
    assert.match(rows.find((r) => r.key === 'pet_cat').ai_instruction, /real cat/);
  });
});

describe('misses', () => {
  test('a daily challenge: every past day without an accepted check-in is a miss; today is still open', async () => {
    const { creator, challenge, member } = await running({ lengthDays: 7, missesAllowed: 1, startedDaysAgo: 3 });
    await acceptedOn(challenge, member, creator, await today(TZ, -3));
    let p = await progress(creator, challenge);
    assert.deepEqual(
      mine(p).days.map((d) => d.status),
      ['done', 'none', 'none', 'open', 'future', 'future', 'future'],
    );
    assert.equal(mine(p).misses, 2);
    assert.equal(mine(p).misses_left, -1);
    assert.equal(mine(p).out, true);
    assert.equal(mine(p).can_check_in, false);
    await assert.rejects(begin(creator, challenge), /missed too many days/);

    await db.owner.query(`update challenges set misses_allowed = 2 where id = $1`, [challenge]);
    p = await progress(creator, challenge);
    assert.equal(mine(p).misses_left, 0);
    assert.equal(mine(p).out, false);
    assert.equal(mine(p).can_check_in, true);
    const r = await begin(creator, challenge);
    await finish(r.id, 'likely_ok');
    p = await progress(creator, challenge);
    assert.equal(mine(p).days[3].status, 'done');
    assert.equal(mine(p).days_done, 2);
    assert.equal(mine(p).misses, 2, 'today done, no new miss');
    assert.equal(mine(p).week.done, 2);
    assert.equal(mine(p).week.days_left, 3, 'today is done, so three open days remain');
  });

  test('"3 times a week" counts per week, and a short last week needs a fair share rounded up', async () => {
    const cases = await db.owner.query(
      `select week_required(7, 7) as a, week_required(3, 7) as b, week_required(3, 3) as c,
              week_required(2, 4) as d, week_required(1, 1) as e, week_required(1, 2) as f`,
    );
    assert.deepEqual(cases.rows[0], { a: 7, b: 3, c: 2, d: 2, e: 1, f: 1 });

    // 10 days, 3 times a week, today is day 10: week 1 is days 1-7 (needs 3), week 2 is days 8-10 (needs 2).
    const { creator, challenge, member } = await running({ timesPerWeek: 3, lengthDays: 10, missesAllowed: 1, startedDaysAgo: 9 });
    await acceptedOn(challenge, member, creator, await today(TZ, -9));
    await acceptedOn(challenge, member, creator, await today(TZ, -8));
    await acceptedOn(challenge, member, creator, await today(TZ, -2));
    let p = await progress(creator, challenge);
    assert.equal(mine(p).misses, 1, 'week 1 ended one short');
    assert.deepEqual(mine(p).week, {
      starts: await today(TZ, -2),
      ends: await today(TZ),
      required: 2,
      done: 1,
      days_left: 1,
    });
    assert.equal(mine(p).can_check_in, true, 'today can still complete week 2');
    assert.equal(mine(p).days[5].status, 'none', 'a skipped day in a 3-a-week challenge is not a miss by itself');

    // Move the whole challenge one day further into the past: week 2 is now over, one short.
    await db.owner.query(`update challenges set start_date = start_date - 1 where id = $1`, [challenge]);
    await db.owner.query(`update check_ins set day = day - 1`).catch(() => {});
    p = await progress(creator, challenge);
    assert.equal(mine(p).misses, 2);
    assert.equal(mine(p).out, true);
    assert.equal(mine(p).week, null, 'the challenge days are over');
  });

  test('misses allowed keeps you in; one more puts you out', async () => {
    const { creator, challenge } = await running({ lengthDays: 5, missesAllowed: 2, startedDaysAgo: 2 });
    let p = await progress(creator, challenge);
    assert.equal(mine(p).misses, 2);
    assert.equal(mine(p).misses_left, 0);
    assert.equal(mine(p).out, false);
    await db.owner.query(`update challenges set start_date = start_date - 1 where id = $1`, [challenge]);
    p = await progress(creator, challenge);
    assert.equal(mine(p).misses, 3);
    assert.equal(mine(p).out, true);
    assert.equal(mine(p).can_check_in, false);
  });
});

describe('the home screen', () => {
  test('my_today lists every running challenge with where you stand today', async () => {
    const creator = await db.createUser('Ana');
    await db.give(creator, 100);
    const make = async (start, misses = 0, days = 7) =>
      db.as(
        creator,
        async (c) =>
          (await c.query(`select create_challenge('pet_cat', 7, $1, $2, 10, $3, $4) as id`, [start, days, misses, TZ]))
            .rows[0].id,
      );
    const done = await make(await today());
    const open = await make(await today());
    const notYet = await make(await today(TZ, 1));
    const out = await make(await today(), 0, 7);
    await db.owner.query(`update challenges set start_date = start_date - 1 where id = $1`, [out]);

    const r = await begin(creator, done);
    await finish(r.id, 'likely_ok');
    const rejected = await begin(creator, open);
    await finish(rejected.id, 'unsure');

    const items = await myToday(creator);
    const byId = Object.fromEntries(items.map((i) => [i.challenge_id, i]));
    assert.equal(byId[done].status, 'done');
    assert.equal(byId[open].status, 'rejected');
    assert.equal(byId[out].status, 'out');
    assert.equal(byId[out].misses_left, -1);
    assert.equal(notYet in byId, false, 'a challenge that has not started is not listed');
    assert.equal(byId[done].week.required, 7);
  });
});

describe('what cannot change', () => {
  test('the app cannot write check-ins or verdicts, and a verdict is final', async () => {
    const { creator, challenge } = await running();
    const r = await begin(creator, challenge);
    for (const sql of [
      `update check_ins set note = 'edited' where id = '${r.id}'`,
      `update check_ins set state = 'accepted' where id = '${r.id}'`,
      `delete from check_ins where id = '${r.id}'`,
      `insert into ai_checks (check_in_id, label, reason, model, took_ms) values ('${r.id}', 'likely_ok', 'x', 'me', 0)`,
      `select finish_check_in('${r.id}', 'likely_ok', 'x', 'me', 0)`,
      `select expire_stale_check_ins()`,
    ]) {
      await assert.rejects(db.as(creator, (c) => c.query(sql)), /permission denied/, sql);
    }
    await assert.rejects(db.owner.query(`update check_ins set note = 'edited' where id = $1`, [r.id]), /cannot be changed/);
    await assert.rejects(db.owner.query(`update check_ins set day = day - 1 where id = $1`, [r.id]), /cannot be changed/);
    await finish(r.id, 'likely_ok');
    await assert.rejects(db.owner.query(`update check_ins set state = 'rejected' where id = $1`, [r.id]), /verdict is final/);
    await assert.rejects(
      db.owner.query(`update check_ins set decided_at = now() where id = $1`, [r.id]),
      /verdict is final/,
    );
  });
});
