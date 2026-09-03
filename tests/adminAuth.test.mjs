// Admin authorization boundary regression suite (remediation plan Phase 5).
//
// Covers the three-way boundary every admin-* Edge Function's
// _shared/adminAuth.ts is supposed to enforce: no auth -> 401, a real but
// non-admin JWT -> 403, a real admin JWT -> 200. This is what would have
// caught a regression in that shared check before it reached production.
//
// Requires a running LOCAL Supabase stack with its Edge Functions served
// (`npx supabase start`, which serves functions automatically) — skips
// entirely if unreachable, same reasoning as tests/rls.test.mjs. Never
// attempt this JWT-minting approach against production: it only works
// here because it's signed with the local stack's well-known, published
// dev JWT secret (see AGENTS.md's "Local testing convention for this
// feature").

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const API = 'http://127.0.0.1:54321';
const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';
const ADMIN_USER_ID = '11111111-1111-1111-1111-111111111111';
const ADMIN_EMAIL = 'houseofgorkha@gmail.com'; // must match the local ADMIN_EMAILS secret (supabase/functions/.env)
const NON_ADMIN_USER_ID = '22222222-2222-2222-2222-222222222222';
const NON_ADMIN_EMAIL = 'notadmin.test@example.com';

let stackReachable = false;
try {
  const res = await fetch(`${API}/rest/v1/`, { headers: { apikey: 'probe' }, signal: AbortSignal.timeout(1500) });
  stackReachable = true; // any HTTP response at all means the gateway is up; auth failure on this probe is expected/irrelevant
} catch {
  stackReachable = false;
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signHs256(payload) {
  const encHeader = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const encPayload = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', JWT_SECRET)
    .update(`${encHeader}.${encPayload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${encHeader}.${encPayload}.${signature}`;
}

function testJwt({ sub, email }) {
  const now = Math.floor(Date.now() / 1000);
  return signHs256({ aud: 'authenticated', role: 'authenticated', sub, email, iat: now, exp: now + 3600 });
}

// Ensures the two fixture auth.users rows this suite needs actually exist
// locally, without depending on them having been manually seeded by a
// human first — a test that needs an undocumented manual setup step is
// fragile. Uses the CLI the same way this repo's own scripts/*.mjs do
// (spawnSync against `supabase db query --local`), never --linked.
function ensureFixtureUsers() {
  // Deliberately a single line — spawnSync's shell:true on Windows mangles
  // embedded newlines inside a quoted argument (confirmed directly: the
  // identical multi-line SQL fails with a shell-level quoting error, the
  // same class of issue scripts/backup-local-db.mjs already documents for
  // this exact CLI-invocation pattern).
  const sql = `insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, instance_id, confirmation_token, recovery_token, email_change_token_new, email_change) values ('${ADMIN_USER_ID}', 'authenticated', 'authenticated', '${ADMIN_EMAIL}', '', now(), now(), now(), '00000000-0000-0000-0000-000000000000', '', '', '', ''), ('${NON_ADMIN_USER_ID}', 'authenticated', 'authenticated', '${NON_ADMIN_EMAIL}', '', now(), now(), now(), '00000000-0000-0000-0000-000000000000', '', '', '', '') on conflict (id) do nothing;`;
  const result = spawnSync('npx', ['supabase', 'db', 'query', '--local', JSON.stringify(sql)], { encoding: 'utf8', shell: true });
  if (result.status !== 0) {
    throw new Error(`Could not seed local admin-auth fixture users: ${result.stderr || result.stdout}`);
  }
}

const FUNCTIONS = ['admin-listings', 'admin-dashboard', 'admin-reports'];

describe('Admin auth boundary (401 / 403 / 200)', { skip: !stackReachable && 'local Supabase stack not reachable at 127.0.0.1:54321' }, () => {
  let adminJwt;
  let nonAdminJwt;

  before(() => {
    ensureFixtureUsers();
    adminJwt = testJwt({ sub: ADMIN_USER_ID, email: ADMIN_EMAIL });
    nonAdminJwt = testJwt({ sub: NON_ADMIN_USER_ID, email: NON_ADMIN_EMAIL });
  });

  for (const fn of FUNCTIONS) {
    test(`${fn}: no Authorization header -> 401`, async () => {
      const res = await fetch(`${API}/functions/v1/${fn}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list' }),
      });
      assert.equal(res.status, 401);
    });

    test(`${fn}: real non-admin JWT -> 403`, async () => {
      const res = await fetch(`${API}/functions/v1/${fn}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${nonAdminJwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list' }),
      });
      assert.equal(res.status, 403);
    });

    test(`${fn}: real admin JWT -> 200`, async () => {
      const res = await fetch(`${API}/functions/v1/${fn}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: fn === 'admin-dashboard' ? 'stats' : 'list' }),
      });
      assert.equal(res.status, 200, await res.text());
    });
  }
});
