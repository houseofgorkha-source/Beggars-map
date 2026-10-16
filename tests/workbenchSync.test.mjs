// Discovery Workbench sync regression suite (Phase 2 of the approved plan).
//
// Exercises tools/discovery/workbench-sync.mjs end to end against a
// throwaway fixture workbook and fake place_ids — NEVER the real WIP xlsx
// or a real Google place_id — via that script's own --file=/--state-file=
// test-only overrides. Requires a running LOCAL Supabase stack with
// migration 0021 applied (`npx supabase start`, `npx supabase db push
// --local`) — skips entirely if unreachable, same reasoning as this repo's
// other integration suites. Never run any part of this against production;
// the script under test has no --linked/--production option at all.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, unlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const DISCOVERY_DIR = join(REPO_ROOT, 'tools', 'discovery');
const OUTPUT_DIR = join(DISCOVERY_DIR, 'output');
const PHOTOS_DIR = join(DISCOVERY_DIR, 'photos');
const BACKUPS_DIR = join(OUTPUT_DIR, 'backups');
const SCRIPT_PATH = join(DISCOVERY_DIR, 'workbench-sync.mjs');

const FIXTURE_XLSX = join(OUTPUT_DIR, 'test-fixture-workbench-sync.xlsx');
const FIXTURE_STATE = join(OUTPUT_DIR, 'test-state-workbench-sync.json');

const API = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

// Deliberately not shaped like a real Google place_id (those all start with
// "ChIJ") so these can never collide with, or be mistaken for, real
// discovery data.
const PLACES = ['TEST-WBSYNC-1', 'TEST-WBSYNC-2', 'TEST-WBSYNC-3', 'TEST-WBSYNC-4', 'TEST-WBSYNC-5', 'TEST-WBSYNC-6', 'TEST-WBSYNC-7'];

let stackReachable = false;
try {
  await fetch(`${API}/rest/v1/`, { headers: { apikey: 'probe' }, signal: AbortSignal.timeout(1500) });
  stackReachable = true;
} catch {
  stackReachable = false;
}

