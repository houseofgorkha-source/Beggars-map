// Beggars Map — Discovery Workbench sync (Phase 2 of the approved Discovery
// Workbench plan). Moves one batch of eligible (Menu List Under 100 blank)
// candidates between
// the local WIP xlsx/photos (the permanent source of truth, per the
// approved architecture) and Supabase's discovery_batch_rows table /
// discovery-photos bucket (transient, one-batch-at-a-time working storage
// for a remote intern reviewing candidates through the hosted page).
//
// LOCAL SUPABASE ONLY. This script has no --linked/--production option at
// all, unlike import-excel.mjs — there is no "production mode" for this
// tool because discovery_batch_rows/discovery-photos are themselves
// transient scaffolding, never a destination for real listing data. It
// never touches tools/discovery/import-excel.mjs, the listings/
// listing_photos tables, or any existing migration.
//
// ============================ WORKFLOW ================================
//   node tools/discovery/workbench-sync.mjs --status
//     -> counts by Menu List Under 100 (Yes/No/blank), completed/in-progress/
//        remaining-eligible, and (if a batch is active) how many of it are
//        reviewed so far
//   node tools/discovery/workbench-sync.mjs --push [--batch-size=50]
//     -> selects the next N eligible candidates (Menu List Under 100 blank —
//        see isEligibleForResearch), inserts them into discovery_batch_rows,
//        uploads their existing local photos (if any) to discovery-photos.
//        Refuses if a batch is already active.
//   node tools/discovery/workbench-sync.mjs --pull
//     -> downloads the active batch's current rows/photos, backs up the
//        xlsx, writes the edits back into it, verifies the write. Leaves
//        the batch live in Supabase (safe to re-run any time, e.g. as a
//        daily safety snapshot while the intern keeps working).
//   node tools/discovery/workbench-sync.mjs --pull --purge
//     -> does everything --pull does, then deletes the batch's rows/photos
//        from Supabase to reclaim quota. Only rows whose photo cleanup
//        actually succeeds are marked complete and removed; anything that
//        fails stays in progress for the next --pull --purge to retry.
//
// Test-only overrides (a real run never needs these): --file=<xlsx>,
// --state-file=<path>. Both default to the real WIP xlsx / the real state
// file. This is what lets the automated test suite exercise push/pull/
// purge/idempotency/failure-recovery without ever touching the real
// 3,586-row workbook or the real photos folder's real candidates.
//
// ==================== RESUMABLE / IDEMPOTENT ===========================
// State file (tools/discovery/output/workbench-state.json):
//   { completed: { [place_id]: { name, batch_id, completed_at } },
//     in_progress: { [place_id]: { name, batch_id, pushed_at } },
//     nextBatch: <int> }
//
// Before every command that touches Supabase, the live discovery_batch_rows
// table is re-read and reconciled against this state file (never trusted
// blindly, same philosophy as import-excel.mjs's own "the database that is
// about to be written is re-read and checked" rule): a row live in Supabase
// but missing from state.in_progress is adopted (recovers from a crash
// between INSERT and state-save on push); a row in state.in_progress but no
// longer live in Supabase is moved to completed (recovers from a crash
// between DELETE and state-save on purge). This makes every command safe
// to interrupt and re-run at any point.
//
// Push eligibility is a permanent scoping rule on "Menu List Under 100"
// alone, not a workflow-progress check (see isEligibleForResearch): blank
// means open to intern research; "No" means already excluded from Beggars
// Map's own qualification and must never be re-offered; "Yes" means already
// manually verified by some other means and done. "Number Valid" plays no
// part in this decision. A row the old manual-Excel process already marked
// "No"/"Yes" is therefore never selected for push, even if this tool has
// never seen it before.
//
// Purge order is deliberately photos-then-rows, per place_id, not one bulk
// step: if photo cleanup for a place_id fails partway, that place_id simply
// stays in_progress (its DB row is NOT deleted) rather than the whole batch
// aborting or silently leaving orphaned photos with no way to retry them.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { dirname, join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, statSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const OUTPUT_DIR = join(HERE, 'output');
const PHOTOS_DIR = join(HERE, 'photos');
const BACKUPS_DIR = join(OUTPUT_DIR, 'backups');
const DEFAULT_STATE_FILE = join(OUTPUT_DIR, 'workbench-state.json');
const DEFAULT_XLSX = join(OUTPUT_DIR, 'candidates-2026-09-01T11-50-51-056Z workonprogress.xlsx');
const BUCKET = 'discovery-photos';
const DEFAULT_BATCH_SIZE = 50;

