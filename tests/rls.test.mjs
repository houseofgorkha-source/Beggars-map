// RLS + public-data-boundary regression suite (remediation plan Phase 5).
//
// Covers exactly what C-1 and C-2 were: can an anonymous/authenticated
// caller forge admin-controlled columns on INSERT or UPDATE, and can they
// read columns the public data boundary (0017) is supposed to hide.
//
// Requires a running LOCAL Supabase stack (`npx supabase start`) — this is
// an integration test against real Postgres/PostgREST/RLS, not a pure
// function, and per this repo's own standing rule it must never run
// against production. If the local stack isn't reachable (e.g. in CI,
// which has no Docker Supabase stack running), every test in this file
// skips rather than fails — `npm test` must stay green in an environment
// with no local stack, per the smallest-useful-suite principle: a test
// that can't run isn't the same as a broken one.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const API = 'http://127.0.0.1:54321';
// The well-known local-dev anon key printed by every `supabase start` —
// not a secret, safe to hardcode (see AGENTS.md's own documented use of
// the same value in web/.env.local and this repo's other local-only
// tooling).
const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const SEED_USER_ID = '00000000-0000-0000-0000-000000000001';

let stackReachable = false;
try {
  const res = await fetch(`${API}/rest/v1/`, { headers: { apikey: ANON_KEY }, signal: AbortSignal.timeout(1500) });
  stackReachable = res.ok || res.status === 404; // PostgREST root can 404, that's still "reachable"
} catch {
  stackReachable = false;
}

// The 16 columns C-1/P1-1/P1-2 lock down, with an escalated/adversarial
// value for each — mirrors exactly what was hand-tested live during P1's
// implementation, now captured as a re-runnable regression test.
const FORGED_FIELDS = {
  is_hidden: true,
  archived_at: '2020-01-01T00:00:00Z',
  verification_status: 'human_verified',
  source: 'admin',
  actor_type: 'admin',
  actor_label: 'forged-admin-label',
  evidence_url: 'https://forged.example.com',
  evidence_date: '2020-01-01',
  last_modified_by: 'forged@example.com',
  reviewed_at: '2020-01-01T00:00:00Z',
  reviewed_by: 'forged@example.com',
  location_source: 'admin',
  location_confidence: 'human_confirmed',
  location_verified_at: '2020-01-01T00:00:00Z',
  location_verified_by: 'forged@example.com',
  provider_place_ids: { google: 'forged-place-id' },
};

const TRUE_DEFAULTS = {
  is_hidden: false,
  archived_at: null,
  verification_status: 'unverified',
  source: 'user',
  actor_type: 'user',
  actor_label: null,
  evidence_url: null,
  evidence_date: null,
  last_modified_by: null,
  reviewed_at: null,
  reviewed_by: null,
  location_source: 'unknown',
  location_confidence: 'unknown',
  location_verified_at: null,
  location_verified_by: null,
  provider_place_ids: {},
};