function runScript(args) {
  const result = spawnSync('node', [SCRIPT_PATH, ...args], { encoding: 'utf8', cwd: REPO_ROOT });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function buildFixture() {
  // Row shape mirrors the real WIP workbook's headers exactly (see
  // AGENTS.md's documented column list) — a subset of rows is enough to
  // exercise every code path without ever touching the real 3,586-row file.
  const rows = [
    { place_id: PLACES[0], name: 'Test Place One', formatted_address: '1 Test Rd, Bengaluru', latitude: 12.9, longitude: 77.6, primary_type: 'restaurant', business_status: 'OPERATIONAL', google_price_level: 'PRICE_LEVEL_INEXPENSIVE', website_uri: null, phone: '099000 00001', google_maps_uri: 'https://maps.google.com/?cid=1', discovery_sources: 'Test:query', verification_status: 'unverified', verified_le_100: false, 'Number Valid': null, 'Menu List Under 100': null, 'Menu Details/Notes': null },
    { place_id: PLACES[1], name: 'Test Place Two', formatted_address: '2 Test Rd, Bengaluru', latitude: 12.91, longitude: 77.61, primary_type: 'restaurant', business_status: 'OPERATIONAL', google_price_level: 'PRICE_LEVEL_INEXPENSIVE', website_uri: null, phone: '099000 00002', google_maps_uri: 'https://maps.google.com/?cid=2', discovery_sources: 'Test:query', verification_status: 'unverified', verified_le_100: false, 'Number Valid': null, 'Menu List Under 100': null, 'Menu Details/Notes': null },
    { place_id: PLACES[2], name: 'Test Place Three (legacy reviewed)', formatted_address: '3 Test Rd, Bengaluru', latitude: 12.92, longitude: 77.62, primary_type: 'restaurant', business_status: 'OPERATIONAL', google_price_level: 'PRICE_LEVEL_MODERATE', website_uri: null, phone: '099000 00003', google_maps_uri: 'https://maps.google.com/?cid=3', discovery_sources: 'Test:query', verification_status: 'unverified', verified_le_100: false, 'Number Valid': 'No', 'Menu List Under 100': 'No', 'Menu Details/Notes': null },
    { place_id: PLACES[3], name: 'Test Place Four', formatted_address: '4 Test Rd, Bengaluru', latitude: 12.93, longitude: 77.63, primary_type: 'restaurant', business_status: 'OPERATIONAL', google_price_level: 'PRICE_LEVEL_INEXPENSIVE', website_uri: null, phone: '099000 00004', google_maps_uri: 'https://maps.google.com/?cid=4', discovery_sources: 'Test:query', verification_status: 'unverified', verified_le_100: false, 'Number Valid': null, 'Menu List Under 100': null, 'Menu Details/Notes': null },
    { place_id: PLACES[4], name: 'Test Place Five (lock test)', formatted_address: '5 Test Rd, Bengaluru', latitude: 12.94, longitude: 77.64, primary_type: 'restaurant', business_status: 'OPERATIONAL', google_price_level: 'PRICE_LEVEL_INEXPENSIVE', website_uri: null, phone: '099000 00005', google_maps_uri: 'https://maps.google.com/?cid=5', discovery_sources: 'Test:query', verification_status: 'unverified', verified_le_100: false, 'Number Valid': null, 'Menu List Under 100': null, 'Menu Details/Notes': null },
    // Menu List Under 100 is blank here (not "Weird") — under the
    // blank-only eligibility rule, a non-blank value of ANY kind (even
    // garbage) makes a row ineligible for push, so this row's own
    // eligibility is unaffected by "Number Valid" being invalid. This still
    // exercises the Number Valid coercion path in push(), just not a
    // simultaneous Menu List Under 100 one.
    { place_id: PLACES[5], name: 'Test Place Six (bad enum)', formatted_address: '6 Test Rd, Bengaluru', latitude: 12.95, longitude: 77.65, primary_type: 'restaurant', business_status: 'OPERATIONAL', google_price_level: 'PRICE_LEVEL_INEXPENSIVE', website_uri: null, phone: '099000 00006', google_maps_uri: 'https://maps.google.com/?cid=6', discovery_sources: 'Test:query', verification_status: 'unverified', verified_le_100: false, 'Number Valid': 'Bogus', 'Menu List Under 100': null, 'Menu Details/Notes': null },
    { place_id: PLACES[6], name: 'Test Place Seven', formatted_address: '7 Test Rd, Bengaluru', latitude: 12.96, longitude: 77.66, primary_type: 'restaurant', business_status: 'OPERATIONAL', google_price_level: 'PRICE_LEVEL_INEXPENSIVE', website_uri: null, phone: '099000 00007', google_maps_uri: 'https://maps.google.com/?cid=7', discovery_sources: 'Test:query', verification_status: 'unverified', verified_le_100: false, 'Number Valid': null, 'Menu List Under 100': null, 'Menu Details/Notes': null },
  ];

  const headers = Object.keys(rows[0]);
  const pyPath = join(OUTPUT_DIR, '.build-test-fixture.py');
  const script = `
import json, sys
import openpyxl
headers = json.loads(sys.argv[1])
rows = json.loads(sys.argv[2])
path = sys.argv[3]
wb = openpyxl.Workbook()
ws = wb.active
ws.append(headers)
for row in rows:
    ws.append([row.get(h) for h in headers])
wb.save(path)
`;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(pyPath, script, 'utf8');
  const result = spawnSync('python', [pyPath, JSON.stringify(headers), JSON.stringify(rows), FIXTURE_XLSX], { encoding: 'utf8' });
  unlinkSync(pyPath);
  if (result.status !== 0) throw new Error(`Could not build fixture workbook: ${result.stderr || result.stdout}`);
}

function readFixtureRows() {
  const result = spawnSync('python', [join(DISCOVERY_DIR, 'xlsx-to-json.py'), FIXTURE_XLSX], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not read fixture workbook: ${result.stderr}`);
  return JSON.parse(result.stdout).rows;
}

function rowByPlaceId(placeId) {
  return readFixtureRows().find((r) => r.place_id === placeId);
}

async function dbGet(placeId) {
  const res = await fetch(`${API}/rest/v1/discovery_batch_rows?place_id=eq.${encodeURIComponent(placeId)}&select=*`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  const rows = await res.json();
  return rows[0] ?? null;
}

async function dbPatch(placeId, fields) {
  const res = await fetch(`${API}/rest/v1/discovery_batch_rows?place_id=eq.${encodeURIComponent(placeId)}`, {
    method: 'PATCH',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`dbPatch failed for ${placeId}: ${res.status} ${await res.text()}`);
}

async function dbDeleteHard(placeId) {
  await fetch(`${API}/rest/v1/discovery_batch_rows?place_id=eq.${encodeURIComponent(placeId)}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
}

async function storageObjectExists(placeId, filename) {
  const res = await fetch(`${API}/storage/v1/object/list/discovery-photos`, {
    method: 'POST',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: `${placeId}/` }),
  });
  const objects = await res.json();
  return objects.some((o) => o.name === filename);
}

function writeState(state) {
  writeFileSync(FIXTURE_STATE, JSON.stringify(state, null, 2), 'utf8');
}
function readState() {
  return JSON.parse(readFileSync(FIXTURE_STATE, 'utf8'));
}

function cleanupFixtureArtifacts() {
  for (const f of [FIXTURE_XLSX, FIXTURE_STATE]) {
    if (existsSync(f)) rmSync(f, { force: true });
  }
  for (const placeId of PLACES) {
    const dir = join(PHOTOS_DIR, placeId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  if (existsSync(BACKUPS_DIR)) {
    for (const f of readdirSync(BACKUPS_DIR)) {
      if (f.startsWith('test-fixture-workbench-sync.xlsx')) rmSync(join(BACKUPS_DIR, f), { force: true });
    }
  }
  const lockPath = join(OUTPUT_DIR, '~$test-fixture-workbench-sync.xlsx');
  if (existsSync(lockPath)) rmSync(lockPath, { force: true });
}

async function cleanupFixtureDbAndStorage() {
  for (const placeId of PLACES) {
    const objects = await (
      await fetch(`${API}/storage/v1/object/list/discovery-photos`, {
        method: 'POST',
        headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: `${placeId}/` }),
      })
    ).json();
    if (Array.isArray(objects) && objects.length > 0) {
      await fetch(`${API}/storage/v1/object/discovery-photos`, {
        method: 'DELETE',
        headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: objects.map((o) => `${placeId}/${o.name}`) }),
      });
    }
    await dbDeleteHard(placeId);
  }
}

