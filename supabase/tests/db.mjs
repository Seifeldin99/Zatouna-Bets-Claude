// Starts a throwaway local Postgres, loads the Supabase shim and every
// migration into a template database, and hands each test its own copy.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const here = import.meta.dirname;
const migrationsDir = join(here, '..', 'migrations');

function pgBin(name) {
  if (process.env.PG_BIN) return join(process.env.PG_BIN, name);
  try {
    return join(execFileSync('pg_config', ['--bindir']).toString().trim(), name);
  } catch {
    return name;
  }
}

let server;

export async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), 'zatouna-pg-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  execFileSync(pgBin('initdb'), ['-D', dir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], {
    stdio: 'ignore',
  });
  const proc = spawn(pgBin('postgres'), ['-D', dir, '-p', String(port), '-k', dir, '-c', 'fsync=off'], {
    stdio: 'ignore',
  });
  const config = { host: dir, port, user: 'postgres' };
  for (let i = 0; ; i++) {
    try {
      const c = new pg.Client({ ...config, database: 'postgres' });
      await c.connect();
      await c.end();
      break;
    } catch (err) {
      if (i > 100) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const admin = new pg.Client({ ...config, database: 'postgres' });
  await admin.connect();
  await admin.query('create database template_zatouna');
  const t = new pg.Client({ ...config, database: 'template_zatouna' });
  await t.connect();
  await t.query(readFileSync(join(here, 'supabase-shim.sql'), 'utf8'));
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    await t.query(readFileSync(join(migrationsDir, file), 'utf8'));
  }
  await t.end();

  server = { dir, proc, config, admin };
  return server;
}

export async function stopServer() {
  if (!server) return;
  await server.admin.end();
  server.proc.kill('SIGINT');
  await new Promise((r) => server.proc.once('exit', r));
  rmSync(server.dir, { recursive: true, force: true });
  server = undefined;
}

// A fresh database for one test, with helpers to act as different callers.
export async function freshDb() {
  const name = 'test_' + randomUUID().replaceAll('-', '');
  await server.admin.query(`create database ${name} template template_zatouna`);
  const clients = [];
  const connect = async () => {
    const c = new pg.Client({ ...server.config, database: name });
    await c.connect();
    clients.push(c);
    return c;
  };
  const owner = await connect();

  const db = {
    owner,
    connect,
    // Runs fn inside one database transaction as a signed-in user, or as the
    // server (userId = 'service_role'), the way Supabase's API does.
    async as(userId, fn, client) {
      const c = client ?? owner;
      const claims =
        userId === 'service_role' ? { role: 'service_role' } : { role: 'authenticated', sub: userId };
      await c.query('begin');
      try {
        await c.query(`set local role ${claims.role}`);
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        const result = await fn(c);
        await c.query('commit');
        return result;
      } catch (err) {
        await c.query('rollback');
        throw err;
      }
    },
    async one(sql, params = []) {
      return (await owner.query(sql, params)).rows[0];
    },
    async createUser(name, { role = 'member' } = {}) {
      const { id } = await db.one(
        `insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`,
        [`${name}@test.local`, { display_name: name }],
      );
      if (role !== 'member') await owner.query(`update profiles set role = $1 where id = $2`, [role, id]);
      return id;
    },
    async balanceOf(userId) {
      const row = await db.one(
        `select coalesce(sum(e.amount), 0)::int as b from ledger_accounts a
         left join ledger_entries e on e.account_id = a.id
         where a.kind = 'wallet' and a.user_id = $1`,
        [userId],
      );
      return row.b;
    },
    async systemBalance(kind) {
      return (await db.one(`select balance::int as b from ledger_balances where kind = $1`, [kind])).b;
    },
    async poolBalance(challengeId) {
      const row = await db.one(
        `select coalesce(sum(balance), 0)::int as b from ledger_balances where kind = 'pool' and challenge_id = $1`,
        [challengeId],
      );
      return row.b;
    },
    async give(userId, amount) {
      await db.as('service_role', (c) =>
        c.query(`select admin_grant_tokens($1, $2, 'test gift', $3)`, [userId, amount, randomUUID()]),
      );
    },
    async createChallenge({ creator, stake, title = 'Read 20 minutes', status = 'open', fee = 10 }) {
      const row = await db.one(
        `insert into challenges (creator_id, title, stake, app_fee_percent, status)
         values ($1, $2, $3, $4, $5) returning id`,
        [creator, title, stake, fee, status],
      );
      return row.id;
    },
    async join(userId, challengeId, client) {
      return db.as(
        userId,
        async (c) => (await c.query(`select join_challenge($1, 'America/Toronto') as id`, [challengeId])).rows[0].id,
        client,
      );
    },
    async setStatus(challengeId, status) {
      await owner.query(`update challenges set status = $1 where id = $2`, [status, challengeId]);
    },
    async setResult(challengeId, userId, result) {
      await owner.query(`update challenge_members set result = $1 where challenge_id = $2 and user_id = $3`, [
        result,
        challengeId,
        userId,
      ]);
    },
    async settle(challengeId, client) {
      return db.as(
        'service_role',
        async (c) => (await c.query(`select settle_challenge($1) as r`, [challengeId])).rows[0].r,
        client,
      );
    },
    async close() {
      await Promise.all(clients.map((c) => c.end()));
      await server.admin.query(`drop database ${name} with (force)`);
    },
  };
  return db;
}
