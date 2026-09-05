// Discovery Workbench auth-boundary + CRUD regression suite (Phase 1 of the
// approved Discovery Workbench plan).
//
// Covers the same three-way boundary tests/adminAuth.test.mjs already
// proves for the admin-* functions (no auth -> 401, a real but
// non-allowlisted JWT -> 403, a real allowlisted JWT -> 200), applied to
// discovery-workbench's own DISCOVERY_EMAILS allowlist, plus list/get/update
// against a manually-inserted fake row — exactly the verification the plan
// calls for before moving past Phase 1.
//
// Requires a running LOCAL Supabase stack with its Edge Functions served
// (`npx supabase start`) — skips entirely if unreachable, same reasoning as
// tests/rls.test.mjs/adminAuth.test.mjs. Never run this JWT-minting approach
// against production: it only works here because it's signed with the local
// stack's well-known, published dev JWT secret.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const API = 'http://127.0.0.1:54321';
const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

// Same user/id as tests/adminAuth.test.mjs's ADMIN_USER_ID — houseofgorkha@
// gmail.com is already seeded locally under this id by that suite, and
// auth.users has a unique constraint on email, so minting a second id for
// the same email would collide. Reusing it is correct here: it's the same
// real account, just also present in DISCOVERY_EMAILS (see supabase/
// functions/.env) alongside ADMIN_EMAILS.
const DISCOVERY_USER_ID = '11111111-1111-1111-1111-111111111111';
const DISCOVERY_EMAIL = 'houseofgorkha@gmail.com'; // must match the local DISCOVERY_EMAILS secret (supabase/functions/.env)
const NON_DISCOVERY_USER_ID = '44444444-4444-4444-4444-444444444444';
const NON_DISCOVERY_EMAIL = 'notintern.test@example.com';

const FIXTURE_PLACE_ID = 'test-place-discovery-workbench-fixture';

let stackReachable = false;
try {
  const res = await fetch(`${API}/rest/v1/`, { headers: { apikey: 'probe' }, signal: AbortSignal.timeout(1500) });
  stackReachable = true; // any HTTP response at all means the gateway is up
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

// Same approach as tests/adminAuth.test.mjs's ensureFixtureUsers — a single
// line, since spawnSync's shell:true on Windows mangles embedded newlines
// inside a quoted argument.
function ensureFixtureUsers() {
  const sql = `insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, instance_id, confirmation_token, recovery_token, email_change_token_new, email_change) values ('${DISCOVERY_USER_ID}', 'authenticated', 'authenticated', '${DISCOVERY_EMAIL}', '', now(), now(), now(), '00000000-0000-0000-0000-000000000000', '', '', '', ''), ('${NON_DISCOVERY_USER_ID}', 'authenticated', 'authenticated', '${NON_DISCOVERY_EMAIL}', '', now(), now(), now(), '00000000-0000-0000-0000-000000000000', '', '', '', '') on conflict (id) do nothing;`;
  const result = spawnSync('npx', ['supabase', 'db', 'query', '--local', JSON.stringify(sql)], { encoding: 'utf8', shell: true });
  if (result.status !== 0) {
    throw new Error(`Could not seed local discovery-auth fixture users: ${result.stderr || result.stdout}`);
  }
}

// Inserted/removed via the service-role REST endpoint directly (bypasses
// RLS, matching how tests/rls.test.mjs talks to service-role-only paths) —
// never through the function under test, so the fixture's existence isn't
// itself dependent on the code being verified.
async function upsertFixtureRow() {
  const res = await fetch(`${API}/rest/v1/discovery_batch_rows`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      place_id: FIXTURE_PLACE_ID,
      name: 'Discovery Workbench Test Fixture',
      formatted_address: '123 Test Street, Bengaluru',
      latitude: 12.9,
      longitude: 77.6,
      batch_id: 'test-batch-1',
    }),
  });
  if (!res.ok) {
    throw new Error(`Could not seed fixture row: ${res.status} ${await res.text()}`);
  }
}

