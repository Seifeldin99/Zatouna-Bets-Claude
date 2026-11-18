// Tests for the grace period after midnight (supabase/migrations/*_grace_period.sql):
// which day a check-in counts for, when a day becomes a miss, and when a
// challenge ends. Run with `npm run test:db`.
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

// A date in a time zone, as the server sees it.
async function today(tz = TZ, plusDays = 0) {
  const { d } = await db.one(`select to_char((now() at time zone $1)::date + $2::int, 'YYYY-MM-DD') as d`, [
    tz,
    plusDays,
  ]);
  return d;
}

async function setGrace(minutes) {
  await db.owner.query(`update app_settings set grace_minutes = $1`, [minutes]);
}

// A fixed-offset time zone where the clock reads `hour` o'clock right now, so
// a test can stand at a chosen time of day without touching the server's
// clock. The tests below stand at 2 o'clock: with a 10-hour grace period that
// is inside the grace period of the day before; with a 1-hour one it is past it.
async function zoneAtHour(hour) {
  const { h } = await db.one(`select extract(hour from now() at time zone 'UTC')::int as h`);
  let offset = (hour - h + 24) % 24; // hours ahead of UTC
  if (offset > 12) offset -= 24; // the Etc/GMT zones run from 12 behind to 14 ahead
  if (offset === 0) return 'Etc/UTC';
  // POSIX names these zones backwards: Etc/GMT-5 is five hours ahead of UTC.
  return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

async function user(name, tokens = 100, opts = {}) {
  const id = await db.createUser(name, opts);
  if (tokens > 0) await db.give(id, tokens);
  return id;
}

// A Pet Cat challenge that started `startedDaysAgo` days ago (0 = today),
// created and joined by `creator`. Returns the challenge and the member row id.
async function running(creator, { timesPerWeek = 7, lengthDays = 7, missesAllowed = 0, startedDaysAgo = 0, tz = TZ } = {}) {
  const challenge = await db.as(
    creator,
    async (c) =>
      (
        await c.query(`select create_challenge('pet_cat', $1, $2, $3, 100, $4, $5) as id`, [
          timesPerWeek,
          await today(tz),
          lengthDays,
          missesAllowed,
          tz,
        ])
      ).rows[0].id,
  );
  if (startedDaysAgo > 0) await shiftBack(challenge, startedDaysAgo);
  return { challenge, member: await memberOf(challenge, creator) };
}

async function shiftBack(challengeId, days) {
  await db.owner.query(`update challenges set start_date = start_date - $2::int where id = $1`, [challengeId, days]);
}

async function memberOf(challengeId, userId) {
  const { id } = await db.one(`select id from challenge_members where challenge_id = $1 and user_id = $2`, [
    challengeId,
    userId,
  ]);
  return id;
}

async function joinAs(userId, challengeId, tz = TZ) {
  await db.as(userId, (c) => c.query(`select join_challenge($1, $2)`, [challengeId, tz]));
  return memberOf(challengeId, userId);
}

// Writes an accepted check-in straight into the table for a past day.
async function acceptedOn(challengeId, memberId, userId, day) {
  await db.owner.query(
    `insert into check_ins (challenge_id, member_id, user_id, day, attempt, photo_path, state, decided_at)
     values ($1::uuid, $2::uuid, $3::uuid, $4::date, 1, $1::text || '/' || $3::text || '/' || gen_random_uuid() || '.jpg', 'accepted', now())`,
    [challengeId, memberId, userId, day],
  );
}

// The day a check-in made at `time` on `day` (member's own clock) would count for.
async function countsFor(userId, challengeId, day, time) {
  const { d } = await db.one(
    `select to_char(member_check_in_day(m, c, ($3::date + $4::time) at time zone m.time_zone), 'YYYY-MM-DD') as d
     from challenge_members m join challenges c on c.id = m.challenge_id
     where m.challenge_id = $1 and m.user_id = $2`,
    [challengeId, userId, day, time],
  );
  return d;
}

// Midnight at the start of `day` in `tz`, plus `hours`, as a timestamp.
async function at(day, tz, hours = 0) {
  const { t } = await db.one(`select challenge_starts_at($1::date, $2) + make_interval(hours => $3::int) as t`, [
    day,
    tz,
    hours,
  ]);
  return new Date(t).getTime();
}

async function endsAt(userId, challengeId) {
  const row = await db.one(
    `select member_ends_at(m, c) as member, challenge_ends_at(c) as challenge
     from challenge_members m join challenges c on c.id = m.challenge_id
     where m.challenge_id = $1 and m.user_id = $2`,
    [challengeId, userId],
  );
  return { member: new Date(row.member).getTime(), challenge: new Date(row.challenge).getTime() };
}

async function begin(userId, challengeId, note = '') {
  return db.as(
    userId,
    async (c) => (await c.query(`select begin_check_in($1, $2) as r`, [challengeId, note])).rows[0].r,
  );
}

async function finish(id, label) {
  return db.as('service_role', (c) =>
    c.query(`select finish_check_in($1, $2, 'Test verdict.', 'test-model', 20)`, [id, label]),
  );
}

// A check-in now with the AI's verdict. Returns the check-in row.
async function checkIn(userId, challengeId, label = 'likely_ok') {
  const r = await begin(userId, challengeId);
  await finish(r.id, label);
  return r;
}

async function progress(userId, challengeId) {
  const p = await db.as(
    userId,
    async (c) => (await c.query(`select challenge_progress($1) as p`, [challengeId])).rows[0].p,
  );
  return p.members.find((m) => m.mine);
}

async function friendView(userId, challengeId, friendId) {
  const p = await db.as(
    userId,
    async (c) => (await c.query(`select challenge_progress($1) as p`, [challengeId])).rows[0].p,
  );
  return p.members.find((m) => m.user_id === friendId);
}

async function myToday(userId) {
  return db.as(userId, async (c) => (await c.query(`select my_today() as t`)).rows[0].t);
}

function dayStatuses(member) {
  return Object.fromEntries(member.days.map((d) => [d.day, d.status]));
}

async function callReferee(userId, checkInId) {
  return db.as(
    userId,
    async (c) =>
      (await c.query(`select open_referee_case($1, 'The cat is there, look at the tail.') as id`, [checkInId]))
        .rows[0].id,
  );
}

async function decide(userId, caseId, accept) {
  return db.as(userId, (c) => c.query(`select decide_referee_case($1, $2, 'Looked again.')`, [caseId, accept]));
}

// What the minute job does: end, accept stale cases, settle what is ready.
async function finishJob() {
  return db.as('service_role', async (c) => (await c.query(`select finish_due_challenges() as r`)).rows[0].r);
}

async function statusOf(challengeId) {
  return (await db.one(`select status from challenges where id = $1`, [challengeId])).status;
}

async function results(userId, challengeId) {
  return db.as(userId, async (c) => (await c.query(`select challenge_results($1) as r`, [challengeId])).rows[0].r);
}

describe('the setting', () => {
  test('the live default is one hour; the tests switch it off', async () => {
    const col = await db.one(
      `select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'app_settings' and column_name = 'grace_minutes'`,
    );
    assert.equal(col.column_default, '60');
    const row = await db.one(`select grace_minutes from app_settings`);
    assert.equal(row.grace_minutes, 0);
    await assert.rejects(setGrace(1440), /violates check constraint/);
    await assert.rejects(setGrace(-1), /violates check constraint/);
  });
});

describe('which day a check-in counts for', () => {
  test('in the hour after midnight, a check-in counts for the day before while that day still needs one', async () => {
    const ana = await user('Ana');
    const { challenge, member } = await running(ana, { startedDaysAgo: 3 });
    const yesterday = await today(TZ, -1);
    const now = await today(TZ);
    await setGrace(60);
    assert.equal(await countsFor(ana, challenge, yesterday, '23:59:59'), yesterday);
    assert.equal(await countsFor(ana, challenge, now, '00:00:00'), yesterday, 'midnight opens the grace period');
    assert.equal(await countsFor(ana, challenge, now, '00:59:59'), yesterday);
    assert.equal(await countsFor(ana, challenge, now, '01:00:00'), now, 'the grace period is over');
    assert.equal(await countsFor(ana, challenge, now, '12:00:00'), now);
    await setGrace(90);
    assert.equal(await countsFor(ana, challenge, now, '01:15:00'), yesterday, 'the length is a setting');
    await setGrace(0);
    assert.equal(await countsFor(ana, challenge, now, '00:00:01'), now, 'switched off');
    await setGrace(60);
    await acceptedOn(challenge, member, ana, yesterday);
    assert.equal(await countsFor(ana, challenge, now, '00:30:00'), now, 'yesterday is done, so it counts for today');
  });

  test('the grace period stays inside the challenge', async () => {
    const ana = await user('Ana', 300);
    await setGrace(60);
    const now = await today(TZ);
    const { challenge: fresh } = await running(ana, { lengthDays: 3 });
    assert.equal(await countsFor(ana, fresh, now, '00:30:00'), now, 'the day before the start is not a challenge day');
    const { challenge: over } = await running(ana, { lengthDays: 3, startedDaysAgo: 3 });
    assert.equal(await countsFor(ana, over, now, '00:30:00'), await today(TZ, -1), 'the last day gets its grace period');
    assert.equal(
      await countsFor(ana, over, await today(TZ, 1), '00:30:00'),
      await today(TZ, 1),
      'after the last day there is nothing left to complete',
    );
  });

  test('"N times a week": the day before only gets the grace period while its week is still short', async () => {
    const ana = await user('Ana', 300);
    await setGrace(60);
    const now = await today(TZ);
    const yesterday = await today(TZ, -1);
    // 10 days, 3 times a week, today is day 8: yesterday was the last day of week 1.
    const { challenge, member } = await running(ana, { timesPerWeek: 3, lengthDays: 10, startedDaysAgo: 7 });
    assert.equal(await countsFor(ana, challenge, now, '00:30:00'), yesterday, 'week 1 has 0 of 3');
    await acceptedOn(challenge, member, ana, await today(TZ, -7));
    await acceptedOn(challenge, member, ana, await today(TZ, -6));
    assert.equal(await countsFor(ana, challenge, now, '00:30:00'), yesterday, 'week 1 has 2 of 3');
    await acceptedOn(challenge, member, ana, await today(TZ, -5));
    assert.equal(await countsFor(ana, challenge, now, '00:30:00'), now, 'week 1 is complete, so it counts for week 2');
    // Mid-week it works the same way: a short week keeps the day before open.
    const { challenge: midWeek, member: midMember } = await running(ana, {
      timesPerWeek: 3,
      lengthDays: 10,
      startedDaysAgo: 3,
    });
    assert.equal(await countsFor(ana, midWeek, now, '00:30:00'), yesterday);
    await acceptedOn(midWeek, midMember, ana, await today(TZ, -3));
    await acceptedOn(midWeek, midMember, ana, await today(TZ, -2));
    assert.equal(await countsFor(ana, midWeek, now, '00:30:00'), yesterday, '2 of 3 so far');
    await acceptedOn(midWeek, midMember, ana, await today(TZ, -1));
    assert.equal(await countsFor(ana, midWeek, now, '00:30:00'), now, 'yesterday is done');
  });
});

describe('checking in during the grace period', () => {
  test('a day not completed by midnight is still open, not missed, and the check-in counts for it', async () => {
    const zone = await zoneAtHour(2);
    await setGrace(600);
    const ana = await user('Ana');
    const ben = await user('Ben');
    const { challenge } = await running(ana, { startedDaysAgo: 3, missesAllowed: 6, tz: zone });
    await db.owner.query(`insert into challenge_members (challenge_id, user_id, time_zone) values ($1, $2, $3)`, [
      challenge,
      ben,
      zone,
    ]);
    const yesterday = await today(zone, -1);
    const now = await today(zone);

    let mine = await progress(ana, challenge);
    assert.equal(mine.today, yesterday, 'a check-in now would count for yesterday');
    assert.equal(mine.in_grace, true);
    assert.equal(new Date(mine.day_ends_at).getTime(), await at(now, zone), 'yesterday ended at midnight');
    assert.equal(new Date(mine.grace_ends_at).getTime(), await at(now, zone, 10), 'the grace period ends 10 hours later');
    assert.equal(mine.misses, 2, 'the two days before are missed; yesterday is not, yet');
    assert.equal(mine.can_check_in, true);
    assert.equal(dayStatuses(mine)[yesterday], 'open');
    assert.equal(dayStatuses(mine)[now], 'future', 'today opens once yesterday is settled');
    const friend = await friendView(ben, challenge, ana);
    assert.equal(dayStatuses(friend)[yesterday], 'open', 'friends do not see a miss yet');
    assert.equal(dayStatuses(friend)[now], 'future');
    const [home] = await myToday(ana);
    assert.equal(home.status, 'open');
    assert.equal(home.in_grace, true);
    assert.equal(home.today, yesterday);

    const r = await checkIn(ana, challenge, 'likely_ok');
    assert.equal(r.day, yesterday);
    mine = await progress(ana, challenge);
    assert.equal(mine.today, now, 'yesterday is done, so today is the day now');
    assert.equal(mine.in_grace, false);
    assert.equal(new Date(mine.day_ends_at).getTime(), await at(now, zone, 24));
    assert.equal(mine.misses, 2);
    assert.equal(dayStatuses(mine)[yesterday], 'done');
    assert.equal(dayStatuses(mine)[now], 'open');
    assert.equal(mine.can_check_in, true, 'today still needs its own check-in');
    assert.equal((await myToday(ana))[0].status, 'open');
    const second = await checkIn(ana, challenge, 'likely_ok');
    assert.equal(second.day, now);
    assert.equal(second.attempt, 1);
    assert.equal((await progress(ana, challenge)).days_done, 2);
  });

  test('a rejected photo in the grace period can be retried while the grace period runs', async () => {
    const zone = await zoneAtHour(2);
    await setGrace(600);
    const ana = await user('Ana');
    const { challenge } = await running(ana, { startedDaysAgo: 1, tz: zone });
    const yesterday = await today(zone, -1);
    const first = await checkIn(ana, challenge, 'likely_not_ok');
    assert.equal(first.day, yesterday);
    const mine = await progress(ana, challenge);
    assert.equal(dayStatuses(mine)[yesterday], 'rejected');
    assert.equal(mine.misses, 0);
    assert.equal((await myToday(ana))[0].status, 'rejected');
    const retry = await begin(ana, challenge);
    assert.equal(retry.day, yesterday);
    assert.equal(retry.attempt, 2);
  });

  test('once the grace period is over, the day is missed', async () => {
    const zone = await zoneAtHour(2);
    await setGrace(60);
    const ana = await user('Ana');
    const { challenge } = await running(ana, { startedDaysAgo: 3, missesAllowed: 6, tz: zone });
    const yesterday = await today(zone, -1);
    const now = await today(zone);
    const mine = await progress(ana, challenge);
    assert.equal(mine.today, now);
    assert.equal(mine.in_grace, false);
    assert.equal(mine.misses, 3);
    assert.equal(dayStatuses(mine)[yesterday], 'none');
    assert.equal(dayStatuses(mine)[now], 'open');
    assert.equal((await checkIn(ana, challenge)).day, now);
  });

  test('on the first day there is nothing to catch up on', async () => {
    const zone = await zoneAtHour(2);
    await setGrace(600);
    const ana = await user('Ana');
    const { challenge } = await running(ana, { tz: zone });
    const now = await today(zone);
    const mine = await progress(ana, challenge);
    assert.equal(mine.today, now);
    assert.equal(mine.in_grace, false);
    assert.equal((await checkIn(ana, challenge)).day, now);
  });
});

describe('the end of the challenge', () => {
  afterEach(async () => {
    const { total } = await db.one(`select coalesce(sum(amount), 0)::int as total from ledger_entries`);
    assert.equal(total, 0, 'the ledger must always sum to zero');
  });

  // Ana and Ben, 100 each, a one-day challenge whose day was yesterday in
  // `zone`. Ben completed it; Ana has not.
  async function oneDay(zone) {
    const ana = await user('Ana');
    const ben = await user('Ben');
    const { challenge } = await running(ana, { lengthDays: 1, tz: zone });
    const benMember = await joinAs(ben, challenge, zone);
    await shiftBack(challenge, 1);
    await acceptedOn(challenge, benMember, ben, await today(zone, -1));
    return { ana, ben, challenge };
  }

  test('the challenge waits for a member still in their grace period, then ends the minute they are done', async () => {
    const zone = await zoneAtHour(2);
    await setGrace(600);
    const { ana, ben, challenge } = await oneDay(zone);
    const midnight = await at(await today(zone), zone);
    assert.deepEqual(await endsAt(ana, challenge), { member: midnight + 10 * 3_600_000, challenge: midnight + 10 * 3_600_000 });
    assert.equal((await endsAt(ben, challenge)).member, midnight, "Ben's day is done, so his challenge ended at midnight");
    let r = await finishJob();
    assert.equal(r.ended, 0, 'Ana can still complete her last day');
    assert.equal(await statusOf(challenge), 'active');

    const checkIn_ = await checkIn(ana, challenge, 'likely_ok');
    assert.equal(checkIn_.day, await today(zone, -1));
    assert.deepEqual(await endsAt(ana, challenge), { member: midnight, challenge: midnight }, 'nothing left to wait for');
    r = await finishJob();
    assert.deepEqual(r, { ended: 1, cases_accepted: 0, settled: 1, failed: 0 });
    assert.equal(await statusOf(challenge), 'settled');
    assert.equal(await db.balanceOf(ana), 100);
    assert.equal(await db.balanceOf(ben), 100);
    const res = await results(ana, challenge);
    assert.deepEqual(
      res.members.map((m) => [m.name, m.result, new Date(m.ends_at).getTime(), new Date(m.calls_close_at).getTime()]),
      [
        ['Ana', 'finished', midnight, midnight + 3_600_000],
        ['Ben', 'finished', midnight, midnight + 3_600_000],
      ],
    );
  });

  test('a member who lets the grace period pass has missed the day, and the challenge ends when the grace period does', async () => {
    const zone = await zoneAtHour(2);
    await setGrace(60);
    const { ana, ben, challenge } = await oneDay(zone);
    const midnight = await at(await today(zone), zone);
    assert.deepEqual(await endsAt(ana, challenge), { member: midnight + 3_600_000, challenge: midnight + 3_600_000 });
    assert.equal((await endsAt(ben, challenge)).member, midnight);
    const r = await finishJob();
    assert.deepEqual(r, { ended: 1, cases_accepted: 0, settled: 1, failed: 0 });
    await assert.rejects(begin(ana, challenge), /not running/);
    assert.equal(await db.balanceOf(ana), 0);
    assert.equal(await db.balanceOf(ben), 200);
    const res = await results(ben, challenge);
    assert.deepEqual(
      res.members.map((m) => [m.name, m.result, new Date(m.ends_at).getTime(), new Date(m.calls_close_at).getTime()]),
      [
        ['Ben', 'finished', midnight, midnight + 3_600_000],
        ['Ana', 'forfeited', midnight + 3_600_000, midnight + 2 * 3_600_000],
      ],
    );
  });

  test('a rejected last-day photo can go to the referee until an hour after the grace period, and the payout waits for the case', async () => {
    const zone = await zoneAtHour(2);
    const support = await user('Sam', 0, { role: 'support' });
    await setGrace(600);
    const { ana, ben, challenge } = await oneDay(zone);
    const rejected = await checkIn(ana, challenge, 'likely_not_ok');
    const midnight = await at(await today(zone), zone);
    const res = await results(ana, challenge);
    assert.equal(new Date(res.members.find((m) => m.name === 'Ana').calls_close_at).getTime(), midnight + 11 * 3_600_000);
    // With a one-hour grace period the call would already be closed (it is past 2 o'clock).
    await setGrace(60);
    await assert.rejects(callReferee(ana, rejected.id), /could be called until 1 hour after your last midnight/);
    await setGrace(600);
    const caseId = await callReferee(ana, rejected.id);
    assert.equal((await finishJob()).ended, 0, 'still inside the grace period');
    await setGrace(60);
    const r = await finishJob();
    assert.deepEqual(r, { ended: 1, cases_accepted: 0, settled: 0, failed: 0 });
    assert.equal((await results(ana, challenge)).waiting_for, 'cases');
    await decide(support, caseId, true);
    assert.deepEqual(await finishJob(), { ended: 0, cases_accepted: 0, settled: 1, failed: 0 });
    assert.equal(await db.balanceOf(ana), 100);
    assert.equal(await db.balanceOf(ben), 100);
  });

  test('no grace period at the end for a member who is out, who quit, or whose week is already complete', async () => {
    const zone = await zoneAtHour(2);
    await setGrace(600);
    const now = await today(zone);
    const midnight = await at(now, zone);
    const ana = await user('Ana', 500);
    // Out: a 3-day daily challenge with no misses allowed and no check-ins.
    const { challenge: out } = await running(ana, { lengthDays: 3, startedDaysAgo: 3, tz: zone });
    assert.equal((await progress(ana, out)).out, true);
    assert.equal((await endsAt(ana, out)).member, midnight);
    // Quit: the last day is open but the stake is already lost.
    const { challenge: quit } = await running(ana, { lengthDays: 3, startedDaysAgo: 3, missesAllowed: 2, tz: zone });
    assert.equal((await endsAt(ana, quit)).member, midnight + 10 * 3_600_000, 'still needed before quitting');
    await db.as(ana, (c) => c.query(`select quit_challenge($1)`, [quit]));
    assert.equal((await endsAt(ana, quit)).member, midnight);
    // Complete: 3 times a week, done on the first three days.
    const { challenge: done, member } = await running(ana, { timesPerWeek: 3, lengthDays: 7, startedDaysAgo: 7, tz: zone });
    for (const back of [7, 6, 5]) await acceptedOn(done, member, ana, await today(zone, -back));
    assert.equal((await endsAt(ana, done)).member, midnight);
    // Still needed: the same challenge with one day short.
    const { challenge: short, member: shortMember } = await running(ana, { timesPerWeek: 3, lengthDays: 7, startedDaysAgo: 7, missesAllowed: 1, tz: zone });
    for (const back of [7, 6]) await acceptedOn(short, shortMember, ana, await today(zone, -back));
    assert.equal((await endsAt(ana, short)).member, midnight + 10 * 3_600_000);
  });
});
