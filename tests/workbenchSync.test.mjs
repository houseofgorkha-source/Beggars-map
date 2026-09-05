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
    { place_id: PLACES[5], name: 'Test Place Six (bad enum)', formatted_address: '6 Test Rd, Bengaluru', latitude: 12.95, longitude: 77.65, primary_type: 'restaurant', business_status: 'OPERATIONAL', google_price_level: 'PRICE_LEVEL_INEXPENSIVE', website_uri: null, phone: '099000 00006', google_maps_uri: 'https://maps.google.com/?cid=6', discovery_sources: 'Test:query', verification_status: 'unverified', verified_le_100: false, 'Number Valid': 'Bogus', 'Menu List Under 100': 'Weird', 'Menu Details/Notes': null },
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

  test('status on a fresh fixture: 4 remaining, 1 legacy-reviewed, no active batch', () => {
    const { status, stdout, stderr } = runScript(['--status', ...commonArgs]);
    assert.equal(status, 0, stdout + stderr);
    assert.match(stdout, /Total candidates\s*: 7/);
    assert.match(stdout, /Already reviewed \(legacy, never pushed\)\s*: 1/);
    assert.match(stdout, /In progress \(active batch\)\s*: 0/);
    assert.match(stdout, /Remaining \(eligible for next push\)\s*: 6/);
    assert.match(stdout, /No active batch\./);
  });

  test('push --batch-size=2 selects the first 2 eligible rows in order, uploads the one existing photo', async () => {
    const { status, stdout, stderr } = runScript(['--push', '--batch-size=2', ...commonArgs]);
    assert.equal(status, 0, stdout + stderr);
    assert.match(stdout, /Pushed batch 1: 2 candidate\(s\), 1 photo\(s\) uploaded\./);

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

  test('status after a full cycle reflects completed/legacy/remaining correctly', () => {
    const { status, stdout, stderr } = runScript(['--status', ...commonArgs]);
    assert.equal(status, 0, stdout + stderr);
    assert.match(stdout, /Completed \(pulled \+ purged\)\s*: 2/);
    assert.match(stdout, /Already reviewed \(legacy, never pushed\)\s*: 1/);
    assert.match(stdout, /In progress \(active batch\)\s*: 0/);
    assert.match(stdout, /Remaining \(eligible for next push\)\s*: 4/);
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

  test('push tolerates an invalid legacy dropdown value: coerces to null without blocking the rest of the batch', async () => {
    // TEST-WBSYNC-6 has "Bogus"/"Weird" pre-filled (not valid dropdown
    // values) and TEST-WBSYNC-7 is a normal blank row, pushed together.
    const { status, stdout, stderr } = runScript(['--push', '--batch-size=2', ...commonArgs]);
    assert.equal(status, 0, stdout + stderr);
    assert.match(stdout, /Pushed batch \d+: 2 candidate\(s\)/);
    // TEST-WBSYNC-6 has both "Number Valid" and "Menu List Under 100"
    // pre-filled with invalid values, so 2 individual values are reset, not
    // 1 row — the count is per-value, matching what actually gets fixed.
    assert.match(stdout, /2 legacy value\(s\) with an invalid dropdown option were reset to blank/);

    const bad = await dbGet(PLACES[5]);
    const good = await dbGet(PLACES[6]);
    assert.ok(bad, 'the row with invalid legacy values should still have been pushed');
    assert.equal(bad.number_valid, null);
    assert.equal(bad.menu_list_under_100, null);
    assert.ok(good, 'the other row in the same batch must be unaffected');

    // Clean up this batch so the suite ends with no active batch.
    const { status: purgeStatus, stdout: purgeOut, stderr: purgeErr } = runScript(['--pull', '--purge', ...commonArgs]);
    assert.equal(purgeStatus, 0, purgeOut + purgeErr);
  });
});
