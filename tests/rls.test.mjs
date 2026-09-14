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
//
// location_source and provider_place_ids are a deliberate, narrower
// exception since the location-accuracy plan's Step 3 (0025): a client
// INSERT may now keep a genuinely non-escalating claim for these two
// specifically (location_source ∈ user_pin/device_gps/ola/google;
// provider_place_ids when it's actually a valid object-of-strings) instead
// of always collapsing to the default — see 0025's own header for the full
// reasoning. What must still be provably impossible, and is still forged
// here, is outright ESCALATION: 'admin'/'import' for location_source (real
// admin-only values, same trust tier as every other field in this fixture),
// and an invalidly-shaped provider_place_ids (an array, not an object of
// strings) — both still must revert to their true default below. The
// positive case (a legitimately-shaped, non-escalating claim actually
// persisting) has its own separate test further down, since asserting it
// here would contradict this test's own "everything reverts" premise.
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
  // An array, not an object-of-strings — still an invalid shape under 0025's
  // is_valid_provider_place_ids, so this must still revert to {}. (A
  // validly-shaped value like { google: '...' } is exactly what 0025 now
  // deliberately lets through — see the separate positive-case test below.)
  provider_place_ids: ['forged', 'array', 'shape'],
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

  // The positive case 0025 (location-accuracy plan, Step 3) deliberately
  // adds: a client INSERT claiming a real, non-escalating location_source
  // plus a validly-shaped provider_place_ids (exactly what the POI-tap
  // flow in AddListingModal.tsx now sends) must actually persist, not
  // revert — this is the whole point of 0025, and the two tests above
  // would give a false sense of security if this side were never checked.
  test('a genuine, non-escalating location_source + valid provider_place_ids persists on INSERT', async () => {
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
        name: 'rls.test.mjs genuine POI-tap insert',
        price_rupees: 50,
        latitude: 12.972322,
        longitude: 77.7344565,
        location_source: 'google',
        provider_place_ids: { google: 'a-real-looking-place-id' },
      }),
    });
    assert.equal(res.status, 201);
    const [{ id }] = await res.json();
    const row = await serviceRead('listings', id);
    assert.equal(row.location_source, 'google', 'a real, non-escalating source must persist as submitted');
    assert.deepEqual(row.provider_place_ids, { google: 'a-real-looking-place-id' }, 'a validly-shaped provider_place_ids must persist as submitted');
    // Still fully protected regardless — 0025 never touches these.
    assert.equal(row.location_confidence, 'unknown');
    assert.equal(row.location_verified_at, null);
    assert.equal(row.location_verified_by, null);
    await serviceDelete('listings', id);
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