async function createAnonSession() {
  const res = await fetch(`${API}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = await res.json();
  const userId = body.user?.id ?? body.id;
  const jwt = body.access_token;
  await fetch(`${API}/rest/v1/profiles`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: userId, display_name: 'rls.test.mjs' }),
  });
  return { userId, jwt };
}

async function serviceDelete(table, id) {
  await fetch(`${API}/rest/v1/${table}?id=eq.${id}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
}

// Reads a row back via service_role (bypasses the 0017 column grant
// entirely) rather than via the caller's own RETURNING clause. This is
// deliberate, not a convenience: under a column-level grant, PostgREST's
// `Prefer: return=representation` without an explicit `select=` defaults
// to `RETURNING *`, which requires table-level SELECT the same way a bare
// `select('*')` read does (see 0017's own header comment) — the real app
// never hits this, since supabase-js only sends return=representation
// when `.select()` is chained with an explicit column list (AddListingModal
// selects just 'id'; AddListingScreen doesn't chain .select() at all, so it
// gets return=minimal). Reading back via service_role sidesteps needing to
// choose between "make the test insert unrealistic" and "can't verify the
// admin-only fields' values at all as anon".
async function serviceRead(table, id) {
  const res = await fetch(`${API}/rest/v1/${table}?id=eq.${id}`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  const rows = await res.json();
  return rows[0];
}

describe('RLS: INSERT/UPDATE privilege escalation (C-1)', { skip: !stackReachable && 'local Supabase stack not reachable at 127.0.0.1:54321' }, () => {
  let session;
  let listingId;

  before(async () => {
    session = await createAnonSession();
  });

  after(async () => {
    if (listingId) await serviceDelete('listings', listingId);
    if (session?.userId) await serviceDelete('profiles', session.userId);
  });

  test('a forged INSERT setting all 16 admin-controlled fields lands at their true defaults', async () => {
    // select=id only — exactly what AddListingModal.tsx's real insert does.
    // A bare Prefer: return=representation with no select= would default
    // to RETURNING *, which fails under 0017's column grant the same way
    // select('*') does; that is not a real path the app ever exercises.
    const res = await fetch(`${API}/rest/v1/listings?select=id`, {
      method: 'POST',
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${session.jwt}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        created_by: session.userId,
        name: 'rls.test.mjs forged insert',
        price_rupees: 50,
        latitude: 12.97,
        longitude: 77.59,
        ...FORGED_FIELDS,
      }),
    });
    assert.equal(res.status, 201, 'the insert itself must still succeed — only the admin fields should be reset');
    const [{ id }] = await res.json();
    listingId = id;
    const row = await serviceRead('listings', id);
    for (const [field, defaultValue] of Object.entries(TRUE_DEFAULTS)) {
      assert.deepEqual(row[field], defaultValue, `${field} should have landed at its default, not the forged value`);
    }
  });

  test('a forged UPDATE on the same row reverts all 16 fields while a legitimate field still updates', async () => {
    const res = await fetch(`${API}/rest/v1/listings?id=eq.${listingId}&select=id`, {
      method: 'PATCH',
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${session.jwt}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ price_rupees: 65, ...FORGED_FIELDS }),
    });
    assert.equal(res.status, 200);
    const row = await serviceRead('listings', listingId);
    assert.equal(row.price_rupees, 65, 'a legitimate field must still be editable');
    for (const [field, defaultValue] of Object.entries(TRUE_DEFAULTS)) {
      assert.deepEqual(row[field], defaultValue, `${field} should have reverted, not accepted the forged value`);
    }
  });

  test('an ordinary insert with only public fields is unaffected', async () => {
    const res = await fetch(`${API}/rest/v1/listings?select=id`, {
      method: 'POST',
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${session.jwt}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ created_by: session.userId, name: 'rls.test.mjs ordinary insert', price_rupees: 30, latitude: 12.9, longitude: 77.6 }),
    });
    assert.equal(res.status, 201);
    const [{ id }] = await res.json();
    await serviceDelete('listings', id);
  });

  test('service_role can still set admin fields directly (INSERT and UPDATE)', async () => {
    const insertRes = await fetch(`${API}/rest/v1/listings`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        created_by: SEED_USER_ID,
        name: 'rls.test.mjs service-role insert',
        price_rupees: 55,
        latitude: 12.96,
        longitude: 77.58,
        is_hidden: true,
        source: 'import',
        actor_type: 'discovery_pipeline',
      }),
    });
    assert.equal(insertRes.status, 201);
    const [row] = await insertRes.json();
    assert.equal(row.is_hidden, true);
    assert.equal(row.source, 'import');
    await serviceDelete('listings', row.id);
  });
});

describe('Public data boundary (C-2)', { skip: !stackReachable && 'local Supabase stack not reachable at 127.0.0.1:54321' }, () => {
  test('select(*) on listings is blocked (table-level SELECT is not granted)', async () => {
    const res = await fetch(`${API}/rest/v1/listings?select=*&limit=1`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } });
    assert.equal(res.status, 401);
  });

  test('admin-only columns cannot be read even when named explicitly', async () => {
    const res = await fetch(`${API}/rest/v1/listings?select=id,reviewed_by,source,verification_status,location_source&limit=1`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, '42501');
  });

  test('the public column set still returns real data', async () => {
    // Deliberately no `votes(count)` embed here — 0019 revokes all direct
    // grants on `votes`, including the table-level access PostgREST's
    // embedded-resource count needs to expand; see that migration and the
    // dedicated 'Votes privacy boundary' suite below for how vote counts
    // are read instead (the `listing_vote_counts` view).
    const res = await fetch(
      `${API}/rest/v1/listings?select=id,created_by,name,note,price_rupees,photo_url,latitude,longitude,city,created_at,location_label&limit=1`,
      { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } }
    );
    assert.equal(res.status, 200);
    const rows = await res.json();
    assert.ok(rows.length > 0, 'expected at least one listing in the local seed/test data');
    assert.ok(!('reviewed_by' in rows[0]), 'reviewed_by must never appear even when not explicitly excluded from the response shape');
  });

  test('reviews is no longer publicly readable', async () => {
    const res = await fetch(`${API}/rest/v1/reviews?select=*&limit=1`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } });
    assert.equal(res.status, 200); // RLS default-deny with no permissive policy returns 200 + []
    const rows = await res.json();
    assert.deepEqual(rows, []);
  });

  test('listing_ratings is no longer publicly readable', async () => {
    const res = await fetch(`${API}/rest/v1/listing_ratings?select=*&limit=1`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } });
    assert.equal(res.status, 401);
  });

});

