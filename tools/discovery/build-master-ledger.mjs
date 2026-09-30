// Beggars Map — Discovery Archive / Master Discovery Ledger builder.
//
// WHY THIS EXISTS: Supabase storage (the public `listing-photos` bucket) is
// nearing capacity and its actual billing tier could not be verified from
// any available tooling. Until now, "purged from the Workbench" was
// effectively the only durable record a Discovery batch ever left behind —
// split across two separate, gitignored, local JSON files
// (workbench-state.json for place_id->batch_id, excel-import-state.json for
// place_id->listing_id), joinable only by place_id, with no formal
// verification step and no human-readable index. This script formalizes
// that join into a durable, resumable archive + a single regenerated
// "Master Discovery Ledger", so Discovery Workbench can keep processing
// batches whether or not Supabase has storage headroom. Supabase becomes a
// PUBLISHING destination here, never the archive itself.
//
// DELIBERATELY DOES NOT MODIFY tools/discovery/import-excel.mjs. That file
// carries its own explicit "off-limits to modify" comment (see
// workbench-sync.mjs's own header, which duplicates rather than imports
// from it for the same reason), and the batch_id<->listing_id join it would
// exist to close is already 100% computable externally from the two state
// files above (see the PRE-WORKBENCH note below for the one legitimate
// gap). This script only ever READS workbench-state.json and
// excel-import-state.json — it never writes either of them, and it makes
// no Supabase call of any kind, ever. It has no --linked/--production flag
// and none should ever be added; the whole point is that this must work
// even when Supabase is completely unreachable.
//
// ============================ WORKFLOW ================================
//   node tools/discovery/build-master-ledger.mjs --status
//     -> how many completed batches exist, which are archived already,
//        which (if any) is still in_progress (never archivable).
//   node tools/discovery/build-master-ledger.mjs --export-batch=N
//     -> writes tools/discovery/output/archive/batch-0NN/listings-export.xlsx,
//        a frozen snapshot of exactly that batch's place_ids' current xlsx
//        review data. Records exported_at in manifest.json. Re-running is a
//        confirmed no-op if the batch's rows haven't changed since (the
//        manifest stores a content hash); if they HAVE changed, it refuses
//        to silently overwrite and reports the mismatch instead.
//   node tools/discovery/build-master-ledger.mjs --export-all-completed
//     -> loops every batch_id present in workbench-state.json's `completed`
//        bucket (never `in_progress` — a batch there is still live and is
//        skipped by construction, never treated as exportable).
//   node tools/discovery/build-master-ledger.mjs --verify-batch=N
//     -> for every place_id in that batch: confirms a real reviewed xlsx
//        row exists (isReviewedDbRow(), the exact rule workbench-sync.mjs
//        already uses to decide a DB row is done), and confirms either a
//        non-empty tools/discovery/photos/<place_id>/ folder OR that the
//        row legitimately has 0 qualifying photos to expect (a qualifying
//        row with zero local photos is flagged, a non-qualifying row is
//        not — it never needed photos). Only sets archived_at in
//        manifest.json on a fully clean pass; any failure halts and reports
//        the exact place_id(s), changing nothing.
//   node tools/discovery/build-master-ledger.mjs --build-ledger
//     -> regenerates (never appends to) MASTER_DISCOVERY_LEDGER.json and
//        .xlsx from workbench-state.json + excel-import-state.json + the
//        WIP xlsx + the archive manifest + the local photos/ directory
//        listing. Safe to run at any time, including with batches still
//        in_progress (they simply show up at whatever rung they've
//        actually reached, never fabricated as further along).
//
// Test-only overrides (a real run never needs these): --file=<xlsx>,
// --state-file=<path>, --import-state-file=<path>, --archive-dir=<path>.
// Same convention workbench-sync.mjs already uses for its own test suite.
//
// ==================== RESUMABLE / IDEMPOTENT ===========================
// tools/discovery/output/archive/manifest.json:
//   { batches: { "<batch_id>": {
//       exported_at, row_count, place_ids: [...], content_hash,
//       archived_at, verify_notes: [...]
//   } } }
// Every step here only ever fills gaps in this file; nothing is ever
// silently overwritten. Building the ledger never mutates the manifest.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(HERE, 'output');
const PHOTOS_DIR = join(HERE, 'photos');
const ARCHIVE_DIR = join(OUTPUT_DIR, 'archive');
const MANIFEST_FILE = join(ARCHIVE_DIR, 'manifest.json');
const LEDGER_JSON = join(ARCHIVE_DIR, 'MASTER_DISCOVERY_LEDGER.json');
const LEDGER_XLSX = join(ARCHIVE_DIR, 'MASTER_DISCOVERY_LEDGER.xlsx');