describe('workbench-sync.mjs (Phase 2)', { skip: !stackReachable && 'local Supabase stack not reachable at 127.0.0.1:54321' }, () => {
  before(async () => {
    cleanupFixtureArtifacts();
    await cleanupFixtureDbAndStorage();
    buildFixture();
    // A real photo for TEST-WBSYNC-2, to exercise push's photo upload and
    // pull's photo download.
    const dir = join(PHOTOS_DIR, PLACES[1]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'front.jpg'), Buffer.from('fake-jpeg-bytes-for-test'));
  });

  after(async () => {
    cleanupFixtureArtifacts();
    await cleanupFixtureDbAndStorage();
  });

  const commonArgs = [`--file=${FIXTURE_XLSX}`, `--state-file=${FIXTURE_STATE}`];

  test('status on a fresh fixture: 6 eligible (blank), 1 not-eligible (No), no active batch', () => {
    const { status, stdout, stderr } = runScript(['--status', ...commonArgs]);
    assert.equal(status, 0, stdout + stderr);
    assert.match(stdout, /Total candidates\s*: 7/);
    assert.match(stdout, /Already manually verified \(Yes\)\s*: 0/);
    assert.match(stdout, /Not eligible \(No\)\s*: 1/);
    assert.match(stdout, /Eligible for research \(blank\)\s*: 6/);
    assert.match(stdout, /In progress \(active batch\)\s*: 0/);
    assert.match(stdout, /Completed \(pulled \+ purged\)\s*: 0/);
    assert.match(stdout, /Remaining eligible \(blank, not yet pushed\/completed\)\s*: 6/);
    assert.match(stdout, /No active batch\./);
  });

  test('push --batch-size=2 selects the first 2 eligible rows in order, uploads the one existing photo', async () => {
    const { status, stdout, stderr } = runScript(['--push', '--batch-size=2', ...commonArgs]);
    assert.equal(status, 0, stdout + stderr);
    assert.match(stdout, /Pushed batch 1: 2 candidate\(s\) \(2 fresh, 0 resend\), 1 photo\(s\) uploaded\./);

    const row1 = await dbGet(PLACES[0]);
    const row2 = await dbGet(PLACES[1]);
    assert.ok(row1, 'TEST-WBSYNC-1 should be live in Supabase');
    assert.ok(row2, 'TEST-WBSYNC-2 should be live in Supabase');
    assert.equal(row1.batch_id, '1');
    assert.equal(row2.batch_id, '1');
    assert.equal(await dbGet(PLACES[3]), null, 'TEST-WBSYNC-4 was not part of this batch and must not have been pushed');

    assert.ok(await storageObjectExists(PLACES[1], 'front.jpg'), 'the existing local photo should have been uploaded');

    const state = readState();
    assert.equal(Object.keys(state.in_progress).length, 2);
    assert.ok(state.in_progress[PLACES[0]]);
    assert.ok(state.in_progress[PLACES[1]]);
  });

  test('push is idempotent: a second push while a batch is active refuses and creates nothing new', async () => {
    const { status, stderr } = runScript(['--push', '--batch-size=2', ...commonArgs]);
    assert.notEqual(status, 0);
    assert.match(stderr, /REFUSING TO PUSH/);
    assert.match(stderr, /still active/);

    // Still exactly 2 rows for batch 1 — no duplicate insert happened.
    const res = await fetch(`${API}/rest/v1/discovery_batch_rows?batch_id=eq.1&select=place_id`, {
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    });
    const rows = await res.json();
    assert.equal(rows.length, 2);
  });

  test('pull (no purge): simulated intern edits land in the xlsx, batch stays live in Supabase', async () => {
    // Simulate what the discovery-workbench Edge Function's `update`
    // action would have done during a real review session.
    await dbPatch(PLACES[0], {
      phone: '099111 11111',
      number_valid: 'Yes',
      menu_list_under_100: 'Yes',
      dishes: [{ dish: 'Test Dish', price: 60 }],
      notes: 'Test Dish ₹60',
    });
    await dbPatch(PLACES[1], { number_valid: 'No', menu_list_under_100: 'No' });

    const { status, stdout, stderr } = runScript(['--pull', ...commonArgs]);
    assert.equal(status, 0, stdout + stderr);
    assert.match(stdout, /Pulled 2 row\(s\), 1 photo\(s\) downloaded\. Backup: /);
    assert.match(stdout, /Batch left in Supabase \(no --purge passed\)/);

    const r1 = rowByPlaceId(PLACES[0]);
    assert.equal(r1.phone, '099111 11111');
    assert.equal(r1['Number Valid'], 'Yes');
    assert.equal(r1['Menu List Under 100'], 'Yes');
    assert.equal(r1['Menu Details/Notes'], 'Test Dish ₹60');
    const r2 = rowByPlaceId(PLACES[1]);
    assert.equal(r2['Number Valid'], 'No');
    assert.equal(r2['Menu List Under 100'], 'No');

    // Untouched rows must remain byte-for-byte as originally written.
    const r3 = rowByPlaceId(PLACES[2]);
    assert.equal(r3.name, 'Test Place Three (legacy reviewed)');
    assert.equal(r3['Number Valid'], 'No');

    // Photo landed locally.
    assert.ok(existsSync(join(PHOTOS_DIR, PLACES[1], 'front.jpg')));

    // A backup was created.
    const backups = readdirSync(BACKUPS_DIR).filter((f) => f.startsWith('test-fixture-workbench-sync.xlsx'));
    assert.ok(backups.length >= 1);

    // Batch is still live — pull without --purge never deletes anything.
    assert.ok(await dbGet(PLACES[0]));
    assert.ok(await dbGet(PLACES[1]));
    const state = readState();
    assert.equal(Object.keys(state.in_progress).length, 2);
    assert.equal(Object.keys(state.completed).length, 0);
  });

  test('pull is idempotent: running it again re-applies the same values without error', () => {
    const { status, stdout, stderr } = runScript(['--pull', ...commonArgs]);
    assert.equal(status, 0, stdout + stderr);
    assert.match(stdout, /Pulled 2 row\(s\)/);
    const r1 = rowByPlaceId(PLACES[0]);
    assert.equal(r1['Menu Details/Notes'], 'Test Dish ₹60');
  });

  test('pull --purge: removes the batch and its photos from Supabase, marks rows completed', async () => {
    const { status, stdout, stderr } = runScript(['--pull', '--purge', ...commonArgs]);
    assert.equal(status, 0, stdout + stderr);
    assert.match(stdout, /Purged 2 row\(s\)\./);

    assert.equal(await dbGet(PLACES[0]), null);
    assert.equal(await dbGet(PLACES[1]), null);
    assert.equal(await storageObjectExists(PLACES[1], 'front.jpg'), false, 'photo should be gone from storage after purge');
    // Local copy of the photo is untouched — purge only clears Supabase.
    assert.ok(existsSync(join(PHOTOS_DIR, PLACES[1], 'front.jpg')));

    const state = readState();
    assert.equal(Object.keys(state.in_progress).length, 0);
    assert.equal(Object.keys(state.completed).length, 2);
  });

  test('purge is idempotent: running pull --purge again with nothing active is a clean no-op', () => {
    const { status, stdout, stderr } = runScript(['--pull', '--purge', ...commonArgs]);
    assert.equal(status, 0, stdout + stderr);
    assert.match(stdout, /Nothing to pull — no active batch\./);
  });

  test('status after a full cycle reflects Yes/No/blank and completed/remaining correctly', () => {
    // At this point PLACES[0]/[1] have been pulled with the intern's real
    // Yes/No determinations (see the pull test above), so they've moved out
    // of "blank" for real, on top of being tracked completed.
    const { status, stdout, stderr } = runScript(['--status', ...commonArgs]);
    assert.equal(status, 0, stdout + stderr);
    assert.match(stdout, /Already manually verified \(Yes\)\s*: 1/);
    assert.match(stdout, /Not eligible \(No\)\s*: 2/);
    assert.match(stdout, /Eligible for research \(blank\)\s*: 4/);
    assert.match(stdout, /In progress \(active batch\)\s*: 0/);
    assert.match(stdout, /Completed \(pulled \+ purged\)\s*: 2/);
    assert.match(stdout, /Remaining eligible \(blank, not yet pushed\/completed\)\s*: 4/);
  });

  test('failure/recovery: a row live in Supabase but missing from state is adopted back on the next command', async () => {
    const { status: pushStatus, stdout: pushOut, stderr: pushErr } = runScript(['--push', '--batch-size=1', ...commonArgs]);
    assert.equal(pushStatus, 0, pushOut + pushErr);
    assert.ok(await dbGet(PLACES[3]), 'TEST-WBSYNC-4 should now be live (next eligible row)');

    // Simulate a crash between the INSERT and the state-file save: drop the
    // in_progress entry the real push would have just written.
    const state = readState();
    assert.ok(state.in_progress[PLACES[3]]);
    delete state.in_progress[PLACES[3]];
    writeState(state);

    const { status, stdout, stderr } = runScript(['--status', ...commonArgs]);
    assert.equal(status, 0, stdout + stderr);
    assert.match(stdout, /Reconciled state with Supabase \(adopted 1, completed 0\)\./);
    const healed = readState();
    assert.ok(healed.in_progress[PLACES[3]], 'the orphaned live row should have been adopted back into in_progress');
  });

  test('failure/recovery: a row removed from Supabase outside this tool is reconciled to completed', async () => {
    // Simulate the opposite crash: purge deleted the Supabase row but the
    // state-file save never happened.
    await dbDeleteHard(PLACES[3]);

    const { status, stdout, stderr } = runScript(['--status', ...commonArgs]);
    assert.equal(status, 0, stdout + stderr);
    assert.match(stdout, /Reconciled state with Supabase \(adopted 0, completed 1\)\./);
    const state = readState();
    assert.equal(state.in_progress[PLACES[3]], undefined);
    assert.ok(state.completed[PLACES[3]]);
  });

  test('failure/recovery: a locked (open-in-Excel) workbook aborts the write with no corruption, and is retryable once unlocked', async () => {
    const { status: pushStatus, stdout: pushOut, stderr: pushErr } = runScript(['--push', '--batch-size=1', ...commonArgs]);
    assert.equal(pushStatus, 0, pushOut + pushErr);
    assert.ok(await dbGet(PLACES[4]), 'TEST-WBSYNC-5 should now be the active batch');

    const beforeContent = readFixtureRows();

    const lockPath = join(OUTPUT_DIR, '~$test-fixture-workbench-sync.xlsx');
    writeFileSync(lockPath, '');
    const { status, stderr } = runScript(['--pull', ...commonArgs]);
    assert.notEqual(status, 0);
    assert.match(stderr, /open in Excel/);

    // Nothing was corrupted or partially written.
    const afterContent = readFixtureRows();
    assert.deepEqual(afterContent, beforeContent);
    // Nothing in Supabase/state changed either — still in progress.
    assert.ok(await dbGet(PLACES[4]));
    const state = readState();
    assert.ok(state.in_progress[PLACES[4]]);

    rmSync(lockPath, { force: true });
    const { status: retryStatus, stdout, stderr: retryErr } = runScript(['--pull', '--purge', ...commonArgs]);
    assert.equal(retryStatus, 0, stdout + retryErr);
    assert.match(stdout, /Purged 1 row\(s\)\./);
  });

  test('push tolerates an invalid legacy Number Valid value: coerces to null without blocking the rest of the batch', async () => {
    // TEST-WBSYNC-6 has "Bogus" pre-filled for Number Valid (not a valid
    // dropdown value) but a BLANK Menu List Under 100 — under the
    // blank-only eligibility rule its eligibility is unaffected by that;
    // TEST-WBSYNC-7 is a normal blank row, pushed together.
    const { status, stdout, stderr } = runScript(['--push', '--batch-size=2', ...commonArgs]);
    assert.equal(status, 0, stdout + stderr);
    assert.match(stdout, /Pushed batch \d+: 2 candidate\(s\)/);
    // Only Number Valid is actually invalid here (Menu List Under 100 was
    // already blank, which needs no coercion), so exactly 1 value is reset.
    assert.match(stdout, /1 legacy value\(s\) with an invalid dropdown option were reset to blank/);

    const bad = await dbGet(PLACES[5]);
    const good = await dbGet(PLACES[6]);
    assert.ok(bad, 'the row with an invalid legacy Number Valid should still have been pushed');
    assert.equal(bad.number_valid, null);
    assert.equal(bad.menu_list_under_100, null);
    assert.ok(good, 'the other row in the same batch must be unaffected');

    // Clean up this batch so the suite ends with no active batch.
    const { status: purgeStatus, stdout: purgeOut, stderr: purgeErr } = runScript(['--pull', '--purge', ...commonArgs]);
    assert.equal(purgeStatus, 0, purgeOut + purgeErr);
  });
});