// Security remediation S3 (2026-09-15): listing_photos/listing_review_photos
// must only ever accept this project's own listing-photos storage URLs —
// their INSERT policies only checked row ownership, never the URL's actual
// target, so an owner could previously attach an arbitrary external URL
// (tracking pixel, offensive content) with no upload required at all.
describe('Photo URL bucket restriction (S3 / 0026)', { skip: !stackReachable && 'local Supabase stack not reachable at 127.0.0.1:54321' }, () => {
  let session;
  let listingId;
  let reviewId;

  before(async () => {
    session = await createAnonSession();
    const res = await fetch(`${API}/rest/v1/listings?select=id`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.jwt}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ created_by: session.userId, name: 'rls.test.mjs photo-url fixture', price_rupees: 40, latitude: 12.9, longitude: 77.6 }),
    });
    [{ id: listingId }] = await res.json();
    // listing_reviews INSERT is RPC-only as of 0030 (S8) — a raw POST to
    // the table no longer works for anon/authenticated.
    const reviewRes = await fetch(`${API}/rest/v1/rpc/upsert_my_review`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_listing_id: listingId, p_rating: 4, p_review_text: null }),
    });
    reviewId = await reviewRes.json();
  });

  after(async () => {
    if (reviewId) await serviceDelete('listing_reviews', reviewId);
    if (listingId) await serviceDelete('listings', listingId);
    if (session?.userId) await serviceDelete('profiles', session.userId);
  });

  test('listing_photos: a real listing-photos bucket URL succeeds', async () => {
    const res = await fetch(`${API}/rest/v1/listing_photos?select=id`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.jwt}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({
        listing_id: listingId,
        photo_url: `https://nvingzluboafxzxgxxwc.supabase.co/storage/v1/object/public/listing-photos/${session.userId}/test.jpg`,
        storage_path: `${session.userId}/test.jpg`,
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    const [{ id }] = body;
    await serviceDelete('listing_photos', id);
  });

  test('listing_photos: an external URL is rejected', async () => {
    const res = await fetch(`${API}/rest/v1/listing_photos?select=id`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.jwt}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({
        listing_id: listingId,
        photo_url: 'https://attacker.example.com/tracking-pixel.png',
        storage_path: `${session.userId}/whatever.jpg`,
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, '23514', 'must fail on the new CHECK constraint, not some other error');
  });

  test('listing_review_photos: a real listing-photos bucket URL succeeds', async () => {
    const res = await fetch(`${API}/rest/v1/listing_review_photos?select=id`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.jwt}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({
        listing_review_id: reviewId,
        photo_url: `https://nvingzluboafxzxgxxwc.supabase.co/storage/v1/object/public/listing-photos/${session.userId}/reviews/${reviewId}/test.jpg`,
        storage_path: `${session.userId}/reviews/${reviewId}/test.jpg`,
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    const [{ id }] = body;
    await serviceDelete('listing_review_photos', id);
  });

  test('listing_review_photos: an external URL is rejected', async () => {
    const res = await fetch(`${API}/rest/v1/listing_review_photos?select=id`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.jwt}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({
        listing_review_id: reviewId,
        photo_url: 'https://attacker.example.com/tracking-pixel.png',
        storage_path: `${session.userId}/reviews/${reviewId}/whatever.jpg`,
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, '23514');
  });
});

// Security remediation S7 (2026-09-15): reports.resolved_at/resolved_by must
// not be self-assignable on INSERT or UPDATE — same shape as C-1's listings
// lock, scoped to just these two columns.
describe('Reports resolution-field lock (S7 / 0027)', { skip: !stackReachable && 'local Supabase stack not reachable at 127.0.0.1:54321' }, () => {
  let session;
  let listingId;
  let reportId;

  before(async () => {
    session = await createAnonSession();
    const res = await fetch(`${API}/rest/v1/listings?select=id&limit=1`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } });
    [{ id: listingId }] = await res.json();
  });

  after(async () => {
    if (reportId) await serviceDelete('reports', reportId);
    if (session?.userId) await serviceDelete('profiles', session.userId);
  });

  // NOTE on request shape: `reports` deliberately has no public SELECT
  // policy at all (0012's own header: reports stay readable only via the
  // admin-reports service-role client). Postgres's RLS enforces this even
  // for the RETURNING clause of an INSERT/UPDATE the caller's own WITH
  // CHECK otherwise permits — requesting `Prefer: return=representation`
  // (or `?select=`) on a reports write from a non-service-role caller
  // fails outright with the same "violates row-level security policy"
  // error, regardless of any forged/legitimate field content, because
  // there is no SELECT policy to make the affected row visible for
  // RETURNING. This is not a bug introduced by this migration — the real
  // app's own reportListing() (web/src/lib/listings.ts) already knows this
  // and never chains .select()/requests a return value on this table. Every
  // write below mirrors that exact shape (no select=, no return=
  // representation) and verifies the result via a separate service-role
  // read afterward, the same way the app itself has no way to read back
  // its own report either.

  async function findReport(listingId, reportedBy, reason) {
    const res = await fetch(
      `${API}/rest/v1/reports?listing_id=eq.${listingId}&reported_by=eq.${reportedBy}&reason=eq.${encodeURIComponent(reason)}&select=*`,
      { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } }
    );
    const rows = await res.json();
    return rows[0];
  }

  test('a forged INSERT setting resolved_at/resolved_by lands at null', async () => {
    const res = await fetch(`${API}/rest/v1/reports`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        listing_id: listingId,
        reported_by: session.userId,
        reason: 'Spam or duplicate',
        resolved_at: '2020-01-01T00:00:00Z',
        resolved_by: 'forged@example.com',
      }),
    });
    assert.equal(res.status, 201, await res.text());
    const row = await findReport(listingId, session.userId, 'Spam or duplicate');
    assert.ok(row, 'the report must have actually been inserted');
    reportId = row.id;
    assert.equal(row.resolved_at, null, 'resolved_at must not be self-assignable on INSERT');
    assert.equal(row.resolved_by, null, 'resolved_by must not be self-assignable on INSERT');
  });

  test('a forged UPDATE on the same report reverts both fields', async () => {
    const res = await fetch(`${API}/rest/v1/reports?id=eq.${reportId}`, {
      method: 'PATCH',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved_at: '2020-01-01T00:00:00Z', resolved_by: 'houseofgorkha@gmail.com' }),
    });
    assert.equal(res.status, 204, await res.text());
    const row = await serviceRead('reports', reportId);
    assert.equal(row.resolved_at, null);
    assert.equal(row.resolved_by, null);
  });

  test('an ordinary report creation (no forged fields) is unaffected', async () => {
    const res = await fetch(`${API}/rest/v1/reports`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ listing_id: listingId, reported_by: session.userId, reason: 'Wrong price' }),
    });
    assert.equal(res.status, 201, await res.text());
    const row = await findReport(listingId, session.userId, 'Wrong price');
    assert.ok(row);
    await serviceDelete('reports', row.id);
  });

  test('service_role (legitimate admin resolution) can still set resolved_at/resolved_by', async () => {
    const res = await fetch(`${API}/rest/v1/reports?id=eq.${reportId}&select=id`, {
      method: 'PATCH',
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ resolved_at: new Date().toISOString(), resolved_by: 'houseofgorkha@gmail.com' }),
    });
    assert.equal(res.status, 200, await res.text());
    const row = await serviceRead('reports', reportId);
    assert.equal(row.resolved_by, 'houseofgorkha@gmail.com');
    assert.ok(row.resolved_at);
  });
});

