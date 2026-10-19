// Tests for challenges and invites (supabase/migrations/*_challenges_and_invites.sql).
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

// Today's date where the creator lives, as the app would send it.
async function today(tz = TZ, plusDays = 0) {
  const { d } = await db.one(`select to_char((now() at time zone $1)::date + $2::int, 'YYYY-MM-DD') as d`, [
    tz,
    plusDays,
  ]);
  return d;
}

const BOOK_RULE = 'A photo of the open book you are currently reading.';

// Creates a challenge the way the app does, with sensible defaults.
async function create(user, overrides = {}, client) {
  const f = {
    template: 'read_a_book',
    timesPerWeek: 7,
    startDate: await today(TZ, 1),
    lengthDays: 7,
    stake: 50,
    missesAllowed: 0,
    timeZone: TZ,
    ...overrides,
  };
  return db.as(
    user,
    async (c) =>
      (
        await c.query(`select create_challenge($1, $2, $3, $4, $5, $6, $7) as id`, [
          f.template,
          f.timesPerWeek,
          f.startDate,
          f.lengthDays,
          f.stake,
          f.missesAllowed,
          f.timeZone,
        ])
      ).rows[0].id,
    client,
  );
}

async function preview(user, code) {
  return db.as(user, async (c) => (await c.query(`select invite_preview($1) as p`, [code])).rows[0].p);
}

async function inviteCode(challengeId) {
  return (await db.one(`select code from invites where challenge_id = $1`, [challengeId])).code;
}

// A creator with tokens and one challenge, plus the invite code.
async function setup({ stake = 50, extra = 0 } = {}) {
  const creator = await db.createUser('Ana');
  await db.give(creator, stake + extra);
  const challenge = await create(creator, { stake });
  return { creator, challenge, code: await inviteCode(challenge) };
}