// Dedicated, isolated suite for the "Menu List Under 100" blank-only
// eligibility rule — its own fixture/state files (never the shared fixture
// above) so it can't interfere with, or be affected by, the batch/state
// sequencing the other describe block's tests depend on.
describe('workbench-sync.mjs — Menu List Under 100 eligibility rule', { skip: !stackReachable && 'local Supabase stack not reachable at 127.0.0.1:54321' }, () => {
  const ELIG_XLSX = join(OUTPUT_DIR, 'test-fixture-eligibility.xlsx');
  const ELIG_STATE = join(OUTPUT_DIR, 'test-state-eligibility.json');
  // Covers every combination the approved rule requires: blank/No/Yes
  // crossed with Number Valid blank/set, proving Number Valid has zero
  // effect on eligibility in either direction.
  const ELIG_PLACES = ['ELIG-TEST-1', 'ELIG-TEST-2', 'ELIG-TEST-3', 'ELIG-TEST-4', 'ELIG-TEST-5', 'ELIG-TEST-6'];
  const eligArgs = [`--file=${ELIG_XLSX}`, `--state-file=${ELIG_STATE}`];

  function buildEligibilityFixture() {
    // phone is deliberately non-null for every row here: this suite tests
    // the "Menu List Under 100" blank-only eligibility rule specifically,
    // and the phone-aware resend rule (see the dedicated describe blocks
    // below) must not confound it — a null phone would make the two
    // blank-eligible rows (ELIG_PLACES[0]/[5]) invisible to push()
    // regardless of Menu List Under 100, which is not what this suite is
    // testing.
    const base = { formatted_address: 'addr', latitude: 12.9, longitude: 77.6, primary_type: 'restaurant', business_status: 'OPERATIONAL', google_price_level: 'PRICE_LEVEL_INEXPENSIVE', website_uri: null, phone: '099000 09999', google_maps_uri: 'uri', discovery_sources: 'src', verification_status: 'unverified', verified_le_100: false, 'Menu Details/Notes': null };
    const rows = [
      // blank Menu List Under 100 + blank Number Valid -> eligible
      { ...base, place_id: ELIG_PLACES[0], name: 'Elig blank + NumberValid blank', 'Number Valid': null, 'Menu List Under 100': null },
      // blank Number Valid + No -> not eligible
      { ...base, place_id: ELIG_PLACES[1], name: 'Elig No + NumberValid blank', 'Number Valid': null, 'Menu List Under 100': 'No' },
      // blank Number Valid + Yes -> not eligible
      { ...base, place_id: ELIG_PLACES[2], name: 'Elig Yes + NumberValid blank', 'Number Valid': null, 'Menu List Under 100': 'Yes' },
      // No, with Number Valid SET -> still not eligible (proves Number Valid doesn't matter)
      { ...base, place_id: ELIG_PLACES[3], name: 'Elig No + NumberValid set', 'Number Valid': 'Yes', 'Menu List Under 100': 'No' },
      // Yes, with Number Valid SET -> still not eligible
      { ...base, place_id: ELIG_PLACES[4], name: 'Elig Yes + NumberValid set', 'Number Valid': 'Yes', 'Menu List Under 100': 'Yes' },
      // blank Menu List Under 100, with Number Valid SET -> still eligible
      { ...base, place_id: ELIG_PLACES[5], name: 'Elig blank + NumberValid set', 'Number Valid': 'No', 'Menu List Under 100': null },
    ];

    const headers = Object.keys(rows[0]);
    const pyPath = join(OUTPUT_DIR, '.build-eligibility-fixture.py');
    const script = `
import json, sys
import openpyxl
headers = json.loads(sys.argv[1])
rows = json.loads(sys.argv[2])
path = sys.argv[3]
wb = openpyxl.Workbook()
ws = wb.active
ws.append(headers)
for row in rows:
    ws.append([row.get(h) for h in headers])
wb.save(path)
`;
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(pyPath, script, 'utf8');
    const result = spawnSync('python', [pyPath, JSON.stringify(headers), JSON.stringify(rows), ELIG_XLSX], { encoding: 'utf8' });
    unlinkSync(pyPath);
    if (result.status !== 0) throw new Error(`Could not build eligibility fixture: ${result.stderr || result.stdout}`);
  }

  function cleanupEligibilityArtifacts() {
    for (const f of [ELIG_XLSX, ELIG_STATE]) {
      if (existsSync(f)) rmSync(f, { force: true });
    }
    if (existsSync(BACKUPS_DIR)) {
      for (const f of readdirSync(BACKUPS_DIR)) {
        if (f.startsWith('test-fixture-eligibility.xlsx')) rmSync(join(BACKUPS_DIR, f), { force: true });
      }
    }
  }

  async function cleanupEligibilityDb() {
    for (const placeId of ELIG_PLACES) {
      await dbDeleteHard(placeId);
    }
  }

  before(async () => {
    cleanupEligibilityArtifacts();
    await cleanupEligibilityDb();
    buildEligibilityFixture();
  });

  after(async () => {
    cleanupEligibilityArtifacts();
    await cleanupEligibilityDb();
  });

  test('status on a fresh eligibility fixture: 2 Yes, 2 No, 2 blank/eligible', () => {
    const { status, stdout, stderr } = runScript(['--status', ...eligArgs]);
    assert.equal(status, 0, stdout + stderr);
    assert.match(stdout, /Total candidates\s*: 6/);
    assert.match(stdout, /Already manually verified \(Yes\)\s*: 2/);
    assert.match(stdout, /Not eligible \(No\)\s*: 2/);
    assert.match(stdout, /Eligible for research \(blank\)\s*: 2/);
    assert.match(stdout, /In progress \(active batch\)\s*: 0/);
    assert.match(stdout, /Completed \(pulled \+ purged\)\s*: 0/);
    assert.match(stdout, /Remaining eligible \(blank, not yet pushed\/completed\)\s*: 2/);
  });

  test('push selects ONLY the blank rows, regardless of Number Valid', async () => {
    const { status, stdout, stderr } = runScript(['--push', '--batch-size=10', ...eligArgs]);
    assert.equal(status, 0, stdout + stderr);
    assert.match(stdout, /Pushed batch 1: 2 candidate\(s\)/);

    assert.ok(await dbGet(ELIG_PLACES[0]), 'blank + Number Valid blank must be pushed');
    assert.ok(await dbGet(ELIG_PLACES[5]), 'blank + Number Valid set must still be pushed — Number Valid never gates eligibility');

    assert.equal(await dbGet(ELIG_PLACES[1]), null, 'No + Number Valid blank must never be pushed');
    assert.equal(await dbGet(ELIG_PLACES[2]), null, 'Yes + Number Valid blank must never be pushed');
    assert.equal(await dbGet(ELIG_PLACES[3]), null, 'No + Number Valid set must never be pushed');
    assert.equal(await dbGet(ELIG_PLACES[4]), null, 'Yes + Number Valid set must never be pushed');
  });

  test('status while the batch is active: remaining eligible drops to 0, Yes/No/blank breakdown unchanged', () => {
    const { status, stdout, stderr } = runScript(['--status', ...eligArgs]);
    assert.equal(status, 0, stdout + stderr);
    // push() never writes the xlsx, so the raw Yes/No/blank counts (a
    // property of the file's current content) are exactly as before.
    assert.match(stdout, /Already manually verified \(Yes\)\s*: 2/);
    assert.match(stdout, /Not eligible \(No\)\s*: 2/);
    assert.match(stdout, /Eligible for research \(blank\)\s*: 2/);
    assert.match(stdout, /In progress \(active batch\)\s*: 2/);
    assert.match(stdout, /Completed \(pulled \+ purged\)\s*: 0/);
    // Both blank rows are now in progress, so none are left remaining — and
    // critically, no No/Yes row is ever counted here regardless.
    assert.match(stdout, /Remaining eligible \(blank, not yet pushed\/completed\)\s*: 0/);
  });

  test('cleanup: purge the eligibility test batch, leaving the suite with no active batch', async () => {
    const { status, stdout, stderr } = runScript(['--pull', '--purge', ...eligArgs]);
    assert.equal(status, 0, stdout + stderr);
    assert.match(stdout, /Purged 2 row\(s\)\./);
  });
});