const NUMBER_VALID_COLUMN = 'Number Valid';
const QUALIFY_COLUMN = 'Menu List Under 100';
const NOTES_COLUMN = 'Menu Details/Notes';
const VALID_NUMBER_VALID = ['Yes', 'No', 'No Answer'];
const VALID_QUALIFY = ['Yes', 'No'];

// Reference columns copied verbatim into discovery_batch_rows at push time.
// Duplicated here rather than imported from import-excel.mjs — that file is
// explicitly off-limits to modify, and its own constants aren't exported.
const REFERENCE_COLUMNS = [
  'formatted_address',
  'primary_type',
  'business_status',
  'google_price_level',
  'website_uri',
  'google_maps_uri',
  'discovery_sources',
];
const REQUIRED_COLUMNS = ['place_id', 'name', 'latitude', 'longitude', 'phone', NUMBER_VALID_COLUMN, QUALIFY_COLUMN, NOTES_COLUMN, ...REFERENCE_COLUMNS];

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
};

// ---------------------------------------------------------------- guards
// Duplicated from import-excel.mjs (not imported — that file must not be
// modified to export them, and this script must have no path to production
// at all, unlike that one).

function assertRepoRoot() {
  if (!existsSync(join(REPO_ROOT, 'supabase', 'config.toml'))) {
    throw new Error(`Run this from the repo (expected supabase/config.toml under ${REPO_ROOT}).`);
  }
}

function readProjectId() {
  const configPath = join(REPO_ROOT, 'supabase', 'config.toml');
  const match = readFileSync(configPath, 'utf8').match(/^project_id\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error(`Could not find project_id in ${configPath}.`);
  return match[1];
}

function assertLocalStackRunning(projectId) {
  const result = spawnSync(
    'docker',
    ['ps', '--filter', `label=com.supabase.cli.project=${projectId}`, '--filter', 'name=supabase_db_', '--format', '{{.Names}}'],
    { encoding: 'utf8', shell: true }
  );
  if (result.status !== 0) {
    throw new Error(`"docker ps" failed (${result.stderr || result.stdout}). Is Docker Desktop running? STOPPING.`);
  }
  const names = result.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) {
    throw new Error(`No running local Supabase DB container for project "${projectId}". Run "npx supabase start" first. STOPPING.`);
  }
  if (names.length > 1) {
    throw new Error(`Found multiple matching containers (${names.join(', ')}) — refusing to guess.`);
  }
  return names[0];
}

function readLocalStackConfig() {
  const result = spawnSync('npx', ['supabase', 'status', '-o', 'json'], { encoding: 'utf8', shell: true });
  if (result.status !== 0) {
    throw new Error(`"supabase status" failed: ${result.stderr || result.stdout}`);
  }
  const out = result.stdout;
  const start = out.indexOf('{');
  if (start === -1) throw new Error(`"supabase status" produced no JSON:\n${out.slice(0, 500)}`);
  const parsed = JSON.parse(out.slice(start));

  const apiUrl = parsed.API_URL;
  const serviceKey = parsed.SERVICE_ROLE_KEY;
  if (!apiUrl || !serviceKey) throw new Error('"supabase status" JSON had no API_URL / SERVICE_ROLE_KEY.');

  const host = new URL(apiUrl).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(`REFUSING TO RUN: API_URL "${apiUrl}" is not the local stack. This tool only ever touches a loopback Supabase.`);
  }
  return { apiUrl: apiUrl.replace(/\/$/, ''), serviceKey };
}

// ------------------------------------------------------------------ sql
// sqlString/runSql: same approach as import-excel.mjs (duplicated, not
// imported, for the same "must not modify that file" reason). Always
// --local — there is no other target this script will ever accept.

function sqlString(value) {
  if (value === null || value === undefined) return 'null';
  const text = String(value);
  if (text === '') return "''";

  const parts = [];
  let literal = '';
  const flushLiteral = () => {
    if (literal) {
      parts.push(`'${literal.replace(/'/g, "''")}'`);
      literal = '';
    }
  };

  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint >= 0x20 && codePoint <= 0x7e && char !== '\\') {
      literal += char;
    } else {
      flushLiteral();
      parts.push(`chr(${codePoint})`);
    }
  }
  flushLiteral();

  return parts.length === 1 ? parts[0] : parts.join(' || ');
}