describe('creating a challenge', () => {
  test('creates it open, with an invite code, and places the creator\'s stake', async () => {
    const { creator, challenge, code } = await setup({ stake: 50, extra: 20 });

    const c = await db.one(`select * from challenges where id = $1`, [challenge]);
    assert.equal(c.status, 'open');
    assert.equal(c.creator_id, creator);
    assert.equal(c.template, 'read_a_book');
    assert.equal(c.title, 'Read a Book');
    assert.equal(c.rule, BOOK_RULE);
    assert.equal(c.stake, 50);
    assert.equal(c.app_fee_percent, 0, 'no fee during testing: copied from the server setting');
    assert.equal(c.time_zone, TZ);
    assert.equal(c.deleted_at, null);

    assert.match(code, /^[A-Z0-9]{6}$/);
    assert.doesNotMatch(code, /[01IOL]/, 'no characters that look alike');
    const invite = await db.one(`select created_by, expires_at from invites where challenge_id = $1`, [challenge]);
    assert.equal(invite.created_by, creator);
    const { closes } = await db.one(
      `select challenge_join_closes_at(start_date, time_zone) as closes from challenges where id = $1`,
      [challenge],
    );
    assert.equal(invite.expires_at.getTime(), closes.getTime(), 'the invite works until the end of the first day');

    const member = await db.one(`select user_id, time_zone, result from challenge_members where challenge_id = $1`, [
      challenge,
    ]);
    assert.deepEqual(member, { user_id: creator, time_zone: TZ, result: 'in_progress' });
    assert.equal(await db.balanceOf(creator), 20);
    assert.equal(await db.poolBalance(challenge), 50);
  });

  test('takes its title and rule from the chosen template', async () => {
    const creator = await db.createUser('Ana');
    await db.give(creator, 70);
    const templates = (await db.owner.query(`select key, title, rule from challenge_templates order by position`))
      .rows;
    assert.deepEqual(
      templates.map((t) => t.key),
      ['read_a_book', 'workout', 'sunshine', 'journaling', 'eating_fruits', 'learn_french', 'pet_cat'],
    );
    for (const t of templates) {
      const id = await create(creator, { template: t.key, stake: 10 });
      const c = await db.one(`select template, title, rule from challenges where id = $1`, [id]);
      assert.deepEqual(c, { template: t.key, title: t.title, rule: t.rule });
    }
  });

  test('refuses anything that is not a template: no custom challenges', async () => {
    const creator = await db.createUser('Ana');
    await db.give(creator, 100);
    for (const template of ['custom', 'Read a Book', 'READ_A_BOOK', '', null]) {
      await assert.rejects(create(creator, { template }), /pick one of the challenge templates/);
    }
    // The old way, with a title and a rule written by the app, is gone.
    await assert.rejects(
      db.as(creator, (c) =>
        c.query(`select create_challenge('My own', 'Any photo', 7, current_date + 1, 7, 10, 0, $1)`, [TZ]),
      ),
      /does not exist/,
    );
    assert.equal((await db.one(`select count(*)::int as n from challenges`)).n, 0);
    assert.equal(await db.balanceOf(creator), 100);
  });

  test('is undone entirely when the creator cannot afford the stake', async () => {
    const creator = await db.createUser('Ana');
    await db.give(creator, 30);
    await assert.rejects(create(creator, { stake: 50 }), /not enough tokens/);
    assert.equal((await db.one(`select count(*)::int as n from challenges`)).n, 0);
    assert.equal((await db.one(`select count(*)::int as n from invites`)).n, 0);
    assert.equal((await db.one(`select count(*)::int as n from challenge_members`)).n, 0);
    assert.equal(await db.balanceOf(creator), 30);
  });

  test('refuses bad fields with a plain message', async () => {
    const creator = await db.createUser('Ana');
    await db.give(creator, 100);
    const cases = [
      [{ timesPerWeek: 0 }, /between 1 and 7 times a week/],
      [{ timesPerWeek: 8 }, /between 1 and 7 times a week/],
      [{ lengthDays: 0 }, /between 1 and 30 days/],
      [{ lengthDays: 31 }, /between 1 and 30 days/],
      [{ lengthDays: 1, missesAllowed: 1 }, /misses allowed/],
      [{ missesAllowed: -1 }, /misses allowed/],
      [{ missesAllowed: 7 }, /misses allowed/],
      [{ stake: 0 }, /at least 1 token/],
      [{ timeZone: 'Mars/Olympus' }, /unknown time zone/],
      [{ startDate: await today(TZ, -1) }, /cannot be in the past/],
      [{ startDate: await today(TZ, 91) }, /at most 90 days away/],
    ];
    for (const [overrides, message] of cases) {
      await assert.rejects(create(creator, overrides), message, JSON.stringify(overrides));
    }
    assert.equal((await db.one(`select count(*)::int as n from challenges`)).n, 0);
    assert.equal(await db.balanceOf(creator), 100);
  });

  test('"today" is judged in the creator\'s own time zone', async () => {
    // Kiritimati is a day ahead of Pago Pago. Today in one is tomorrow or
    // yesterday in the other.
    const creator = await db.createUser('Ana');
    await db.give(creator, 100);
    const east = 'Pacific/Kiritimati';
    const west = 'Pacific/Pago_Pago';
    await create(creator, { startDate: await today(east, 1), timeZone: east, stake: 10 });
    await create(creator, { startDate: await today(west, 1), timeZone: west, stake: 10 });
    await create(creator, { startDate: await today(east, 90), timeZone: east, stake: 10 });
    await create(creator, { startDate: await today(west), timeZone: west, stake: 10 });
    await assert.rejects(create(creator, { startDate: await today(west, -1), timeZone: west, stake: 10 }), /in the past/);
  });

  test('misses allowed and length can go to their limits', async () => {
    const creator = await db.createUser('Ana');
    await db.give(creator, 20);
    await create(creator, { lengthDays: 30, missesAllowed: 29, timesPerWeek: 1, stake: 10, startDate: await today(TZ, 90) });
    await create(creator, { lengthDays: 1, missesAllowed: 0, stake: 10 });
  });

  test('a challenge for today is active at once; one for tomorrow waits', async () => {
    const creator = await db.createUser('Ana');
    await db.give(creator, 20);
    const now = await create(creator, { startDate: await today(), stake: 10 });
    const later = await create(creator, { startDate: await today(TZ, 1), stake: 10 });
    assert.equal((await db.one(`select status from challenges where id = $1`, [now])).status, 'active');
    assert.equal((await db.one(`select status from challenges where id = $1`, [later])).status, 'open');
  });

  test('invite codes are different every time', async () => {
    const codes = new Set();
    for (let i = 0; i < 50; i++) codes.add((await db.one(`select invite_code() as c`)).c);
    assert.equal(codes.size, 50);
  });

  test('a signed-out caller cannot create or look up anything', async () => {
    await db.owner.query('begin');
    await db.owner.query('set local role anon');
    await assert.rejects(
      db.owner.query(`select create_challenge('pet_cat', 7, current_date, 7, 1, 0, 'UTC')`),
      /permission denied/,
    );
    await db.owner.query('rollback');
    await db.owner.query('begin');
    await db.owner.query('set local role anon');
    await assert.rejects(db.owner.query(`select invite_preview('ABCDEF')`), /permission denied/);
    await db.owner.query('rollback');
  });
});