// Dedicated, isolated suite for the phone-aware resend rule (added
// 2026-10-16, owner's explicit instruction after Batch 30 turned out
// 100% phone-less — see workbench-sync.mjs's own PHONE-AWARE RESEND RULE
// comment above isResendEligible). Own fixture/state files, same
// isolation convention as the eligibility suite above.
describe('workbench-sync.mjs — phone-aware resend rule: fresh-before-resend priority', { skip: !stackReachable && 'local Supabase stack not reachable at 127.0.0.1:54321' }, () => {
  const XLSX = join(OUTPUT_DIR, 'test-fixture-resend-priority.xlsx');
  const STATE = join(OUTPUT_DIR, 'test-state-resend-priority.json');
  const P = ['RESEND-PRI-1-nophone', 'RESEND-PRI-2-fresh', 'RESEND-PRI-3-resend-eligible'];
  const args = [`--file=${XLSX}`, `--state-file=${STATE}`];

  function buildFixture() {
    const base = { formatted_address: 'addr', latitude: 12.9, longitude: 77.6, primary_type: 'restaurant', business_status: 'OPERATIONAL', google_price_level: 'PRICE_LEVEL_INEXPENSIVE', website_uri: null, google_maps_uri: 'uri', discovery_sources: 'src', verification_status: 'unverified', verified_le_100: false, 'Menu Details/Notes': null };
    const rows = [
      // No phone at all, never touched — must never be selected, fresh or resend.
      { ...base, place_id: P[0], name: 'No phone, untouched', phone: null, 'Number Valid': null, 'Menu List Under 100': null },
      // Phone, never touched — the genuine fresh candidate.
      { ...base, place_id: P[1], name: 'Fresh with phone', phone: '099000 00101', 'Number Valid': null, 'Menu List Under 100': null },
      // Phone, already in state.completed (seeded below), "No Answer" —
      // resend-eligible, but must lose to the fresh candidate above when
      // batch size only allows one.
      { ...base, place_id: P[2], name: 'Already-sent, no answer', phone: '099000 00102', 'Number Valid': 'No Answer', 'Menu List Under 100': null },
    ];
    const headers = Object.keys(rows[0]);
    const pyPath = join(OUTPUT_DIR, '.build-resend-priority-fixture.py');
    const script = `
import json, sys
import openpyxl
headers = json.loads(sys.argv[1])
rows = json.loads(sys.argv[2])
path = sys.argv[3]
wb = openpyxl.Workbook()
ws = wb.active
ws.append(headers)
for row in rows:
    ws.append([row.get(h) for h in headers])
wb.save(path)
`;
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(pyPath, script, 'utf8');
    const result = spawnSync('python', [pyPath, JSON.stringify(headers), JSON.stringify(rows), XLSX], { encoding: 'utf8' });
    unlinkSync(pyPath);
    if (result.status !== 0) throw new Error(`Could not build resend-priority fixture: ${result.stderr || result.stdout}`);
  }

  function cleanupArtifacts() {
    for (const f of [XLSX, STATE]) if (existsSync(f)) rmSync(f, { force: true });
    if (existsSync(BACKUPS_DIR)) {
      for (const f of readdirSync(BACKUPS_DIR)) {
        if (f.startsWith('test-fixture-resend-priority.xlsx')) rmSync(join(BACKUPS_DIR, f), { force: true });
      }
    }
  }

  async function cleanupDb() {
    for (const placeId of P) await dbDeleteHard(placeId);
  }

  before(async () => {
    cleanupArtifacts();
    await cleanupDb();
    buildFixture();
    // Seed P[2] as already-completed (sent once before, no answer) —
    // never created via a real push/pull/purge cycle here since the point
    // of this test is purely the selection/ordering decision, not the
    // round-trip itself (that's covered by the other describe block).
    writeFileSync(
      STATE,
      JSON.stringify(
        {
          completed: { [P[2]]: { name: 'Already-sent, no answer', batch_id: '0', completed_at: '2026-01-01T00:00:00.000Z', times_sent: 1 } },
          in_progress: {},
          nextBatch: 1,
        },
        null,
        2
      ),
      'utf8'
    );
  });

  after(async () => {
    cleanupArtifacts();
    await cleanupDb();
  });

  test('push --batch-size=1 picks the fresh phone candidate over the resend-eligible one, and never considers the phone-less row', async () => {
    const { status, stdout, stderr } = runScript(['--push', '--batch-size=1', ...args]);
    assert.equal(status, 0, stdout + stderr);
    assert.match(stdout, /Pushed batch 1: 1 candidate\(s\) \(1 fresh, 0 resend\)/);

    assert.ok(await dbGet(P[1]), 'the fresh phone candidate should have been pushed');
    assert.equal(await dbGet(P[0]), null, 'the phone-less row must never be pushed');
    assert.equal(await dbGet(P[2]), null, 'the resend-eligible row must lose to the fresh candidate when batch size is 1');
  });

  test('cleanup: purge the one-row batch', async () => {
    const { status, stdout, stderr } = runScript(['--pull', '--purge', ...args]);
    assert.equal(status, 0, stdout + stderr);
    assert.match(stdout, /Purged 1 row\(s\)\./);
  });
});