// Security remediation S4 / Batch 2 (2026-09-15): checkFoodRelevance()
// (web/src/lib/contentModeration.ts, duplicated at src/lib/contentModeration.ts)
// was client-side only -- a direct REST call bypassing both apps' UI could
// previously insert an obviously non-food listing and it would go live
// immediately. These tests call the REST API directly (no client library,
// no UI) to prove the server itself now enforces this, word-boundary
// matched so legitimate names containing a keyword as a mere substring
// (not a whole word) are never falsely rejected.
describe('Server-side content moderation (S4 / 0028)', { skip: !stackReachable && 'local Supabase stack not reachable at 127.0.0.1:54321' }, () => {
  let session;
  const createdIds = [];

  before(async () => {
    session = await createAnonSession();
  });

  after(async () => {
    for (const id of createdIds) await serviceDelete('listings', id);
    if (session?.userId) await serviceDelete('profiles', session.userId);
  });

  async function tryCreate(name, note = '') {
    const res = await fetch(`${API}/rest/v1/listings?select=id`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.jwt}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ created_by: session.userId, name, note, price_rupees: 50, latitude: 12.9, longitude: 77.6 }),
    });
    const body = await res.json();
    if (res.status === 201) createdIds.push(body[0].id);
    return { status: res.status, body };
  }

  test('an obvious non-food listing (bypassing the client check entirely) is rejected', async () => {
    const { status, body } = await tryCreate('Cheap Salon Services', 'real estate, cloth shop');
    assert.equal(status, 400);
    assert.match(body.message, /affordable eats only/);
  });

  test('a legitimate food listing is accepted', async () => {
    const { status } = await tryCreate('Shivaji Military Hotel', 'Full meals, chicken biryani');
    assert.equal(status, 201);
  });

  test('legitimate edge-case restaurant names are accepted (word-boundary, not naive substring)', async () => {
    // "cloth" and "spa" are both blocked keywords, but only as whole words
    // -- these two real-shaped names contain them purely as substrings
    // inside a different, legitimate word, and must not be falsely rejected.
    const a = await tryCreate("Clothilde's Cafe", 'French pastries and coffee');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const b = await tryCreate('Spaghetti Junction', 'Italian pasta and sides');
    assert.equal(b.status, 201, JSON.stringify(b.body));
  });

  test('an UPDATE that does not touch name/note is unaffected even if unrelated fields change', async () => {
    const { status, body } = await tryCreate('Ordinary Tiffin Center', 'Idli, vada, dosa');
    assert.equal(status, 201);
    const id = body[0].id;
    const patchRes = await fetch(`${API}/rest/v1/listings?id=eq.${id}`, {
      method: 'PATCH',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ price_rupees: 60 }),
    });
    assert.equal(patchRes.status, 204);
  });

  test('service_role / import path is unaffected by the content check', async () => {
    const res = await fetch(`${API}/rest/v1/listings?select=id`, {
      method: 'POST',
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({
        created_by: SEED_USER_ID,
        name: 'Discovery Import Salon Test',
        note: 'real estate cloth shop pharmacy',
        price_rupees: 50,
        latitude: 12.9,
        longitude: 77.6,
        source: 'import',
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    const [{ id }] = body;
    await serviceDelete('listings', id);
  });
});

// Security remediation S2 / Batch 4 (2026-09-15): write rate limiting.
// Deliberately calls the raw REST API with no client library involved,
// exactly like a scripted-abuse attacker would -- proving the limit is
// enforced by the database itself, not by anything the real app's own
// client code chooses to do.
describe('Write rate limiting (S2 / 0029)', { skip: !stackReachable && 'local Supabase stack not reachable at 127.0.0.1:54321' }, () => {
  const createdListingIds = [];
  const profileIds = [];

  after(async () => {
    for (const id of createdListingIds) await serviceDelete('listings', id);
    for (const id of profileIds) await serviceDelete('profiles', id);
  });

  test('a single session is blocked after exceeding the listing-creation threshold (8 per 10 min)', async () => {
    const session = await createAnonSession();
    profileIds.push(session.userId);

    const attempts = [];
    for (let i = 0; i < 9; i++) {
      const res = await fetch(`${API}/rest/v1/listings?select=id`, {
        method: 'POST',
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.jwt}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({
          created_by: session.userId,
          name: `rls.test.mjs rate-limit listing ${i}`,
          price_rupees: 40,
          latitude: 12.9,
          longitude: 77.6,
        }),
      });
      const body = await res.json();
      if (res.status === 201) createdListingIds.push(body[0].id);
      attempts.push(res.status);
    }

    assert.deepEqual(attempts.slice(0, 8), Array(8).fill(201), 'the first 8 submissions must all succeed');
    assert.equal(attempts[8], 400, 'the 9th submission within the same window must be rejected');
  });

  test('a different session is unaffected by another session exhausting its own quota', async () => {
    const session = await createAnonSession();
    profileIds.push(session.userId);
    const res = await fetch(`${API}/rest/v1/listings?select=id`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.jwt}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ created_by: session.userId, name: 'rls.test.mjs fresh-session listing', price_rupees: 40, latitude: 12.9, longitude: 77.6 }),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    createdListingIds.push(body[0].id);
  });

  test('service_role / import path is never rate limited', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${API}/rest/v1/listings?select=id`, {
        method: 'POST',
        headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ created_by: SEED_USER_ID, name: `rls.test.mjs service-role rl ${i}`, price_rupees: 40, latitude: 12.9, longitude: 77.6, source: 'import' }),
      });
      const [{ id }] = await res.json();
      assert.equal(res.status, 201);
      createdListingIds.push(id);
    }
  });

  test('rate_limit_events is not directly readable/writable by anon/authenticated', async () => {
    const session = await createAnonSession();
    profileIds.push(session.userId);
    // RLS enabled with zero policies filters every row rather than denying
    // the query outright -- same behavior as discovery_batch_rows (0021):
    // the request succeeds (200) but returns nothing, even though we know
    // real rows exist (the earlier tests in this suite created several).
    const res = await fetch(`${API}/rest/v1/rate_limit_events?select=*`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.jwt}` } });
    assert.equal(res.status, 200);
    const rows = await res.json();
    assert.deepEqual(rows, [], 'RLS must filter out every row for a non-service-role caller');

    const writeRes = await fetch(`${API}/rest/v1/rate_limit_events`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: session.userId, action: 'forged' }),
    });
    assert.equal(writeRes.status, 403, 'a direct INSERT must still be rejected outright (no INSERT policy at all)');
  });
});