describe('seeing challenges and invites', () => {
  test('signed-in users read the seven templates; nobody edits them from the app', async () => {
    const ana = await db.createUser('Ana');
    const rows = await db.as(ana, async (c) =>
      (await c.query(`select key, title, goal, recommendation, rule from challenge_templates order by position`)).rows,
    );
    assert.equal(rows.length, 7);
    assert.equal(rows[0].title, 'Read a Book');
    assert.equal(rows[6].title, 'Pet Cat');
    for (const row of rows) {
      for (const field of ['goal', 'recommendation', 'rule']) assert.ok(row[field].length > 0, `${row.key} ${field}`);
    }
    for (const sql of [
      `update challenge_templates set rule = 'Anything' where key = 'pet_cat'`,
      `delete from challenge_templates where key = 'pet_cat'`,
      `insert into challenge_templates (key, position, title, goal, recommendation, rule)
       values ('mine', 8, 'Mine', 'g', 'r', 'any photo')`,
    ]) {
      await assert.rejects(db.as(ana, (c) => c.query(sql)), /permission denied/);
    }
    await db.owner.query('begin');
    await db.owner.query('set local role anon');
    await assert.rejects(db.owner.query(`select * from challenge_templates`), /permission denied/);
    await db.owner.query('rollback');
  });

  test('the creator and members read the challenge; the creator alone reads the code', async () => {
    const { creator, challenge, code } = await setup();
    const ben = await db.createUser('Ben');
    await db.give(ben, 50);
    await db.join(ben, challenge);
    const carl = await db.createUser('Carl');

    const titles = async (user) =>
      db.as(user, async (c) => (await c.query(`select title from challenges`)).rows.map((r) => r.title));
    assert.deepEqual(await titles(creator), ['Read a Book']);
    assert.deepEqual(await titles(ben), ['Read a Book']);
    assert.deepEqual(await titles(carl), []);

    const codes = async (user) =>
      db.as(user, async (c) => (await c.query(`select code from invites`)).rows.map((r) => r.code));
    assert.deepEqual(await codes(creator), [code]);
    assert.deepEqual(await codes(ben), []);
    assert.deepEqual(await codes(carl), []);
  });

  test('members see each other\'s names, strangers see nothing, nobody sees roles', async () => {
    const { creator, challenge } = await setup();
    const ben = await db.createUser('Ben');
    await db.give(ben, 50);
    await db.join(ben, challenge);
    const carl = await db.createUser('Carl');

    const names = async (user) =>
      db.as(user, async (c) =>
        (await c.query(`select display_name from profiles order by display_name`)).rows.map((r) => r.display_name),
      );
    assert.deepEqual(await names(creator), ['Ana', 'Ben']);
    assert.deepEqual(await names(ben), ['Ana', 'Ben']);
    assert.deepEqual(await names(carl), ['Carl']);

    await assert.rejects(
      db.as(creator, (c) => c.query(`select role from profiles`)),
      /permission denied/,
    );
    await assert.rejects(
      db.as(creator, (c) => c.query(`select * from profiles`)),
      /permission denied/,
    );
  });

  test('the invite shows the details and whether you can join', async () => {
    const { creator, code } = await setup({ stake: 25 });
    const ben = await db.createUser('Ben');

    const p = await preview(ben, code);
    assert.equal(p.title, 'Read a Book');
    assert.equal(p.rule, BOOK_RULE);
    assert.equal(p.stake, 25);
    assert.equal(p.times_per_week, 7);
    assert.equal(p.length_days, 7);
    assert.equal(p.misses_allowed, 0);
    assert.equal(p.start_date, await today(TZ, 1));
    assert.equal(p.status, 'open');
    assert.equal(p.member_count, 1);
    assert.equal(p.creator_name, 'Ana');
    assert.equal(p.already_member, false);
    assert.equal(p.can_join, true);
    assert.equal(p.blocker, null);

    const mine = await preview(creator, code);
    assert.equal(mine.already_member, true);
    assert.equal(mine.can_join, false);
    assert.equal(mine.blocker, 'you are already in this challenge');
  });

  test('the code works typed in lower case with spaces around it', async () => {
    const { code } = await setup();
    const ben = await db.createUser('Ben');
    const p = await preview(ben, `  ${code.toLowerCase()} `);
    assert.equal(p.title, 'Read a Book');
  });

  test('a wrong code says so', async () => {
    const ben = await db.createUser('Ben');
    await assert.rejects(preview(ben, 'ZZZZZZ'), /no challenge matches this code/);
    await assert.rejects(preview(ben, ''), /no challenge matches this code/);
    await assert.rejects(preview(ben, null), /no challenge matches this code/);
  });

  test('after the first day nobody can join, leave, edit or delete', async () => {
    const { creator, challenge, code } = await setup();
    const ben = await db.createUser('Ben');
    await db.give(ben, 50);
    await db.join(ben, challenge);
    const carl = await db.createUser('Carl');
    await db.give(carl, 50);

    // The invite alone has expired.
    await db.owner.query(`update invites set expires_at = now() - interval '1 minute' where challenge_id = $1`, [
      challenge,
    ]);
    let p = await preview(carl, code);
    assert.equal(p.can_join, false);
    assert.equal(p.blocker, 'joining closed at the end of the first day');

    // The challenge is running and its first day is over.
    await db.owner.query(`update invites set expires_at = now() + interval '1 day' where challenge_id = $1`, [challenge]);
    await db.setStatus(challenge, 'active');
    p = await preview(carl, code);
    assert.equal(p.can_join, false);
    assert.equal(p.blocker, 'joining closed at the end of the first day');
    await assert.rejects(db.join(carl, challenge), /not open for joining/);
    await assert.rejects(db.as(ben, (c) => c.query(`select leave_challenge($1)`, [challenge])), /only leave before/);
    await assert.rejects(
      db.as(creator, (c) => c.query(`select update_challenge($1, 7, current_date, 7, 0)`, [challenge])),
      /cannot change after its first day/,
    );
    await assert.rejects(db.as(creator, (c) => c.query(`select delete_challenge($1)`, [challenge])), /cannot be deleted after its first day/);
    assert.equal(await db.poolBalance(challenge), 100);
  });

  test('during the first day of a running challenge people join and leave, and the creator can delete', async () => {
    const creator = await db.createUser('Ana');
    await db.give(creator, 50);
    const challenge = await create(creator, { startDate: await today(), stake: 50 });
    const code = await inviteCode(challenge);
    assert.equal((await db.one(`select status from challenges where id = $1`, [challenge])).status, 'active');

    const ben = await db.createUser('Ben');
    await db.give(ben, 50);
    const p = await preview(ben, code);
    assert.equal(p.status, 'active');
    assert.equal(p.can_join, true);
    assert.equal(typeof p.join_closes_at, 'string');
    await db.join(ben, challenge);
    assert.equal(await db.poolBalance(challenge), 100);

    await db.as(ben, (c) => c.query(`select leave_challenge($1)`, [challenge]));
    assert.equal(await db.balanceOf(ben), 50);
    await db.join(ben, challenge);

    await db.as(creator, (c) => c.query(`select update_challenge($1, 7, current_date, 1, 0)`, [challenge]));
    assert.equal((await db.one(`select length_days from challenges where id = $1`, [challenge])).length_days, 1);
    await assert.rejects(
      db.as(creator, (c) => c.query(`select update_challenge($1, 7, current_date + 1, 7, 0)`, [challenge])),
      /start date cannot change/,
    );

    await db.as(creator, (c) => c.query(`select delete_challenge($1)`, [challenge]));
    assert.equal(await db.balanceOf(creator), 50);
    assert.equal(await db.balanceOf(ben), 50);
  });

  test('a challenge holds at most 10 members, the creator included', async () => {
    const { challenge, code } = await setup();
    for (let i = 0; i < 9; i++) {
      const u = await db.createUser(`member${i}`);
      await db.give(u, 50);
      const p = await preview(u, code);
      assert.equal(p.can_join, true, `member ${i} can join`);
      await db.join(u, challenge);
    }
    const late = await db.createUser('late');
    await db.give(late, 50);
    const p = await preview(late, code);
    assert.equal(p.member_count, 10);
    assert.equal(p.can_join, false);
    assert.equal(p.blocker, 'this challenge is full (10 members)');
    await assert.rejects(db.join(late, challenge), /full/);
    assert.equal(await db.poolBalance(challenge), 500);
  });
});