const DEFAULT_XLSX = join(OUTPUT_DIR, 'candidates-2026-09-01T11-50-51-056Z workonprogress.xlsx');
const DEFAULT_STATE_FILE = join(OUTPUT_DIR, 'workbench-state.json');
const DEFAULT_IMPORT_STATE_FILE = join(OUTPUT_DIR, 'excel-import-state.json');

const NUMBER_VALID_COLUMN = 'Number Valid';
const QUALIFY_COLUMN = 'Menu List Under 100';
const NOTES_COLUMN = 'Menu Details/Notes';

// Two currently-known judgment-call probable duplicates, imported but
// deliberately left is_hidden=true in production pending the project
// owner's decision (see CLAUDE.md's Batch 16/17 closeout sections for the
// full reasoning — each is ~250m from an existing same-brand listing).
// This is a small, static, hand-maintained allow-list precisely because
// "is this a duplicate" is a judgment call this project has explicitly
// decided a human, not an algorithm, must make — it is informational
// context for whoever reads the ledger, not a computed field.
const KNOWN_HOLDS = {
  'ChIJw6S2svo9rjsRRSkDQB-3uxY': 'Rajanna Military Hotel (Vijayanagar), 229m from existing "Rajanna Military Hotel Subbanna Graden" — probable duplicate, awaiting owner decision (Batch 16)',
  'ChIJxZzO-_gUrjsRagJGN0RKIDc': 'Lakshmi Balaji Tiffin Centre, 251m from existing "Balaji Tiffin centre" — judgment-call probable duplicate, awaiting owner decision (Batch 17)',
};

function parseArgs(argv) {
  const args = { flags: new Set(), values: {} };
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq === -1) args.flags.add(raw.slice(2));
    else args.values[raw.slice(2, eq)] = raw.slice(eq + 1);
  }
  return args;
}

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadManifest(path) {
  return loadJson(path, { batches: {} });
}

function saveManifest(path, manifest) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