// Security remediation S8 / Batch 5 (2026-09-15): listing_reviews privacy
// boundary, mirroring the exact shape of the "Votes privacy boundary"
// suite above (0019) for a structurally identical exposure.
describe('Listing reviews privacy boundary (S8 / 0030)', { skip: !stackReachable && 'local Supabase stack not reachable at 127.0.0.1:54321' }, () => {
  let sessionA;
  let sessionB;
  let listingId;
  let reviewAId;

  before(async () => {
    sessionA = await createAnonSession();
    sessionB = await createAnonSession();
    const res = await fetch(`${API}/rest/v1/listings?select=id&limit=1`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } });
    [{ id: listingId }] = await res.json();
  });

  after(async () => {
    if (reviewAId) await serviceDelete('listing_reviews', reviewAId);
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

  test('direct table reads of listing_reviews are fully blocked (no bulk enumeration of created_by)', async () => {
    const res = await fetch(`${API}/rest/v1/listing_reviews?select=*&limit=1`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${sessionA.jwt}` } });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, '42501');
  });

  test('a user can submit their own review via upsert_my_review, and it appears with a real id', async () => {
    const res = await rpc('upsert_my_review', sessionA.jwt, { p_listing_id: listingId, p_rating: 5, p_review_text: 'Great and cheap!' });
    reviewAId = await res.json();
    assert.equal(res.status, 200, JSON.stringify(reviewAId));
    assert.ok(reviewAId, 'must return the review id');
  });

  test('the public view exposes everything except created_by', async () => {
    const res = await fetch(`${API}/rest/v1/listing_reviews_public?select=*&id=eq.${reviewAId}`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } });
    assert.equal(res.status, 200);
    const [row] = await res.json();
    assert.equal(row.rating, 5);
    assert.equal(row.review_text, 'Great and cheap!');
    assert.equal('created_by' in row, false, 'created_by must not be exposed by the public view');
  });

  test('get_my_review only ever returns the CALLING session\'s own review', async () => {
    const mine = await rpc('get_my_review', sessionA.jwt, { p_listing_id: listingId });
    const [mineRow] = await mine.json();
    assert.equal(mineRow.id, reviewAId);

    const theirs = await rpc('get_my_review', sessionB.jwt, { p_listing_id: listingId });
    const theirsRows = await theirs.json();
    assert.equal(theirsRows.length, 0, "B must not see A's review via get_my_review");
  });

  test('a second upsert_my_review call from the SAME session edits in place, not a second row', async () => {
    const res = await rpc('upsert_my_review', sessionA.jwt, { p_listing_id: listingId, p_rating: 4, p_review_text: 'Updated my mind slightly' });
    assert.equal(res.status, 200);
    const editedId = await res.json();
    assert.equal(editedId, reviewAId, 'must edit the same row (unique on listing_id, created_by), not insert a second one');
    const mine = await rpc('get_my_review', sessionA.jwt, { p_listing_id: listingId });
    const [mineRow] = await mine.json();
    assert.equal(mineRow.rating, 4);
  });

  test('a user cannot write a review as another user — upsert_my_review has no user-id parameter to target with', async () => {
    const res = await rpc('upsert_my_review', sessionB.jwt, { p_listing_id: listingId, p_rating: 1, p_review_text: 'B trying to impersonate A' });
    assert.equal(res.status, 200);
    const bId = await res.json();
    assert.notEqual(bId, reviewAId, "B's own upsert must create/edit B's own row, never A's");
    await serviceDelete('listing_reviews', bId);
  });

  test('listing_review_photos ownership (owns_review helper) still lets the real owner add/remove a photo', async () => {
    const insertRes = await fetch(`${API}/rest/v1/listing_review_photos?select=id`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${sessionA.jwt}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({
        listing_review_id: reviewAId,
        photo_url: `https://nvingzluboafxzxgxxwc.supabase.co/storage/v1/object/public/listing-photos/${sessionA.userId}/reviews/${reviewAId}/p.jpg`,
        storage_path: `${sessionA.userId}/reviews/${reviewAId}/p.jpg`,
      }),
    });
    const insertBody = await insertRes.json();
    assert.equal(insertRes.status, 201, JSON.stringify(insertBody));
    const photoId = insertBody[0].id;

    const deleteRes = await fetch(`${API}/rest/v1/listing_review_photos?id=eq.${photoId}`, {
      method: 'DELETE',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${sessionA.jwt}` },
    });
    assert.equal(deleteRes.status, 204);
  });

  test("listing_review_photos: a different user cannot add a photo to A's review", async () => {
    const res = await fetch(`${API}/rest/v1/listing_review_photos?select=id`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${sessionB.jwt}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({
        listing_review_id: reviewAId,
        photo_url: `https://nvingzluboafxzxgxxwc.supabase.co/storage/v1/object/public/listing-photos/${sessionB.userId}/reviews/${reviewAId}/p.jpg`,
        storage_path: `${sessionB.userId}/reviews/${reviewAId}/p.jpg`,
      }),
    });
    assert.equal(res.status, 403);
  });

  test('an unauthenticated caller (bare anon key, no user JWT) gets zero rows, never an error leaking data', async () => {
    const res = await rpc('get_my_review', ANON_KEY, { p_listing_id: listingId });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });

  test('service_role retains full direct access to listing_reviews', async () => {
    const res = await fetch(`${API}/rest/v1/listing_reviews?select=*&limit=1`, { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } });
    assert.equal(res.status, 200);
  });
});