function sqlNumber(value) {
  return Number.isFinite(value) ? String(value) : 'null';
}

function runSql(sql, { expectRows = false } = {}) {
  const result = spawnSync(
    'npx',
    ['supabase', 'db', 'query', '--local', '--output-format', 'json'],
    {
      input: sql,
      encoding: 'utf8',
      shell: true,
      maxBuffer: 32 * 1024 * 1024,
    }
  );
  if (result.status !== 0) {
  throw new Error(`"supabase db query --local" failed:\n${result.error?.message || result.stderr || result.stdout}`);
  }
  if (/"_tag"\s*:\s*"Error"/.test(result.stdout)) {
    throw new Error(`"supabase db query --local" returned an error:\n${result.stdout.slice(0, 800)}`);
  }
  if (!expectRows) return null;

  const out = result.stdout.trim();
  const jsonStart = out.search(/[{[]/);
  if (jsonStart === -1) throw new Error(`Expected JSON rows, got:\n${out.slice(0, 800)}`);
  let parsed;
  try {
    parsed = JSON.parse(out.slice(jsonStart));
  } catch (err) {
    throw new Error(`Could not parse query output as JSON (${err.message}):\n${out.slice(0, 800)}`);
  }
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rows) ? parsed.rows : null;
  if (!rows) throw new Error(`Query output had no rows array:\n${out.slice(0, 800)}`);
  return rows;
}

// --------------------------------------------------------------- xlsx io

function readWorkbook(xlsxPath) {
  if (!existsSync(xlsxPath)) throw new Error(`Input spreadsheet not found: ${xlsxPath}`);
  const result = spawnSync('python', [JSON.stringify(join(HERE, 'xlsx-to-json.py')), JSON.stringify(xlsxPath)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(`Reading the spreadsheet failed (is Python + openpyxl available?):\n${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout);
  const missing = REQUIRED_COLUMNS.filter((c) => !parsed.headers.includes(c));
  if (missing.length) {
    throw new Error(`Spreadsheet is missing required column(s): ${missing.join(', ')}. Found: ${parsed.headers.join(', ')}`);
  }
  return parsed.rows;
}

function writeUpdatesToXlsx(xlsxPath, updates) {
  const result = spawnSync('python', [JSON.stringify(join(HERE, 'write-updates-to-xlsx.py')), JSON.stringify(xlsxPath)], {
    input: JSON.stringify(updates),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(`Writing updates to the spreadsheet failed:\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

// ------------------------------------------------------------- photos io

function photosFor(placeId) {
  const dir = join(PHOTOS_DIR, placeId);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ filename: name, absolutePath: join(dir, name) }));
}

function encodePath(storagePath) {
  return storagePath.split('/').map(encodeURIComponent).join('/');
}

async function uploadPhoto(apiUrl, serviceKey, photo, storagePath) {
  const contentType = MIME_TYPES[extname(photo.filename).toLowerCase()] ?? 'application/octet-stream';
  const body = readFileSync(photo.absolutePath);
  const res = await fetch(`${apiUrl}/storage/v1/object/${BUCKET}/${encodePath(storagePath)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': contentType, 'x-upsert': 'true' },
    body,
  });
  if (!res.ok) {
    throw new Error(`Upload failed for ${storagePath} (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
}

async function listPhotos(apiUrl, serviceKey, placeId) {
  const res = await fetch(`${apiUrl}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: `${placeId}/` }),
  });
  if (!res.ok) throw new Error(`Listing photos failed for ${placeId} (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return await res.json();
}

async function downloadPhoto(apiUrl, serviceKey, storagePath) {
  const res = await fetch(`${apiUrl}/storage/v1/object/${BUCKET}/${encodePath(storagePath)}`, {
    headers: { Authorization: `Bearer ${serviceKey}` },
  });
  if (!res.ok) throw new Error(`Download failed for ${storagePath} (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

async function deleteObjects(apiUrl, serviceKey, storagePaths) {
  if (storagePaths.length === 0) return;
  const res = await fetch(`${apiUrl}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: storagePaths }),
  });
  if (!res.ok) throw new Error(`Deleting objects failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
}

// ------------------------------------------------------------- state io

function loadState(stateFilePath) {
  if (!existsSync(stateFilePath)) return { completed: {}, in_progress: {}, nextBatch: 1 };
  try {
    const parsed = JSON.parse(readFileSync(stateFilePath, 'utf8'));
    if (!parsed || typeof parsed.completed !== 'object' || typeof parsed.in_progress !== 'object') {
      throw new Error('unexpected shape');
    }
    parsed.nextBatch = Number.isInteger(parsed.nextBatch) ? parsed.nextBatch : 1;
    return parsed;
  } catch (err) {
    throw new Error(`Could not read ${stateFilePath} (${err.message}). Refusing to continue — fix or delete it.`);
  }
}

function saveState(stateFilePath, state) {
  mkdirSync(dirname(stateFilePath), { recursive: true });
  writeFileSync(stateFilePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// Re-reads the live table and repairs the state file against it — see the
// header comment for exactly which two crash windows this recovers from.
// Returns what it changed so callers can log it rather than silently fix
// things up.
function reconcileState(state, liveRows) {
  const liveByPlaceId = new Map(liveRows.map((r) => [r.place_id, r]));
  let adopted = 0;
  for (const row of liveRows) {
    if (!state.in_progress[row.place_id]) {
      state.in_progress[row.place_id] = {
        name: row.name,
        batch_id: row.batch_id,
        pushed_at: row.pushed_at ?? new Date().toISOString(),
      };
      adopted += 1;
    }
  }
  let reconciledAway = 0;
  for (const placeId of Object.keys(state.in_progress)) {
    if (!liveByPlaceId.has(placeId)) {
      state.completed[placeId] = { ...state.in_progress[placeId], completed_at: new Date().toISOString(), reconciled: true };
      delete state.in_progress[placeId];
      reconciledAway += 1;
    }
  }
  return { adopted, reconciledAway };
}

// -------------------------------------------------------- reviewed logic

// Push-eligibility gate — a permanent scoping rule, not a workflow-progress
// check: "Menu List Under 100" blank means genuinely undecided and open to
// intern research; "No" means already excluded from Beggars Map's own
// price-cap qualification (tools/discovery/matching.mjs's own domain, not
// re-litigated here) and must never be re-offered; "Yes" means already
// manually verified by some other means and done. Number Valid plays no
// part in this decision — a row can have "Number Valid" set or blank and
// still be exactly as eligible, since that column tracks something
// different (whether the phone number on file is correct).
function isEligibleForResearch(row) {
  const qualifies = typeof row[QUALIFY_COLUMN] === 'string' ? row[QUALIFY_COLUMN].trim() : '';
  return qualifies === '';
}

function isReviewedDbRow(row) {
  if (!row.number_valid) return false;
  if (row.menu_list_under_100 !== 'Yes' && row.menu_list_under_100 !== 'No') return false;
  if (row.menu_list_under_100 === 'Yes' && !row.notes) return false;
  return true;
}

// ------------------------------------------------------------------ push

async function push(xlsxPath, stateFilePath, batchSize) {
  const projectId = readProjectId();
  assertLocalStackRunning(projectId);
  const { apiUrl, serviceKey } = readLocalStackConfig();

  const state = loadState(stateFilePath);
  const liveRows = runSql('select place_id, name, batch_id, pushed_at from discovery_batch_rows;', { expectRows: true });
  const { adopted, reconciledAway } = reconcileState(state, liveRows);
  if (adopted || reconciledAway) {
    saveState(stateFilePath, state);
    console.log(`Reconciled state with Supabase (adopted ${adopted}, completed ${reconciledAway}).`);
  }

  const activeCount = Object.keys(state.in_progress).length;
  if (activeCount > 0) {
    const batchIds = [...new Set(Object.values(state.in_progress).map((e) => e.batch_id))];
    throw new Error(
      `REFUSING TO PUSH: batch(es) ${batchIds.join(', ')} still active with ${activeCount} row(s). ` +
        `Run --pull (and --pull --purge once done) before pushing a new batch.`
    );
  }

  const rows = readWorkbook(xlsxPath);
  const pool = rows.filter(
    (r) => typeof r.place_id === 'string' && r.place_id.trim() && !state.completed[r.place_id] && isEligibleForResearch(r)
  );
  const selected = pool.slice(0, batchSize);

  if (selected.length === 0) {
    console.log('Nothing to push — every candidate is already reviewed or completed.');
    return;
  }

  const batchNumber = state.nextBatch;
  const batchId = String(batchNumber);
  const pushedAt = new Date().toISOString();

  // REFERENCE_COLUMNS names already match discovery_batch_rows' own column
  // names 1:1 (see migration 0021), so they're used directly here.
  const columns = ['place_id', 'name', ...REFERENCE_COLUMNS, 'latitude', 'longitude', 'phone', 'number_valid', 'menu_list_under_100', 'batch_id', 'pushed_at'];

  let skippedInvalidEnum = 0;
  const valuesSql = selected
    .map((r) => {
      let numberValid = typeof r[NUMBER_VALID_COLUMN] === 'string' ? r[NUMBER_VALID_COLUMN].trim() : '';
      if (numberValid && !VALID_NUMBER_VALID.includes(numberValid)) {
        skippedInvalidEnum += 1;
        numberValid = '';
      }
      let qualifies = typeof r[QUALIFY_COLUMN] === 'string' ? r[QUALIFY_COLUMN].trim() : '';
      if (qualifies && !VALID_QUALIFY.includes(qualifies)) {
        skippedInvalidEnum += 1;
        qualifies = '';
      }

      const values = [
        sqlString(r.place_id),
        sqlString(r.name),
        ...REFERENCE_COLUMNS.map((c) => sqlString(r[c] ?? null)),
        sqlNumber(typeof r.latitude === 'number' ? r.latitude : Number(r.latitude)),
        sqlNumber(typeof r.longitude === 'number' ? r.longitude : Number(r.longitude)),
        sqlString(r.phone ?? null),
        sqlString(numberValid || null),
        sqlString(qualifies || null),
        sqlString(batchId),
        sqlString(pushedAt),
      ];
      return `(${values.join(', ')})`;
    })
    // No newline in this separator: the whole SQL string travels through
    // spawnSync's shell:true as one command-line argument, and a raw
    // newline embedded there does not survive the trip intact — confirmed
    // directly (a query built with a literal "\n" between VALUES tuples
    // fails with "syntax error at end of input"). sqlString() already
    // documents this exact hazard for values *inside* string literals; this
    // is the same hazard one level up, in the surrounding SQL text itself.
    .join(', ');

  runSql(`insert into discovery_batch_rows (${columns.join(', ')}) values ${valuesSql};`);

  let photosUploaded = 0;
  let photoFailures = 0;
  for (const r of selected) {
    for (const photo of photosFor(r.place_id)) {
      try {
        await uploadPhoto(apiUrl, serviceKey, photo, `${r.place_id}/${photo.filename}`);
        photosUploaded += 1;
      } catch (err) {
        photoFailures += 1;
        console.warn(`  photo upload failed for ${r.place_id}/${photo.filename}: ${err.message}`);
      }
    }
  }

  for (const r of selected) {
    state.in_progress[r.place_id] = { name: r.name, batch_id: batchId, pushed_at: pushedAt };
  }
  state.nextBatch = batchNumber + 1;
  saveState(stateFilePath, state);

  console.log(
    `Pushed batch ${batchId}: ${selected.length} candidate(s), ${photosUploaded} photo(s) uploaded` +
      (photoFailures ? `, ${photoFailures} photo failure(s)` : '') +
      (skippedInvalidEnum ? `, ${skippedInvalidEnum} legacy value(s) with an invalid dropdown option were reset to blank` : '') +
      '.'
  );
}

// ------------------------------------------------------------------ pull

async function pull(xlsxPath, stateFilePath, purge) {
  const projectId = readProjectId();
  assertLocalStackRunning(projectId);
  const { apiUrl, serviceKey } = readLocalStackConfig();

  const state = loadState(stateFilePath);
  const liveRows = runSql('select * from discovery_batch_rows;', { expectRows: true });
  const { adopted, reconciledAway } = reconcileState(state, liveRows);
  if (adopted || reconciledAway) {
    saveState(stateFilePath, state);
    console.log(`Reconciled state with Supabase (adopted ${adopted}, completed ${reconciledAway}).`);
  }

  const activePlaceIds = Object.keys(state.in_progress);
  if (activePlaceIds.length === 0) {
    console.log('Nothing to pull — no active batch.');
    return;
  }

  const liveByPlaceId = new Map(liveRows.map((r) => [r.place_id, r]));
  const rowsToApply = activePlaceIds.map((id) => liveByPlaceId.get(id)).filter(Boolean);
  if (rowsToApply.length !== activePlaceIds.length) {
    console.warn(`Warning: state tracks ${activePlaceIds.length} in-progress row(s) but only found ${rowsToApply.length} live — proceeding with what's live.`);
  }

  let photosDownloaded = 0;
  for (const r of rowsToApply) {
    const objects = await listPhotos(apiUrl, serviceKey, r.place_id);
    if (objects.length === 0) continue;
    const dir = join(PHOTOS_DIR, r.place_id);
    mkdirSync(dir, { recursive: true });
    for (const obj of objects) {
      const bytes = await downloadPhoto(apiUrl, serviceKey, `${r.place_id}/${obj.name}`);
      const tmpPath = join(dir, `.workbench-sync-tmp-${obj.name}`);
      writeFileSync(tmpPath, bytes);
      renameSync(tmpPath, join(dir, obj.name));
      photosDownloaded += 1;
    }
  }

  mkdirSync(BACKUPS_DIR, { recursive: true });
  const backupPath = join(BACKUPS_DIR, `${basename(xlsxPath)}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak.xlsx`);
  copyFileSync(xlsxPath, backupPath);

  const updates = {};
  for (const r of rowsToApply) {
    updates[r.place_id] = {
      phone: r.phone ?? null,
      [NUMBER_VALID_COLUMN]: r.number_valid ?? null,
      [QUALIFY_COLUMN]: r.menu_list_under_100 ?? null,
      [NOTES_COLUMN]: r.notes ?? null,
    };
  }

  writeUpdatesToXlsx(xlsxPath, updates);

  const verifyRows = readWorkbook(xlsxPath);
  const verifyByPlaceId = new Map(verifyRows.map((r) => [r.place_id, r]));
  for (const [placeId, fields] of Object.entries(updates)) {
    const row = verifyByPlaceId.get(placeId);
    if (!row) throw new Error(`Verification failed: ${placeId} not found in the spreadsheet after write.`);
    for (const [col, val] of Object.entries(fields)) {
      const actual = row[col] ?? null;
      if (actual !== val) {
        throw new Error(`Verification failed for ${placeId}.${col}: expected ${JSON.stringify(val)}, got ${JSON.stringify(actual)}`);
      }
    }
  }

  console.log(`Pulled ${rowsToApply.length} row(s), ${photosDownloaded} photo(s) downloaded. Backup: ${backupPath}`);

  if (!purge) {
    console.log('Batch left in Supabase (no --purge passed). Run with --purge once you are done reviewing it.');
    return;
  }

  const succeeded = [];
  const failed = [];
  for (const r of rowsToApply) {
    try {
      const objects = await listPhotos(apiUrl, serviceKey, r.place_id);
      if (objects.length > 0) {
        await deleteObjects(apiUrl, serviceKey, objects.map((o) => `${r.place_id}/${o.name}`));
      }
      succeeded.push(r);
    } catch (err) {
      failed.push(r.place_id);
      console.warn(`  photo purge failed for ${r.place_id}: ${err.message} — will retry on the next --pull --purge`);
    }
  }

  if (succeeded.length > 0) {
    const placeIdList = succeeded.map((r) => sqlString(r.place_id)).join(', ');
    runSql(`delete from discovery_batch_rows where place_id in (${placeIdList});`);
    const completedAt = new Date().toISOString();
    for (const r of succeeded) {
      state.completed[r.place_id] = { name: r.name, batch_id: r.batch_id, completed_at: completedAt };
      delete state.in_progress[r.place_id];
    }
    saveState(stateFilePath, state);
  }

  console.log(`Purged ${succeeded.length} row(s)${failed.length ? `, ${failed.length} left in progress for retry` : ''}.`);
}

// ---------------------------------------------------------------- status

function status(xlsxPath, stateFilePath) {
  const projectId = readProjectId();
  assertLocalStackRunning(projectId);

  const state = loadState(stateFilePath);
  let liveRows = [];
  try {
    liveRows = runSql(
      'select place_id, name, batch_id, number_valid, menu_list_under_100, notes, pushed_at from discovery_batch_rows;',
      { expectRows: true }
    );
    const { adopted, reconciledAway } = reconcileState(state, liveRows);
    if (adopted || reconciledAway) {
      saveState(stateFilePath, state);
      console.log(`Reconciled state with Supabase (adopted ${adopted}, completed ${reconciledAway}).\n`);
    }
  } catch (err) {
    console.warn(`Could not query Supabase (${err.message}) — showing local state only.\n`);
  }

  const rows = readWorkbook(xlsxPath);
  const totalCandidates = rows.filter((r) => typeof r.place_id === 'string' && r.place_id.trim()).length;
  const verifiedYes = rows.filter((r) => typeof r[QUALIFY_COLUMN] === 'string' && r[QUALIFY_COLUMN].trim() === 'Yes').length;
  const notEligibleNo = rows.filter((r) => typeof r[QUALIFY_COLUMN] === 'string' && r[QUALIFY_COLUMN].trim() === 'No').length;
  const eligibleBlank = rows.filter((r) => isEligibleForResearch(r)).length;
  const completedCount = Object.keys(state.completed).length;
  const inProgressCount = Object.keys(state.in_progress).length;
  // A blank row not currently tracked as in-progress or completed — the
  // exact same rule --push uses, checked per-row (not by subtraction) so a
  // completed row that happens to still be blank (the owner purged before
  // the intern actually filled anything in) is correctly excluded rather
  // than double-subtracted or missed. "No"/"Yes" rows can never appear
  // here, since isEligibleForResearch() already excludes them.
  const remainingEligible = rows.filter(
    (r) => isEligibleForResearch(r) && !state.in_progress[r.place_id] && !state.completed[r.place_id]
  ).length;

  console.log(`State file                          : ${stateFilePath}`);
  console.log(`Spreadsheet                         : ${xlsxPath}`);
  console.log(`Total candidates                    : ${totalCandidates}`);
  console.log(`Already manually verified (Yes)      : ${verifiedYes}`);
  console.log(`Not eligible (No)                    : ${notEligibleNo}`);
  console.log(`Eligible for research (blank)        : ${eligibleBlank}`);
  console.log(`In progress (active batch)           : ${inProgressCount}`);
  console.log(`Completed (pulled + purged)          : ${completedCount}`);
  console.log(`Remaining eligible (blank, not yet pushed/completed) : ${remainingEligible}`);

  if (inProgressCount > 0) {
    const batchIds = [...new Set(Object.values(state.in_progress).map((e) => e.batch_id))];
    const liveByPlaceId = new Map(liveRows.map((r) => [r.place_id, r]));
    let reviewedInBatch = 0;
    for (const placeId of Object.keys(state.in_progress)) {
      const live = liveByPlaceId.get(placeId);
      if (live && isReviewedDbRow(live)) reviewedInBatch += 1;
    }
    console.log('');
    console.log(`Active batch(es): ${batchIds.join(', ')}`);
    console.log(`  ${reviewedInBatch} / ${inProgressCount} reviewed so far in the active batch`);
  } else {
    console.log('');
    console.log('No active batch.');
  }
}

// ------------------------------------------------------------------ main

async function main() {
  assertRepoRoot();
  const args = process.argv.slice(2);

  if (args.some((a) => a === '--linked' || a === '--production' || a.startsWith('--project-ref'))) {
    throw new Error('REFUSING TO RUN: this tool is local-only. It has no --linked/--production/--project-ref option.');
  }

  const fileArg = args.find((a) => a.startsWith('--file='));
  const xlsxPath = fileArg ? fileArg.slice('--file='.length) : DEFAULT_XLSX;
  const stateArg = args.find((a) => a.startsWith('--state-file='));
  const stateFilePath = stateArg ? stateArg.slice('--state-file='.length) : DEFAULT_STATE_FILE;
  const batchSizeArg = args.find((a) => a.startsWith('--batch-size='));
  const batchSize = batchSizeArg ? Number(batchSizeArg.slice('--batch-size='.length)) : DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`Invalid --batch-size: "${batchSizeArg}"`);
  }

  if (args.includes('--status')) return status(xlsxPath, stateFilePath);
  if (args.includes('--push')) return push(xlsxPath, stateFilePath, batchSize);
  if (args.includes('--pull')) return pull(xlsxPath, stateFilePath, args.includes('--purge'));

  console.log('Usage:');
  console.log('  node tools/discovery/workbench-sync.mjs --status');
  console.log('  node tools/discovery/workbench-sync.mjs --push [--batch-size=50]');
  console.log('  node tools/discovery/workbench-sync.mjs --pull [--purge]');
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