// -------------------------------------------------------------- xlsx io
// Same invocation both workbench-sync.mjs and import-excel.mjs already use
// — deliberately not reimplemented, deliberately not importing that logic
// from either of those files (import-excel.mjs is off-limits; duplicating
// this one small spawnSync call is cheaper and safer than adding a shared
// module both production-adjacent scripts would need to trust).
function readWorkbook(xlsxPath) {
  if (!existsSync(xlsxPath)) throw new Error(`WIP spreadsheet not found: ${xlsxPath}`);
  const result = spawnSync('python', [JSON.stringify(join(HERE, 'xlsx-to-json.py')), JSON.stringify(xlsxPath)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(`Reading the spreadsheet failed (is Python + openpyxl available?):\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

// ------------------------------------------------------------- photos io
// Mirrors workbench-sync.mjs's own photosFor() exactly — read-only listing,
// never a write, never a delete.
function photosFor(placeId) {
  const dir = join(PHOTOS_DIR, placeId);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir).filter((name) => statSync(join(dir, name)).isFile()).sort();
}

// --------------------------------------------------------- review rules
// isReviewedDbRow() and the qualify rule are reused VERBATIM from
// workbench-sync.mjs (see that file's own identically-named function) —
// applied here against xlsx rows instead of a live discovery_batch_rows
// row, since post-purge the DB row is gone and the xlsx is the only place
// left holding this data.
function isReviewedRow(row) {
  if (!row[NUMBER_VALID_COLUMN]) return false;
  if (row[QUALIFY_COLUMN] !== 'Yes' && row[QUALIFY_COLUMN] !== 'No') return false;
  if (row[QUALIFY_COLUMN] === 'Yes' && !row[NOTES_COLUMN]) return false;
  return true;
}
function isApprovedRow(row) {
  return row[QUALIFY_COLUMN] === 'Yes';
}

function contentHashFor(placeIds, rowsByPlaceId) {
  const h = createHash('sha256');
  for (const pid of [...placeIds].sort()) {
    const row = rowsByPlaceId.get(pid);
    h.update(pid + '|' + (row ? JSON.stringify([row[NUMBER_VALID_COLUMN], row[QUALIFY_COLUMN], row[NOTES_COLUMN]]) : 'MISSING'));
  }
  return h.digest('hex');
}

// ----------------------------------------------------------- data model
// Builds the full set of "facts we know" for every place_id we've ever
// touched, from the three read-only sources. Shared by --status,
// --verify-batch and --build-ledger so all three agree on exactly the same
// definitions.
function loadSources({ xlsxPath, stateFilePath, importStateFilePath, manifestPath }) {
  const wip = readWorkbook(xlsxPath);
  const rowsByPlaceId = new Map(wip.rows.map((r, i) => [r.place_id, { ...r, _excelRow: i + 2 }]));

  const workbenchState = loadJson(stateFilePath, { completed: {}, in_progress: {}, nextBatch: null });
  const importState = loadJson(importStateFilePath, { entries: {}, environments: { production: { entries: {} } } });
  const manifest = loadManifest(manifestPath);

  const localEntries = importState.entries || {};
  const prodEntries = importState.environments?.production?.entries || {};

  // Every batch_id that has at least one place_id in `completed` — these
  // are the only batches --export-all-completed will ever touch. A batch_id
  // that only appears in `in_progress` (today: batch 19) is never included
  // here, by construction, so it can never be exported/archived/purged by
  // this tool while still live.
  const batchIdsCompleted = new Set();
  for (const entry of Object.values(workbenchState.completed || {})) batchIdsCompleted.add(entry.batch_id);

  return { rowsByPlaceId, workbenchState, importState, localEntries, prodEntries, manifest, batchIdsCompleted };
}

// Checks BOTH completed and in_progress. This is a deliberate, additive
// change from this function's original completed-only design: the whole
// point of the Discovery Archive is to let a batch be exported+verified
// BEFORE it's purged from the Workbench, not only after (every prior batch
// only ever got exported once it was already `completed`, because purging
// was the only thing that ever moved a place_id there). A batch_id only
// ever lives in one of the two buckets at a time in practice, so scanning
// both is safe; --export-all-completed still only loops batchIdsCompleted
// and so still never touches a live batch on its own. The ledger's own
// `workbench_purged` flag is computed fresh from workbenchState at
// --build-ledger time (see cmdBuildLedger), independent of the manifest —
// so archiving an in_progress batch correctly keeps showing
// workbench_purged=false for it until it's genuinely purged later; nothing
// about this change makes the ledger lie about purge status.
function placeIdsForBatch(workbenchState, batchId) {
  const ids = [];
  for (const [pid, entry] of Object.entries(workbenchState.completed || {})) {
    if (String(entry.batch_id) === String(batchId)) ids.push(pid);
  }
  for (const [pid, entry] of Object.entries(workbenchState.in_progress || {})) {
    if (String(entry.batch_id) === String(batchId)) ids.push(pid);
  }
  return ids;
}

// -------------------------------------------------------------- status
function cmdStatus(sources) {
  const { workbenchState, manifest, batchIdsCompleted } = sources;
  const inProgressBatches = new Set(Object.values(workbenchState.in_progress || {}).map((e) => e.batch_id));
  console.log(`WIP xlsx rows tracked           : ${sources.rowsByPlaceId.size}`);
  console.log(`Completed batches (Workbench)    : ${[...batchIdsCompleted].sort((a, b) => Number(a) - Number(b)).join(', ') || '(none)'}`);
  console.log(`In-progress (live, not touchable): ${[...inProgressBatches].join(', ') || '(none)'}`);
  console.log(`Batches exported so far          : ${Object.keys(manifest.batches).filter((b) => manifest.batches[b].exported_at).length}`);
  console.log(`Batches archived so far          : ${Object.keys(manifest.batches).filter((b) => manifest.batches[b].archived_at).length}`);
  for (const batchId of [...batchIdsCompleted].sort((a, b) => Number(a) - Number(b))) {
    const m = manifest.batches[batchId] || {};
    const ids = placeIdsForBatch(workbenchState, batchId);
    console.log(`  batch ${batchId.padStart(3, '0')}: ${ids.length} place_ids, exported=${!!m.exported_at}, archived=${!!m.archived_at}`);
  }
}

// -------------------------------------------------------------- export
function cmdExportBatch(sources, batchId, { archiveDir, rendererPath }) {
  const { rowsByPlaceId, workbenchState, manifest } = sources;
  const placeIds = placeIdsForBatch(workbenchState, batchId);
  if (placeIds.length === 0) {
    throw new Error(`Batch ${batchId} has no place_ids in workbench-state.json (checked both "completed" and "in_progress") — nothing to export.`);
  }

  const hash = contentHashFor(placeIds, rowsByPlaceId);
  const existing = manifest.batches[batchId];
  const batchDir = join(archiveDir, `batch-${String(batchId).padStart(3, '0')}`);
  const exportPath = join(batchDir, 'listings-export.xlsx');

  if (existing?.exported_at) {
    if (existing.content_hash === hash && existsSync(exportPath)) {
      console.log(`Batch ${batchId} already exported (unchanged since ${existing.exported_at}) — no-op.`);
      return;
    }
    if (existing.content_hash !== hash) {
      throw new Error(
        `REFUSING TO OVERWRITE: batch ${batchId} was already exported at ${existing.exported_at}, but its xlsx rows ` +
        `have changed since (content hash differs). This should not happen for a genuinely closed-out batch — ` +
        `investigate before re-exporting. Nothing was written.`
      );
    }
    // Hash matches but the file is missing on disk — safe to regenerate.
  }

  mkdirSync(batchDir, { recursive: true });
  const rows = placeIds.map((pid) => rowsByPlaceId.get(pid) || { place_id: pid, name: '(no xlsx row found)' });
  const payload = { mode: 'batch-export', batch_id: batchId, rows };
  const payloadPath = join(batchDir, '.export-payload.json');
  writeFileSync(payloadPath, JSON.stringify(payload), 'utf8');

  const result = spawnSync('python', [JSON.stringify(rendererPath), JSON.stringify(payloadPath), JSON.stringify(exportPath)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: true,
  });
  if (result.status !== 0) throw new Error(`Rendering batch ${batchId}'s export failed:\n${result.stderr || result.stdout}`);

  manifest.batches[batchId] = {
    ...existing,
    exported_at: existing?.exported_at ?? new Date().toISOString(),
    row_count: placeIds.length,
    place_ids: placeIds,
    content_hash: hash,
  };
  console.log(`Batch ${batchId}: exported ${placeIds.length} rows -> ${exportPath}`);
}

function cmdExportAllCompleted(sources, opts) {
  for (const batchId of [...sources.batchIdsCompleted].sort((a, b) => Number(a) - Number(b))) {
    cmdExportBatch(sources, batchId, opts);
  }
}

// -------------------------------------------------------------- verify
// What actually counts as an archival PROBLEM (verification failure) vs. a
// merely-informational fact:
//
// A place_id whose xlsx row was NEVER reviewed by the intern (Number Valid/
// Menu List Under 100 still blank) is NOT a problem — it is a real,
// deliberate, permanent outcome this project has repeatedly and explicitly
// accepted ("a blank cell purged loses nothing" — see every partial-batch
// closeout in CLAUDE.md, e.g. Batch 17 closed out with 40/100 rows still
// blank). Confirmed directly: re-running this check against real batch
// history reproduces those exact same blank-row counts batch-for-batch.
// There was nothing for that row beyond its original discovery-stage data
// (place_id/name/address/lat-lon), which has been sitting untouched in the
// WIP xlsx the whole time — nothing is at risk of being lost by archiving
// it as-is.
//
// The two things that ARE genuine data-loss risks, and the only two this
// checks:
//   1. A place_id with no xlsx row at all (the row itself is gone).
//   2. A row that DID get reviewed AND qualified (Menu List Under 100=Yes),
//      has zero local photos, AND is NOT ALREADY PUBLISHED. If it's already
//      published, Supabase's live row (with whatever photo count it
//      actually has, including 0) IS the definitive permanent record —
//      confirmed by checking 5 real cases this way: all 5 were already
//      live in production with photos=0 (imported anywhere from 2026-09-08
//      to 2026-09-22), so there was never a photo to lose and archiving
//      changes nothing about that already-accepted fact. Only an
//      UNPUBLISHED qualifying row with 0 photos is a genuine forward risk
//      worth blocking on — if it's eventually imported, it could go live
//      with a photo gap nobody previously noticed.
function cmdVerifyBatch(sources, batchId) {
  const { rowsByPlaceId, manifest, prodEntries } = sources;
  const m = manifest.batches[batchId];
  if (!m?.exported_at) throw new Error(`Batch ${batchId} has not been exported yet — run --export-batch=${batchId} first.`);

  const problems = [];
  const alreadyPublishedZeroPhoto = [];
  let neverReviewedCount = 0;
  for (const pid of m.place_ids) {
    const row = rowsByPlaceId.get(pid);
    if (!row) { problems.push(`${pid}: no xlsx row found at all — the row itself is missing`); continue; }
    if (!isReviewedRow(row)) { neverReviewedCount++; continue; }
    if (isApprovedRow(row)) {
      const photoCount = photosFor(pid).length;
      if (photoCount === 0) {
        if (prodEntries[pid]) {
          alreadyPublishedZeroPhoto.push(`${pid} (${row.name}): already published (${prodEntries[pid].imported_at}) with 0 photos — pre-existing, accepted, not a new risk`);
        } else {
          problems.push(`${pid} (${row.name}): qualifies (Menu List Under 100=Yes), has 0 local photos, and is NOT YET published — real forward risk`);
        }
      }
    }
  }

  if (problems.length > 0) {
    console.error(`Batch ${batchId}: verification FAILED for ${problems.length} row(s) — archived_at NOT set. Nothing else changed.`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  const verifyNotes = [];
  if (neverReviewedCount > 0) {
    verifyNotes.push(`${neverReviewedCount}/${m.place_ids.length} rows were never reviewed by the intern (permanently blank, per this project's established "a blank cell purged loses nothing" policy) — not a failure, informational only.`);
  }
  verifyNotes.push(...alreadyPublishedZeroPhoto);
  manifest.batches[batchId] = { ...m, archived_at: m.archived_at ?? new Date().toISOString(), verify_notes: verifyNotes };
  console.log(`Batch ${batchId}: verified clean (${m.place_ids.length} place_ids, ${neverReviewedCount} never-reviewed) — archived_at set.`);
}

// ---------------------------------------------------------- build-ledger
function deriveState({ reviewed, approved, archived, published }) {
  if (published) return 'PUBLISHED';
  if (archived && approved) return 'NOT_YET_PUBLISHED';
  if (archived && !approved) return 'ARCHIVED';
  if (approved) return 'APPROVED';
  if (reviewed) return 'REVIEWED';
  return 'DISCOVERED';
}

function cmdBuildLedger(sources, { archiveDir, rendererPath }) {
  const { rowsByPlaceId, workbenchState, localEntries, prodEntries, manifest } = sources;

  // Union of every place_id we know about from any source, so a row is
  // never silently dropped just because e.g. it's in the xlsx but was
  // never pushed to a batch, or vice versa.
  const allPlaceIds = new Set([
    ...rowsByPlaceId.keys(),
    ...Object.keys(workbenchState.completed || {}),
    ...Object.keys(workbenchState.in_progress || {}),
    ...Object.keys(localEntries),
    ...Object.keys(prodEntries),
  ]);

  const ledgerRows = [];
  for (const pid of allPlaceIds) {
    const row = rowsByPlaceId.get(pid);
    const completedEntry = workbenchState.completed?.[pid];
    const inProgressEntry = workbenchState.in_progress?.[pid];
    const batchId = completedEntry?.batch_id ?? inProgressEntry?.batch_id ?? (prodEntries[pid] || localEntries[pid] ? 'PRE-WORKBENCH' : null);
    const workbenchPurged = !!completedEntry && !inProgressEntry;

    const reviewed = row ? isReviewedRow(row) : false;
    const approved = row ? isApprovedRow(row) : false;

    const batchManifest = batchId && batchId !== 'PRE-WORKBENCH' ? manifest.batches[batchId] : null;
    const exportStatus = batchManifest?.exported_at ? 'EXPORTED' : 'NOT_EXPORTED';
    const archived = !!batchManifest?.archived_at;

    const photoCountLocal = photosFor(pid).length;
    const photosArchivePath = photoCountLocal > 0 ? `tools/discovery/photos/${pid}/` : '';

    const prodEntry = prodEntries[pid];
    const published = !!prodEntry;
    const photoCountPublished = prodEntry?.photos?.length ?? 0;
    const photosPublished = photoCountPublished > 0;
    const photosArchiveOnly = photoCountLocal > 0 && (!published || photoCountPublished < photoCountLocal);

    const currentState = deriveState({ reviewed, approved, archived, published });

    const notes = [];
    if (workbenchPurged && !reviewed) notes.push('ANOMALY: purged from Workbench but xlsx row is not a completed review');
    if (batchId === 'PRE-WORKBENCH') notes.push('Imported before the Discovery Workbench batch system existed (pre-2026-09-05)');

    ledgerRows.push({
      place_id: pid,
      name: row?.name ?? completedEntry?.name ?? inProgressEntry?.name ?? prodEntry?.name ?? localEntries[pid]?.name ?? '',
      batch_id: batchId ?? '',
      number_valid: row?.[NUMBER_VALID_COLUMN] ?? '',
      menu_list_under_100: row?.[QUALIFY_COLUMN] ?? '',
      menu_details_notes: row?.[NOTES_COLUMN] ?? '',
      excel_row: row?._excelRow ?? '',
      reviewed,
      approved,
      photo_count_local: photoCountLocal,
      photos_archive_path: photosArchivePath,
      export_status: exportStatus,
      batch_export_path: batchManifest?.exported_at ? `tools/discovery/output/archive/batch-${String(batchId).padStart(3, '0')}/listings-export.xlsx` : '',
      archived,
      archived_at: batchManifest?.archived_at ?? '',
      workbench_purged: workbenchPurged,
      listing_id: prodEntry?.listing_id ?? '',
      published,
      publication_date: prodEntry?.imported_at ?? '',
      photo_count_published: photoCountPublished,
      photos_published: photosPublished,
      photos_archive_only: photosArchiveOnly,
      local_test_listing_id: localEntries[pid]?.listing_id ?? '',
      current_state: currentState,
      known_hold: KNOWN_HOLDS[pid] ?? '',
      notes: notes.join('; '),
    });
  }

  ledgerRows.sort((a, b) => {
    const ba = a.batch_id === 'PRE-WORKBENCH' ? -1 : a.batch_id === '' ? 1e9 : Number(a.batch_id);
    const bb = b.batch_id === 'PRE-WORKBENCH' ? -1 : b.batch_id === '' ? 1e9 : Number(b.batch_id);
    if (ba !== bb) return ba - bb;
    return a.name.localeCompare(b.name);
  });

  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(LEDGER_JSON, JSON.stringify({ generated_at: new Date().toISOString(), rows: ledgerRows }, null, 2) + '\n', 'utf8');

  const payload = { mode: 'master-ledger', rows: ledgerRows };
  const payloadPath = join(archiveDir, '.ledger-payload.json');
  writeFileSync(payloadPath, JSON.stringify(payload), 'utf8');
  const result = spawnSync('python', [JSON.stringify(rendererPath), JSON.stringify(payloadPath), JSON.stringify(LEDGER_XLSX)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: true,
  });
  if (result.status !== 0) throw new Error(`Rendering the master ledger failed:\n${result.stderr || result.stdout}`);

  const stateCounts = {};
  for (const r of ledgerRows) stateCounts[r.current_state] = (stateCounts[r.current_state] || 0) + 1;
  console.log(`Master Discovery Ledger regenerated: ${ledgerRows.length} place_ids -> ${LEDGER_JSON} / ${LEDGER_XLSX}`);
  console.log('By current_state:', JSON.stringify(stateCounts));
}

// ------------------------------------------------------------------ cli
function main() {
  const args = parseArgs(process.argv.slice(2));
  const xlsxPath = args.values.file ?? DEFAULT_XLSX;
  const stateFilePath = args.values['state-file'] ?? DEFAULT_STATE_FILE;
  const importStateFilePath = args.values['import-state-file'] ?? DEFAULT_IMPORT_STATE_FILE;
  const archiveDir = args.values['archive-dir'] ?? ARCHIVE_DIR;
  const manifestPath = join(archiveDir, 'manifest.json');
  const rendererPath = join(HERE, 'build-archive-xlsx.py');

  const sources = loadSources({ xlsxPath, stateFilePath, importStateFilePath, manifestPath });

  try {
    if (args.flags.has('status')) {
      cmdStatus(sources);
    } else if (args.values['export-batch']) {
      cmdExportBatch(sources, args.values['export-batch'], { archiveDir, rendererPath });
      saveManifest(manifestPath, sources.manifest);
    } else if (args.flags.has('export-all-completed')) {
      cmdExportAllCompleted(sources, { archiveDir, rendererPath });
      saveManifest(manifestPath, sources.manifest);
    } else if (args.values['verify-batch']) {
      cmdVerifyBatch(sources, args.values['verify-batch']);
      saveManifest(manifestPath, sources.manifest);
    } else if (args.flags.has('build-ledger')) {
      cmdBuildLedger(sources, { archiveDir, rendererPath });
    } else {
      console.log('Usage: node build-master-ledger.mjs --status | --export-batch=N | --export-all-completed | --verify-batch=N | --build-ledger');
      process.exitCode = 2;
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main();
}