async function deleteFixtureRow() {
  await fetch(`${API}/rest/v1/discovery_batch_rows?place_id=eq.${FIXTURE_PLACE_ID}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
}

// Cleans up any objects the photo-action tests uploaded under the fixture's
// own prefix — service-role bulk delete, same pattern tests/workbenchSync.
// test.mjs already uses for its own storage cleanup.
async function deleteFixturePhotos() {
  const res = await fetch(`${API}/storage/v1/object/list/discovery-photos`, {
    method: 'POST',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: `${FIXTURE_PLACE_ID}/` }),
  });
  const objects = await res.json().catch(() => []);
  if (!Array.isArray(objects) || objects.length === 0) return;
  await fetch(`${API}/storage/v1/object/discovery-photos`, {
    method: 'DELETE',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: objects.map((o) => `${FIXTURE_PLACE_ID}/${o.name}`) }),
  });
}

// Actually uploads bytes to a signed upload URL the function minted — PUT
// straight to it (supabase-js's createSignedUploadUrl() already returns a
// full absolute URL, not the bare relative path the raw REST endpoint
// returns — confirmed directly; don't re-prefix it with the API base URL).
// Mirrors what supabase-js's uploadToSignedUrl() does under the hood, in
// plain fetch to match this test file's existing no-supabase-js convention.
async function uploadToSignedUrl(signedUrl, contentType, bytes) {
  const res = await fetch(signedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: bytes,
  });
  return res;
}

async function callFn(jwt, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  const res = await fetch(`${API}/functions/v1/discovery-workbench`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

describe('Discovery Workbench auth boundary + CRUD (Phase 1)', { skip: !stackReachable && 'local Supabase stack not reachable at 127.0.0.1:54321' }, () => {
  let discoveryJwt;
  let nonDiscoveryJwt;

  before(async () => {
    ensureFixtureUsers();
    discoveryJwt = testJwt({ sub: DISCOVERY_USER_ID, email: DISCOVERY_EMAIL });
    nonDiscoveryJwt = testJwt({ sub: NON_DISCOVERY_USER_ID, email: NON_DISCOVERY_EMAIL });
    await upsertFixtureRow();
  });

  after(async () => {
    await deleteFixturePhotos();
    await deleteFixtureRow();
  });

  test('no Authorization header -> 401', async () => {
    const { status } = await callFn(null, { action: 'list' });
    assert.equal(status, 401);
  });

  test('real non-allowlisted JWT -> 403', async () => {
    const { status } = await callFn(nonDiscoveryJwt, { action: 'list' });
    assert.equal(status, 403);
  });

  test('real allowlisted JWT: list -> 200, includes the fixture row', async () => {
    const { status, data } = await callFn(discoveryJwt, { action: 'list' });
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.data));
    assert.ok(data.data.some((row) => row.place_id === FIXTURE_PLACE_ID));
  });

  test('get: returns the fixture row', async () => {
    const { status, data } = await callFn(discoveryJwt, { action: 'get', placeId: FIXTURE_PLACE_ID });
    assert.equal(status, 200);
    assert.equal(data.data.place_id, FIXTURE_PLACE_ID);
    assert.equal(data.data.name, 'Discovery Workbench Test Fixture');
  });

  test('get: unknown place_id -> 404', async () => {
    const { status } = await callFn(discoveryJwt, { action: 'get', placeId: 'does-not-exist' });
    assert.equal(status, 404);
  });

  test('update: phone + dishes -> success, notes derived server-side', async () => {
    const { status, data } = await callFn(discoveryJwt, {
      action: 'update',
      placeId: FIXTURE_PLACE_ID,
      fields: {
        phone: '099999 88888',
        number_valid: 'Yes',
        menu_list_under_100: 'Yes',
        dishes: [
          { dish: 'Masala Dosa', price: 60 },
          { dish: 'Rice Meals', price: 80 },
        ],
      },
    });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.data.phone, '099999 88888');
    assert.equal(data.data.notes, 'Masala Dosa ₹60, Rice Meals ₹80');
  });

  test('update: disallowed field -> 400', async () => {
    const { status, data } = await callFn(discoveryJwt, {
      action: 'update',
      placeId: FIXTURE_PLACE_ID,
      fields: { name: 'Forged Name' },
    });
    assert.equal(status, 400);
    assert.match(data.error, /cannot be edited/);
  });

  test('update: invalid number_valid -> 400', async () => {
    const { status } = await callFn(discoveryJwt, {
      action: 'update',
      placeId: FIXTURE_PLACE_ID,
      fields: { number_valid: 'Invalid' },
    });
    assert.equal(status, 400);
  });

  test('update: dish price out of ₹30-₹100 range -> 400', async () => {
    const { status } = await callFn(discoveryJwt, {
      action: 'update',
      placeId: FIXTURE_PLACE_ID,
      fields: { dishes: [{ dish: 'Vada', price: 10 }] },
    });
    assert.equal(status, 400);
  });

  describe('photo actions (Phase 3)', () => {
    test('photo actions require placeId to belong to the active batch -> 404', async () => {
      const { status } = await callFn(discoveryJwt, { action: 'createPhotoUploadUrl', placeId: 'not-a-real-place', filename: 'a.jpg' });
      assert.equal(status, 404);
    });

    test('createPhotoUploadUrl: rejects a disallowed extension', async () => {
      const { status, data } = await callFn(discoveryJwt, {
        action: 'createPhotoUploadUrl',
        placeId: FIXTURE_PLACE_ID,
        filename: 'menu.pdf',
      });
      assert.equal(status, 400);
      assert.match(data.error, /JPEG, PNG, or WebP/);
    });

    test('createPhotoUploadUrl + real upload -> listPhotos returns it with a working signed URL', async () => {
      const { status, data } = await callFn(discoveryJwt, {
        action: 'createPhotoUploadUrl',
        placeId: FIXTURE_PLACE_ID,
        filename: 'front.png',
      });
      assert.equal(status, 200, JSON.stringify(data));
      assert.ok(data.data.signedUrl);
      assert.ok(data.data.path.startsWith(`${FIXTURE_PLACE_ID}/`));

      const uploadRes = await uploadToSignedUrl(data.data.signedUrl, 'image/png', Buffer.from('fake-png-bytes-1'));
      assert.equal(uploadRes.status, 200, await uploadRes.text());

      const listRes = await callFn(discoveryJwt, { action: 'listPhotos', placeId: FIXTURE_PLACE_ID });
      assert.equal(listRes.status, 200);
      assert.equal(listRes.data.data.length, 1);
      assert.ok(listRes.data.data[0].url.startsWith('http'));

      // The signed read URL must actually work.
      const readRes = await fetch(listRes.data.data[0].url);
      assert.equal(readRes.status, 200);
      assert.equal(await readRes.text(), 'fake-png-bytes-1');
    });

    test('photo cap: a 2nd photo is allowed, a 3rd is rejected', async () => {
      const second = await callFn(discoveryJwt, { action: 'createPhotoUploadUrl', placeId: FIXTURE_PLACE_ID, filename: 'back.png' });
      assert.equal(second.status, 200, JSON.stringify(second.data));
      const uploadRes = await uploadToSignedUrl(second.data.data.signedUrl, 'image/png', Buffer.from('fake-png-bytes-2'));
      assert.equal(uploadRes.status, 200);

      const third = await callFn(discoveryJwt, { action: 'createPhotoUploadUrl', placeId: FIXTURE_PLACE_ID, filename: 'side.png' });
      assert.equal(third.status, 400);
      assert.match(third.data.error, /Maximum 2 photos/);

      // addPhotoFromUrl must respect the same cap.
      const viaUrl = await callFn(discoveryJwt, { action: 'addPhotoFromUrl', placeId: FIXTURE_PLACE_ID, imageUrl: 'https://example.com/whatever.png' });
      assert.equal(viaUrl.status, 400);
      assert.match(viaUrl.data.error, /Maximum 2 photos/);
    });

    test('removePhoto: removes one, count drops back under the cap', async () => {
      const before = await callFn(discoveryJwt, { action: 'listPhotos', placeId: FIXTURE_PLACE_ID });
      assert.equal(before.data.data.length, 2);
      const target = before.data.data[0].name;

      const removeRes = await callFn(discoveryJwt, { action: 'removePhoto', placeId: FIXTURE_PLACE_ID, filename: target });
      assert.equal(removeRes.status, 200, JSON.stringify(removeRes.data));

      const after1 = await callFn(discoveryJwt, { action: 'listPhotos', placeId: FIXTURE_PLACE_ID });
      assert.equal(after1.data.data.length, 1);
      assert.ok(!after1.data.data.some((p) => p.name === target));

      // Cap freed up — a new upload should now be accepted again.
      const retry = await callFn(discoveryJwt, { action: 'createPhotoUploadUrl', placeId: FIXTURE_PLACE_ID, filename: 'side.png' });
      assert.equal(retry.status, 200, JSON.stringify(retry.data));
    });

    test('addPhotoFromUrl: fetches and stores a real external image', async () => {
      // Clear the slot the previous test's retry consumed so this has room
      // (photo cap is real and shared across this describe block's tests).
      const current = await callFn(discoveryJwt, { action: 'listPhotos', placeId: FIXTURE_PLACE_ID });
      for (const photo of current.data.data) {
        await callFn(discoveryJwt, { action: 'removePhoto', placeId: FIXTURE_PLACE_ID, filename: photo.name });
      }

      const res = await callFn(discoveryJwt, {
        action: 'addPhotoFromUrl',
        placeId: FIXTURE_PLACE_ID,
        imageUrl: 'https://www.google.com/images/branding/googleg/1x/googleg_standard_color_128dp.png',
      });
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.ok(res.data.data.name.endsWith('.png'));

      const listRes = await callFn(discoveryJwt, { action: 'listPhotos', placeId: FIXTURE_PLACE_ID });
      assert.equal(listRes.data.data.length, 1);
    });

    test('addPhotoFromUrl: rejects a non-image URL', async () => {
      const res = await callFn(discoveryJwt, {
        action: 'addPhotoFromUrl',
        placeId: FIXTURE_PLACE_ID,
        imageUrl: 'https://www.google.com/robots.txt',
      });
      assert.equal(res.status, 400);
      assert.match(res.data.error, /JPEG, PNG, or WebP/);
    });
  });
});