describe('Votes privacy boundary (P2 / 0019)', { skip: !stackReachable && 'local Supabase stack not reachable at 127.0.0.1:54321' }, () => {
  let sessionA;
  let sessionB;
  let listingId;

  before(async () => {
    sessionA = await createAnonSession();
    sessionB = await createAnonSession();
    // Any real listing works — vote RPCs don't care about is_hidden.
    const res = await fetch(`${API}/rest/v1/listings?select=id&limit=1`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } });
    [{ id: listingId }] = await res.json();
  });

  after(async () => {
    await fetch(`${API}/rest/v1/rpc/remove_vote`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${sessionA.jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_listing_id: listingId }),
    });
    if (sessionA?.userId) await serviceDelete('profiles', sessionA.userId);
    if (sessionB?.userId) await serviceDelete('profiles', sessionB.userId);
  });

  async function rpc(name, jwt, body) {
    return fetch(`${API}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('direct table reads of votes are fully blocked (no bulk enumeration of (listing_id, created_by))', async () => {
    const res = await fetch(`${API}/rest/v1/votes?select=*&limit=1`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${sessionA.jwt}` } });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, '42501');
  });

  test('the public vote-count view exposes only listing_id/vote_count, never created_by', async () => {
    const res = await fetch(`${API}/rest/v1/listing_vote_counts?select=*&limit=1`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } });
    assert.equal(res.status, 200);
    const explicitRes = await fetch(`${API}/rest/v1/listing_vote_counts?select=created_by&limit=1`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } });
    assert.equal(explicitRes.status, 400, 'created_by must not exist on this view at all');
  });

  test('a user can vote for themselves, and has_voted reflects it', async () => {
    assert.equal((await (await rpc('has_voted', sessionA.jwt, { p_listing_id: listingId })).json()), false);
    const addRes = await rpc('add_vote', sessionA.jwt, { p_listing_id: listingId });
    assert.equal(addRes.status, 204);
    assert.equal((await (await rpc('has_voted', sessionA.jwt, { p_listing_id: listingId })).json()), true);
  });

  test('duplicate self-vote is a no-op, not a second row (dedupe protection intact)', async () => {
    const res = await rpc('add_vote', sessionA.jwt, { p_listing_id: listingId });
    assert.equal(res.status, 204);
    const countRes = await fetch(`${API}/rest/v1/listing_vote_counts?listing_id=eq.${listingId}`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } });
    const [row] = await countRes.json();
    assert.equal(row.vote_count, 1);
  });

  test("has_voted for a different user never reflects someone else's vote (no identity leak)", async () => {
    assert.equal((await (await rpc('has_voted', sessionB.jwt, { p_listing_id: listingId })).json()), false);
  });

  test("a user cannot manipulate another user's vote — remove_vote only ever targets the caller's own row", async () => {
    const res = await rpc('remove_vote', sessionB.jwt, { p_listing_id: listingId });
    assert.equal(res.status, 204, "B's own remove_vote call must still succeed (as a no-op), even though B never voted");
    assert.equal((await (await rpc('has_voted', sessionA.jwt, { p_listing_id: listingId })).json()), true, "A's vote must survive B calling remove_vote — there is no user-id parameter to target A with");
  });

  test('a user can remove their own vote', async () => {
    const res = await rpc('remove_vote', sessionA.jwt, { p_listing_id: listingId });
    assert.equal(res.status, 204);
    assert.equal((await (await rpc('has_voted', sessionA.jwt, { p_listing_id: listingId })).json()), false);
  });

  test('an unauthenticated caller (bare anon key, no user JWT) gets a safe false, never an error leaking data', async () => {
    const res = await rpc('has_voted', ANON_KEY, { p_listing_id: listingId });
    assert.equal(res.status, 200);
    assert.equal(await res.json(), false);
  });

  test('service_role retains full direct access to votes (account-deletion cascade, admin tooling)', async () => {
    const res = await fetch(`${API}/rest/v1/votes?select=*&limit=1`, { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } });
    assert.equal(res.status, 200);
  });
});
