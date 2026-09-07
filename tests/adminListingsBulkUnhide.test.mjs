// Functional test for admin-listings' bulkUnhide action (2026-09-08),
// against the LOCAL Supabase stack's real Edge Functions server. Mirrors
// tests/adminAuth.test.mjs's own JWT-minting convention (same local dev
// secret, same fixture admin user) — never attempt this against
// production.
//
// Covers exactly the properties this feature must have:
//   - reuses the existing, unmodified unhideListing() — only is_hidden
//     changes, one admin_audit_log entry per listing
//   - touches ONLY the listing IDs explicitly passed, never anything else
//     (no filters-sweep mode exists for this action at all)
//   - rejects an empty/missing listingIds array
//   - a bad ID partway through a batch stops the batch and reports how
//     many succeeded before it, same as bulkMarkReviewed's own behavior

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const API = 'http://127.0.0.1:54321';
const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';
const ADMIN_USER_ID = '11111111-1111-1111-1111-111111111111';
const ADMIN_EMAIL = 'houseofgorkha@gmail.com';
const SEED_PROFILE_ID = '00000000-0000-0000-0000-000000000001';

let stackReachable = false;
try {
  const res = await fetch(`${API}/functions/v1/admin-listings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'list', pageSize: 1 }),
    signal: AbortSignal.timeout(2000),
  });
  // Any real HTTP response (even 401) means the function server is up —
  // a 503/connection error means it isn't being served right now.
  stackReachable = res.status !== 503;
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

// Set by before() to whichever auth.users id actually owns ADMIN_EMAIL
// locally (see findOrCreateAdminFixtureUser).
let resolvedAdminUserId = ADMIN_USER_ID;

function adminJwt() {
  const now = Math.floor(Date.now() / 1000);
  return signHs256({
    aud: 'authenticated',
    role: 'authenticated',
    sub: resolvedAdminUserId,
    email: ADMIN_EMAIL,
    iat: now,
    exp: now + 3600,
  });
}

function runSql(sql) {
  const result = spawnSync('npx', ['supabase', 'db', 'query', '--local', JSON.stringify(sql)], { encoding: 'utf8', shell: true });
  if (result.status !== 0) throw new Error(`SQL failed: ${result.stderr || result.stdout}`);
}

function querySql(sql) {
  const result = spawnSync('npx', ['supabase', 'db', 'query', '--local', '--output-format', 'json', JSON.stringify(sql)], {
    encoding: 'utf8',
    shell: true,
  });
  if (result.status !== 0) throw new Error(`SQL failed: ${result.stderr || result.stdout}`);
  const out = result.stdout.trim();
  const start = out.search(/[{[]/);
  const parsed = JSON.parse(out.slice(start));
  return Array.isArray(parsed) ? parsed : parsed.rows;
}

// Finds or creates a local auth.users row for ADMIN_EMAIL, returning
// whichever id actually owns that email — never assumes the synthetic
// ADMIN_USER_ID is free. A real local Google sign-in against this same
// stack (see AGENTS.md's own documented "local-only auth gotcha") can
// leave this email already owned by a different, real user id; inserting
// the fixture row unconditionally then fails on auth.users'
// users_email_partial_key unique constraint, since `on conflict (id)`
// only guards the id column, not email. Reusing whichever id is already
// there — rather than deleting/overwriting a real session's data — keeps
// this test from ever touching pre-existing local auth state.
function findOrCreateAdminFixtureUser() {
  const existing = querySql(`select id from auth.users where email = '${ADMIN_EMAIL}';`);
  if (existing.length > 0) return existing[0].id;

  const sql = `insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, instance_id, confirmation_token, recovery_token, email_change_token_new, email_change) values ('${ADMIN_USER_ID}', 'authenticated', 'authenticated', '${ADMIN_EMAIL}', '', now(), now(), now(), '00000000-0000-0000-0000-000000000000', '', '', '', '') on conflict (id) do nothing;`;
  runSql(sql);
  return ADMIN_USER_ID;
}

async function callBulkUnhide(listingIds) {
  const res = await fetch(`${API}/functions/v1/admin-listings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminJwt()}` },
    body: JSON.stringify({ action: 'bulkUnhide', listingIds }),
  });
  return { status: res.status, body: await res.json() };
}

describe(
  'admin-listings bulkUnhide (functional, local stack)',
  { skip: !stackReachable && 'local Supabase Edge Functions not reachable at 127.0.0.1:54321 (run "npx supabase functions serve")' },
  () => {
    // Four fixture listings: two intended targets (currently hidden), one
    // decoy that is ALSO hidden but deliberately NOT selected (proves the
    // action never sweeps beyond its explicit listingIds), and one that
    // was already visible (proves an already-visible row is left alone
    // too, and never appears as a false "changed" case).
    const targetId1 = randomUUID();
    const targetId2 = randomUUID();
    const decoyHiddenId = randomUUID();
    const alreadyVisibleId = randomUUID();

    before(() => {
      resolvedAdminUserId = findOrCreateAdminFixtureUser();
      const insert = (id, name, hidden) =>
        `insert into listings (id, created_by, name, price_rupees, latitude, longitude, is_hidden) values ('${id}', '${SEED_PROFILE_ID}', '${name}', 50, 12.9, 77.6, ${hidden}) on conflict (id) do nothing;`;
      runSql(insert(targetId1, 'bulkUnhide test target 1', true));
      runSql(insert(targetId2, 'bulkUnhide test target 2', true));
      runSql(insert(decoyHiddenId, 'bulkUnhide test decoy (hidden, not selected)', true));
      runSql(insert(alreadyVisibleId, 'bulkUnhide test already-visible', false));
    });

    after(() => {
      // admin_audit_log is deliberately immutable (append-only, enforced at
      // the DB level) — the test's own audit rows are never deleted, same
      // as any other audit-logged action exercised by a test. Only the
      // fixture listings themselves are cleaned up.
      runSql(`delete from listings where id in ('${targetId1}', '${targetId2}', '${decoyHiddenId}', '${alreadyVisibleId}');`);
    });

    test('rejects a missing listingIds array', async () => {
      const res = await fetch(`${API}/functions/v1/admin-listings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminJwt()}` },
        body: JSON.stringify({ action: 'bulkUnhide' }),
      });
      assert.equal(res.status, 400);
    });

    test('rejects an empty listingIds array', async () => {
      const { status } = await callBulkUnhide([]);
      assert.equal(status, 400);
    });

    test('unhides exactly the targeted listings, touches nothing else', async () => {
      const { status, body } = await callBulkUnhide([targetId1, targetId2]);
      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.equal(body.updatedCount, 2);

      const rows = querySql(
        `select id, is_hidden, name, price_rupees, latitude, longitude from listings where id in ('${targetId1}', '${targetId2}', '${decoyHiddenId}', '${alreadyVisibleId}') order by name;`
      );
      const byId = new Map(rows.map((r) => [r.id, r]));

      assert.equal(byId.get(targetId1).is_hidden, false, 'target 1 should now be unhidden');
      assert.equal(byId.get(targetId2).is_hidden, false, 'target 2 should now be unhidden');
      assert.equal(byId.get(decoyHiddenId).is_hidden, true, 'decoy (not selected) must remain hidden — never swept up');
      assert.equal(byId.get(alreadyVisibleId).is_hidden, false, 'already-visible row stays visible (was never hidden)');

      // Only is_hidden changed — every other field on the targets is
      // exactly what was inserted.
      assert.equal(byId.get(targetId1).name, 'bulkUnhide test target 1');
      assert.equal(byId.get(targetId1).price_rupees, 50);
      assert.equal(byId.get(targetId1).latitude, 12.9);
      assert.equal(byId.get(targetId1).longitude, 77.6);
    });

    test('writes one admin_audit_log "unhide" entry per targeted listing, none for the untouched decoy', async () => {
      const auditRows = querySql(
        `select target_id, action, actor_label from admin_audit_log where target_id in ('${targetId1}', '${targetId2}', '${decoyHiddenId}') and action = 'unhide' order by target_id;`
      );
      const targetIds = auditRows.map((r) => r.target_id).sort();
      assert.deepEqual(targetIds, [targetId1, targetId2].sort());
      for (const row of auditRows) {
        assert.equal(row.actor_label, ADMIN_EMAIL);
      }
    });

    test('a bad ID partway through the batch stops the batch and reports how many succeeded first', async () => {
      // Re-hide target1 first so there's something real to unhide again.
      runSql(`update listings set is_hidden = true where id = '${targetId1}';`);
      const bogusId = randomUUID(); // well-formed UUID, but no such listing
      const { status, body } = await callBulkUnhide([targetId1, bogusId]);
      assert.equal(status, 404); // unhideListing's own "Listing not found" status
      assert.match(body.error, /Failed partway through \(1 succeeded\)/);

      const [row] = querySql(`select is_hidden from listings where id = '${targetId1}';`);
      assert.equal(row.is_hidden, false, 'the listing before the bad ID should still have been unhidden');
    });

    test('no Authorization header -> 401 (same boundary every admin-listings action already enforces)', async () => {
      const res = await fetch(`${API}/functions/v1/admin-listings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bulkUnhide', listingIds: [targetId1] }),
      });
      assert.equal(res.status, 401);
    });
  }
);