describe('editing a challenge', () => {
  async function update(user, id, f) {
    return db.as(user, (c) =>
      c.query(`select update_challenge($1, $2, $3, $4, $5)`, [
        id,
        f.timesPerWeek,
        f.startDate,
        f.lengthDays,
        f.missesAllowed,
      ]),
    );
  }
  const changes = async () => ({
    timesPerWeek: 5,
    startDate: await today(TZ, 3),
    lengthDays: 14,
    missesAllowed: 2,
  });

  test('the creator changes the schedule but not the stake, title or rule; the invite follows', async () => {
    const { creator, challenge } = await setup();
    await update(creator, challenge, await changes());
    const c = await db.one(`select * from challenges where id = $1`, [challenge]);
    assert.equal(c.template, 'read_a_book');
    assert.equal(c.title, 'Read a Book');
    assert.equal(c.rule, BOOK_RULE);
    assert.equal(c.times_per_week, 5);
    assert.equal(c.length_days, 14);
    assert.equal(c.misses_allowed, 2);
    assert.equal(c.stake, 50);
    const { expires } = await db.one(
      `select (i.expires_at = challenge_join_closes_at(c.start_date, c.time_zone)) as expires
       from invites i join challenges c on c.id = i.challenge_id where c.id = $1`,
      [challenge],
    );
    assert.equal(expires, true);
    assert.equal(await db.poolBalance(challenge), 50);
  });

  test('members and strangers cannot edit', async () => {
    const { challenge } = await setup();
    const ben = await db.createUser('Ben');
    await db.give(ben, 50);
    await db.join(ben, challenge);
    const carl = await db.createUser('Carl');
    await assert.rejects(update(ben, challenge, await changes()), /only the creator can edit/);
    await assert.rejects(update(carl, challenge, await changes()), /only the creator can edit/);
    await assert.rejects(update(carl, '00000000-0000-0000-0000-000000000000', await changes()), /only the creator/);
    const c = await db.one(`select times_per_week from challenges where id = $1`, [challenge]);
    assert.equal(c.times_per_week, 7);
  });

  test('the title and rule cannot be edited at all', async () => {
    const { creator, challenge } = await setup();
    await assert.rejects(
      db.as(creator, (c) =>
        c.query(`select update_challenge($1, 'Renamed', 'New rule', 7, current_date + 1, 7, 0)`, [challenge]),
      ),
      /does not exist/,
    );
    await assert.rejects(
      db.as(creator, (c) => c.query(`update challenges set title = 'Renamed' where id = $1`, [challenge])),
      /permission denied/,
    );
    const c = await db.one(`select title, rule from challenges where id = $1`, [challenge]);
    assert.deepEqual(c, { title: 'Read a Book', rule: BOOK_RULE });
  });

  test('nothing changes once the challenge has started', async () => {
    const { creator, challenge } = await setup();
    await db.setStatus(challenge, 'active');
    await assert.rejects(update(creator, challenge, await changes()), /cannot change after its first day/);
  });

  test('edits are checked like new challenges', async () => {
    const { creator, challenge } = await setup();
    await assert.rejects(update(creator, challenge, { ...(await changes()), lengthDays: 40 }), /between 1 and 30/);
    await assert.rejects(update(creator, challenge, { ...(await changes()), missesAllowed: 14 }), /misses allowed/);
    await assert.rejects(update(creator, challenge, { ...(await changes()), timesPerWeek: 0 }), /times a week/);
  });
});