describe('workbench-sync.mjs — phone-aware resend rule: pool filtering, blanking, and times_sent', { skip: !stackReachable && 'local Supabase stack not reachable at 127.0.0.1:54321' }, () => {
  const XLSX = join(OUTPUT_DIR, 'test-fixture-resend-pool.xlsx');
  const STATE = join(OUTPUT_DIR, 'test-state-resend-pool.json');
  // R1: "No Answer"/blank -> resend-eligible.
  // R2: Menu List Under 100 = "No" -> Rule 1, never resend.
  // R3: Number Valid = "No" -> Rule 2, never resend.
  // R4: Number Valid = "Yes", Menu List Under 100 blank (qualification
  //     simply never recorded) -> resend-eligible per the owner's explicit
  //     decision to include this bucket.
  // R5: "No Answer"/blank but already at the resend cap (times_sent=3) ->
  //     excluded, must not be pushed again.
  const P = ['RESEND-POOL-R1', 'RESEND-POOL-R2', 'RESEND-POOL-R3', 'RESEND-POOL-R4', 'RESEND-POOL-R5'];
  const args = [`--file=${XLSX}`, `--state-file=${STATE}`];

  function buildFixture() {
    const base = { formatted_address: 'addr', latitude: 12.9, longitude: 77.6, primary_type: 'restaurant', business_status: 'OPERATIONAL', google_price_level: 'PRICE_LEVEL_INEXPENSIVE', website_uri: null, google_maps_uri: 'uri', discovery_sources: 'src', verification_status: 'unverified', verified_le_100: false, 'Menu Details/Notes': null };
    const rows = [
      { ...base, place_id: P[0], name: 'Resend eligible (no answer)', phone: '099000 00201', 'Number Valid': 'No Answer', 'Menu List Under 100': null },
      { ...base, place_id: P[1], name: 'Rule 1 excluded (qualify=No)', phone: '099000 00202', 'Number Valid': 'No Answer', 'Menu List Under 100': 'No' },
      { ...base, place_id: P[2], name: 'Rule 2 excluded (number=No)', phone: '099000 00203', 'Number Valid': 'No', 'Menu List Under 100': null },
      { ...base, place_id: P[3], name: 'Resend eligible (valid number, qualify never recorded)', phone: '099000 00204', 'Number Valid': 'Yes', 'Menu List Under 100': null },
      { ...base, place_id: P[4], name: 'At resend cap', phone: '099000 00205', 'Number Valid': 'No Answer', 'Menu List Under 100': null },
    ];
    const headers = Object.keys(rows[0]);
    const pyPath = join(OUTPUT_DIR, '.build-resend-pool-fixture.py');
    const script = `
import json, sys
import openpyxl
headers = json.loads(sys.argv[1])
rows = json.loads(sys.argv[2])
path = sys.argv[3]
wb = openpyxl.Workbook()
ws = wb.active
ws.append(headers)
for row in rows:
    ws.append([row.get(h) for h in headers])
wb.save(path)
`;
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(pyPath, script, 'utf8');
    const result = spawnSync('python', [pyPath, JSON.stringify(headers), JSON.stringify(rows), XLSX], { encoding: 'utf8' });
    unlinkSync(pyPath);
    if (result.status !== 0) throw new Error(`Could not build resend-pool fixture: ${result.stderr || result.stdout}`);
  }

  function cleanupArtifacts() {
    for (const f of [XLSX, STATE]) if (existsSync(f)) rmSync(f, { force: true });
    if (existsSync(BACKUPS_DIR)) {
      for (const f of readdirSync(BACKUPS_DIR)) {
        if (f.startsWith('test-fixture-resend-pool.xlsx')) rmSync(join(BACKUPS_DIR, f), { force: true });
      }
    }
  }

  async function cleanupDb() {
    for (const placeId of P) await dbDeleteHard(placeId);
  }

  function seedState() {
    const completed = {};
    for (const [i, placeId] of P.entries()) {
      completed[placeId] = {
        name: `Seed ${i}`,
        batch_id: '0',
        completed_at: '2026-01-01T00:00:00.000Z',
        times_sent: placeId === P[4] ? 3 : 1,
      };
    }
    writeFileSync(STATE, JSON.stringify({ completed, in_progress: {}, nextBatch: 1 }, null, 2), 'utf8');
  }

  before(async () => {
    cleanupArtifacts();
    await cleanupDb();
    buildFixture();
    seedState();
  });

  after(async () => {
    cleanupArtifacts();
    await cleanupDb();
  });

  test('push selects only the resend-eligible rows (R1, R4), excludes Rule 1/Rule 2/cap rows, and blanks their stale Number Valid/Menu List Under 100 on the live row', async () => {
    const { status, stdout, stderr } = runScript(['--push', '--batch-size=10', ...args]);
    assert.equal(status, 0, stdout + stderr);
    assert.match(stdout, /Pushed batch 1: 2 candidate\(s\) \(0 fresh, 2 resend\)/);

    const r1 = await dbGet(P[0]);
    const r4 = await dbGet(P[3]);
    assert.ok(r1, 'R1 (No Answer, unresolved) must be resend-eligible');
    assert.ok(r4, 'R4 (Yes + qualification never recorded) must be resend-eligible per the owner\'s decision');
    assert.equal(r1.number_valid, null, 'the stale "No Answer" must be blanked on the fresh push, not carried forward');
    assert.equal(r1.menu_list_under_100, null);
    assert.equal(r4.number_valid, null, 'the stale "Yes" must also be blanked — the row starts clean regardless of its prior value');
    assert.equal(r4.menu_list_under_100, null);

    assert.equal(await dbGet(P[1]), null, 'Rule 1 (Menu List Under 100=No) must never be resent');
    assert.equal(await dbGet(P[2]), null, 'Rule 2 (Number Valid=No) must never be resent');
    assert.equal(await dbGet(P[4]), null, 'a row already at the resend cap (times_sent=3) must never be resent again');

    const state = readFileSync(STATE, 'utf8');
    const parsed = JSON.parse(state);
    assert.equal(parsed.in_progress[P[0]].times_sent, 2, 'times_sent increments from 1 to 2 on resend');
    assert.equal(parsed.in_progress[P[3]].times_sent, 2);
  });

  test('pull --purge carries times_sent through unchanged into the completed entry', async () => {
    const { status, stdout, stderr } = runScript(['--pull', '--purge', ...args]);
    assert.equal(status, 0, stdout + stderr);
    assert.match(stdout, /Purged 2 row\(s\)\./);

    const state = JSON.parse(readFileSync(STATE, 'utf8'));
    assert.equal(state.completed[P[0]].times_sent, 2, 'times_sent carried through from in_progress, not reset');
    assert.equal(state.completed[P[3]].times_sent, 2);
    // Never touched by this cycle — their original seeded entries stand.
    assert.equal(state.completed[P[1]].times_sent, 1);
    assert.equal(state.completed[P[2]].times_sent, 1);
    assert.equal(state.completed[P[4]].times_sent, 3);
  });
});