describe('deleting a challenge', () => {
  async function del(user, id) {
    return db.as(user, (c) => c.query(`select delete_challenge($1)`, [id]));
  }

  test('gives everyone their stake back and hides the challenge', async () => {
    const { creator, challenge, code } = await setup({ stake: 40 });
    const ben = await db.createUser('Ben');
    await db.give(ben, 45);
    await db.join(ben, challenge);
    assert.equal(await db.balanceOf(creator), 0);
    assert.equal(await db.balanceOf(ben), 5);

    await del(creator, challenge);

    assert.equal(await db.balanceOf(creator), 40);
    assert.equal(await db.balanceOf(ben), 45);
    assert.equal(await db.poolBalance(challenge), 0);
    const seen = async (user) => db.as(user, async (c) => (await c.query(`select id from challenges`)).rows.length);
    assert.equal(await seen(creator), 0);
    assert.equal(await seen(ben), 0);
    assert.equal((await db.one(`select count(*)::int as n from challenge_members where challenge_id = $1`, [challenge])).n, 0);
    assert.equal((await db.one(`select count(*)::int as n from invites where challenge_id = $1`, [challenge])).n, 0);
    const { deleted_at } = await db.one(`select deleted_at from challenges where id = $1`, [challenge]);
    assert.notEqual(deleted_at, null, 'the row stays for the ledger history');

    const carl = await db.createUser('Carl');
    await db.give(carl, 40);
    await assert.rejects(preview(carl, code), /no challenge matches this code/);
    await assert.rejects(db.join(carl, challenge), /not open for joining/);
    await assert.rejects(
      db.as(ben, (c) => c.query(`select leave_challenge($1)`, [challenge])),
      /only leave before/,
    );
    await assert.rejects(del(creator, challenge), /only the creator can delete/);

    const history = await db.as(ben, async (c) =>
      (await c.query(`select t.kind, t.note from ledger_transactions t order by t.created_at`)).rows,
    );
    assert.deepEqual(history.map((h) => h.kind), ['gift', 'stake', 'refund']);
    assert.equal(history[2].note, 'Refund: Read a Book was deleted');
  });

  test('deleting twice at once refunds once', async () => {
    const { creator, challenge } = await setup({ stake: 40 });
    const other = await db.connect();
    await db.owner.query('begin');
    await db.owner.query(`set local role authenticated`);
    await db.owner.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: 'authenticated', sub: creator }),
    ]);
    await db.owner.query(`select delete_challenge($1)`, [challenge]);
    const second = db.as(creator, (c) => c.query(`select delete_challenge($1)`, [challenge]), other);
    await new Promise((r) => setTimeout(r, 100));
    await db.owner.query('commit');
    await assert.rejects(second, /only the creator can delete/);
    assert.equal(await db.balanceOf(creator), 40);
  });

  test('members and strangers cannot delete; nothing can be deleted after the start', async () => {
    const { creator, challenge } = await setup();
    const ben = await db.createUser('Ben');
    await db.give(ben, 50);
    await db.join(ben, challenge);
    await assert.rejects(del(ben, challenge), /only the creator can delete/);
    await assert.rejects(del(await db.createUser('Carl'), challenge), /only the creator can delete/);
    await db.setStatus(challenge, 'active');
    await assert.rejects(del(creator, challenge), /cannot be deleted after its first day/);
    assert.equal(await db.poolBalance(challenge), 100);
  });
});

describe('starting', () => {
  test('moving the start date to today starts the challenge at once', async () => {
    const { creator, challenge } = await setup();
    const startToday = await today();
    await db.as(creator, (c) =>
      c.query(`select update_challenge($1, 7, $2, 7, 0)`, [challenge, startToday]),
    );
    assert.equal((await db.one(`select status from challenges where id = $1`, [challenge])).status, 'active');
  });

  test('the scheduled job starts challenges whose start date has come', async () => {
    const { creator, challenge } = await setup({ extra: 50 });
    const startDue = async () => (await db.one(`select start_due_challenges() as n`)).n;
    assert.equal(await startDue(), 0);
    assert.equal((await db.one(`select status from challenges where id = $1`, [challenge])).status, 'open');

    // Midnight has passed in Toronto: the start date is now today.
    await db.owner.query(`update challenges set start_date = (now() at time zone 'America/Toronto')::date where id = $1`, [
      challenge,
    ]);
    assert.equal(await startDue(), 1);
    assert.equal((await db.one(`select status from challenges where id = $1`, [challenge])).status, 'active');
    assert.equal(await startDue(), 0, 'nothing to start twice');

    // A deleted challenge is left alone.
    const gone = await create(creator);
    await db.as(creator, (c) => c.query(`select delete_challenge($1)`, [gone]));
    await db.owner.query(`update challenges set start_date = current_date - 1 where id = $1`, [gone]);
    assert.equal(await startDue(), 0);
    assert.equal((await db.one(`select status from challenges where id = $1`, [gone])).status, 'open');
  });

  test('the app cannot run the start job itself', async () => {
    const ana = await db.createUser('Ana');
    await assert.rejects(db.as(ana, (c) => c.query(`select start_due_challenges()`)), /permission denied/);
  });
});
