// Beggars Map — local-only import (Phase 1.7). NEVER run automatically;
// this is the one script in this pipeline that writes to a database, and
// it is hard-gated to the LOCAL Supabase Docker stack only:
//   - discovers the local DB container the same way scripts/restore-local-db.mjs
//     does (by the `com.supabase.cli.project` Docker label), and refuses to
//     run if it isn't found — no fallback, no guessing, no --linked/--project-ref
//     code path exists anywhere in this file.
//   - every read/write goes through `supabase db query --local`, which only
//     ever talks to that local container.
//
// Input: tools/discovery/output/verified-candidates.json's `approved[]`
// array (written by verify-queue.mjs), or the older flat
// approved-candidates.json format for backward compatibility. Either way,
// every entry is re-validated here from scratch — this script does not
// trust an upstream file's self-reported status without checking it.
//
// Schema mapping (based on supabase/migrations/0001, 0004, 0010, 0011 and
// web/mobile's own listing-insert code — no migration, no new column,
// added by this phase; see the chat report for the full inspection):
//   name             -> listings.name
//   price_rupees     -> listings.price_rupees
//   qualifying_item  -> folded into listings.note (schema has no separate
//                       "qualifying item" column, and none is invented —
//                       see the mapping doc)
//   latitude/longitude -> listings.latitude/longitude
//   -                -> listings.location_label left NULL (Google's raw
//                       formatted_address is a different format than the
//                       "Street, Area" convention 0010 established, and
//                       nothing in this pipeline resolves that format
//                       locally — reported as a gap, not silently guessed)
//   -                -> listings.photo_url left NULL (no photo in this
//                       pipeline; Google Places photos were never fetched)
//   created_by       -> fixed seed profile id from 0003_seed_demo_listings.sql
//   place_id, evidence_source_url, match_confidence, qualifying_item,
//   offering_type, verified_at -> NOT stored in the listings row (no schema
//                       column exists for any of them, and none is
//                       invented) — kept instead in a local-only
//                       import-manifest-*.json file, same pattern already
//                       used for place_id dedup.
//
// Product policy (2026-09-01): "qualifying_item" must describe a complete
// meal/breakfast/thali/combo, not a single cheap item — enforced via
// classifyOffering() in matching.mjs (offering_type must be one of
// BREAKFAST/MEAL/THALI/COMBO, and the description must itself read as
// multi-component). A record whose only evidence is e.g. "Vada ₹10" is
// rejected here even if every other field is otherwise valid.
//
// Usage:
//   node tools/discovery/import-approved.mjs                (dry run — same as --dry-run)
//   node tools/discovery/import-approved.mjs --dry-run
//   node tools/discovery/import-approved.mjs --yes           (actually inserts, after a dry run looks right)
//   node tools/discovery/import-approved.mjs --file=path.json --yes

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { duplicateRisk, classifyOffering } from './matching.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const OUTPUT_DIR = join(HERE, 'output');
const VERIFIED_INPUT = join(OUTPUT_DIR, 'verified-candidates.json');
const LEGACY_INPUT = join(OUTPUT_DIR, 'approved-candidates.json');

// Fixed seed profile id from supabase/migrations/0003_seed_demo_listings.sql
// — already present (auth.users + profiles) on any local stack that has
// run migrations, same owner the existing demo seed listings use.
const SEED_USER_ID = '00000000-0000-0000-0000-000000000001';

function assertRepoRoot() {
  if (!existsSync(join(REPO_ROOT, 'supabase', 'config.toml'))) {
    throw new Error(`Run this from the repo (expected supabase/config.toml under ${REPO_ROOT}).`);
  }
}

function readProjectId() {
  const configPath = join(REPO_ROOT, 'supabase', 'config.toml');
  const content = readFileSync(configPath, 'utf8');
  const match = content.match(/^project_id\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error(`Could not find project_id in ${configPath}.`);
  return match[1];
}

// Same discovery mechanism as scripts/restore-local-db.mjs — refuses to
// guess, refuses to fall back to anything but a container matching this
// project's own local-stack label.
function findLocalDbContainer(projectId) {
  const result = spawnSync(
    'docker',
    ['ps', '--filter', `label=com.supabase.cli.project=${projectId}`, '--filter', 'name=supabase_db_', '--format', '{{.Names}}'],
    { encoding: 'utf8', shell: true }
  );
  if (result.status !== 0) {
    throw new Error(
      `"docker ps" failed (${result.stderr || result.stdout}). Is Docker Desktop running? ` +
        `STOPPING — refusing to assume any database target.`
    );
  }
  const names = result.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) {
    throw new Error(
      `No running local Supabase DB container found for project "${projectId}". ` +
        `Run "npx supabase start" first. STOPPING — will not fall back to production.`
    );
  }
  if (names.length > 1) {
    throw new Error(`Found multiple matching containers (${names.join(', ')}) — refusing to guess which one.`);
  }
  return names[0];
}

function sqlString(value) {
  if (value === null || value === undefined) return 'null';
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Reads existing listings for duplicate detection. --local only, read-only
// (no WHERE, no LIMIT that could hide a real duplicate).
//
// Confirmed live output shape (2026-09-01, against a real local stack):
// stdout starts with a plain "Connecting to local database..." line, then
// a JSON object `{ boundary, rows: [...], warning }` — NOT a bare array.
// The `warning` field itself says the row DATA (inside `rows`) is
// untrusted database content, not instructions — noted, and irrelevant
// here since this function only ever reads structural fields (id, name,
// latitude, longitude) to feed the numeric/string duplicate-distance
// check in matching.mjs, never treats any of it as instructions to
// execute. If this shape ever changes, fail loudly rather than guess.
function fetchExistingListings() {
  const sql = 'select id, name, latitude, longitude from listings;';
  const result = spawnSync('npx', ['supabase', 'db', 'query', '--local', JSON.stringify(sql)], { encoding: 'utf8', shell: true });
  if (result.status !== 0) {
    throw new Error(`Could not read existing listings for duplicate-check: ${result.stderr || result.stdout}`);
  }
  const out = result.stdout.trim();
  const jsonStart = out.search(/[{[]/);
  if (jsonStart === -1) {
    throw new Error(`"supabase db query --local" produced no JSON — refusing to import blind to duplicates. Raw output:\n${out.slice(0, 1000)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(out.slice(jsonStart));
  } catch (err) {
    throw new Error(`Could not parse "supabase db query --local" output as JSON (${err.message}) — refusing to import blind to duplicates. Raw output:\n${out.slice(0, 1000)}`);
  }
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rows) ? parsed.rows : null;
  if (!rows) {
    throw new Error(`"supabase db query --local" output had no array or "rows" array — refusing to import blind to duplicates. Raw output:\n${out.slice(0, 1000)}`);
  }
  for (const row of rows) {
    if (typeof row.name !== 'string' || typeof row.latitude !== 'number' || typeof row.longitude !== 'number') {
      throw new Error(`An existing listing row is missing name/latitude/longitude — refusing to import blind to duplicates. Row: ${JSON.stringify(row)}`);
    }
  }
  return rows;
}

function resolveDefaultInput() {
  if (existsSync(VERIFIED_INPUT)) return VERIFIED_INPUT;
  if (existsSync(LEGACY_INPUT)) return LEGACY_INPUT;
  return VERIFIED_INPUT; // report against this path if neither exists
}

function loadInput(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (Array.isArray(raw)) return { candidates: raw, decisions: null };
  if (Array.isArray(raw.approved)) return { candidates: raw.approved, decisions: raw.decisions ?? null };
  if (Array.isArray(raw.candidates)) return { candidates: raw.candidates, decisions: null };
  throw new Error(`${path} must be an array, or an object with an "approved" or "candidates" array.`);
}

function matchConfidenceOf(c) {
  return c.verification?.match_confidence ?? c.match_confidence ?? null;
}

// Full re-validation — never trusts an upstream file's self-reported
// status without checking every field this pipeline actually cares about.
function validateCandidate(c, index, decisions) {
  const errors = [];
  const where = `[${index}] (${c?.name ?? c?.place_id ?? 'unknown'})`;

  if (!c.place_id) errors.push('missing place_id');
  if (!c.name || typeof c.name !== 'string' || !c.name.trim()) errors.push('missing name');
  if (c.name && c.name.length > 120) errors.push('name exceeds 120 chars (listings_name_length_check)');
  if (typeof c.latitude !== 'number' || c.latitude < -90 || c.latitude > 90) errors.push('latitude missing/out of range');
  if (typeof c.longitude !== 'number' || c.longitude < -180 || c.longitude > 180) errors.push('longitude missing/out of range');
  if (!Number.isInteger(c.price_rupees) || c.price_rupees <= 0 || c.price_rupees > 100) {
    errors.push('price_rupees must be an integer in 1..100 (₹100 cap)');
  }
  if (!c.qualifying_item || typeof c.qualifying_item !== 'string' || !c.qualifying_item.trim()) {
    errors.push('missing qualifying_item — a price without a specific item is not acceptable evidence');
  }
  // Product policy (2026-09-01): a single cheap item (Vada ₹10, one roti,
  // tea, coffee, ...) is never sufficient — this pipeline imports complete
  // affordable meals/breakfasts/thalis/combos ≤₹100, not any-cheap-item
  // restaurants. classifyOffering is the single source of truth; re-checked
  // here even though verify-queue.mjs already gates this, since this
  // script must never trust an upstream file blindly.
  const offering = classifyOffering({ description: c.qualifying_item, offeringType: c.offering_type });
  if (!offering.qualifies) {
    errors.push(`does not qualify as a complete meal: ${offering.reason}`);
  }
  if (c.verification_status !== 'verified') {
    errors.push(`verification_status must be "verified" (got ${JSON.stringify(c.verification_status ?? null)})`);
  }
  if (!c.price_evidence_source || typeof c.price_evidence_source !== 'string' || !c.price_evidence_source.trim()) {
    errors.push('missing price_evidence_source — never import a price without stating where it came from');
  }
  const confidence = matchConfidenceOf(c);
  if (!confidence || confidence === 'low') {
    errors.push(`match confidence must be present and not "low" (got ${JSON.stringify(confidence)}) — refusing an unmatched branch`);
  }

  // Defense in depth: if a full decisions[] log is available (the
  // verify-queue.mjs output shape), cross-check that this exact place_id
  // really went through the HUMAN_VERIFIED_LE_100 action there too, rather than
  // trusting the trimmed approved[] record's self-reported fields alone —
  // guards against a hand-edited or otherwise-produced approved[] entry.
  if (decisions) {
    const decision = decisions.find((d) => d.place_id === c.place_id);
    if (!decision) errors.push('no matching entry in decisions[] log — cannot confirm this went through the approval flow');
    else if (decision.action !== 'HUMAN_VERIFIED_LE_100') errors.push(`decisions[] log shows action "${decision.action}", not HUMAN_VERIFIED_LE_100`);
  }

  return errors.length ? { ok: false, name: c.name, place_id: c.place_id, errors } : { ok: true, name: c.name, place_id: c.place_id };
}

function loadPreviouslyImportedPlaceIds() {
  const imported = new Set();
  if (!existsSync(OUTPUT_DIR)) return imported;
  for (const file of readdirSync(OUTPUT_DIR)) {
    if (!file.startsWith('import-manifest-') || !file.endsWith('.json')) continue;
    try {
      const manifest = JSON.parse(readFileSync(join(OUTPUT_DIR, file), 'utf8'));
      for (const entry of manifest.imported ?? []) imported.add(entry.place_id);
    } catch {
      // ignore unreadable/partial manifest files
    }
  }
  return imported;
}

function buildNote(c) {
  const parts = [];
  if (c.qualifying_item) parts.push(`${c.qualifying_item} — ₹${c.price_rupees}`);
  if (c.note) parts.push(c.note);
  return parts.length ? parts.join('. ') : null;
}

function parseArgs(argv) {
  const args = { yes: false, file: null };
  for (const arg of argv) {
    if (arg === '--yes') args.yes = true;
    else if (arg === '--dry-run') args.yes = false; // explicit, same as the default
    else if (arg.startsWith('--file=')) args.file = arg.split('=').slice(1).join('=');
  }
  return args;
}

function main() {
  assertRepoRoot();
  const args = parseArgs(process.argv.slice(2));
  const inputPath = args.file || resolveDefaultInput();

  const projectId = readProjectId();
  let containerName;
  try {
    containerName = findLocalDbContainer(projectId);
  } catch (err) {
    console.error(`[import] ${err.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[import] TARGET DATABASE: LOCAL SUPABASE ✓ (project "${projectId}", Docker container "${containerName}")`);
  console.log(`[import] Mode: ${args.yes ? 'LIVE IMPORT (--yes)' : 'DRY RUN (default — no rows will be written)'}`);

  if (!existsSync(inputPath)) {
    console.error(
      `[import] No input file at ${inputPath}.\n` +
        `  Run verify-queue.mjs first (writes tools/discovery/output/verified-candidates.json),\n` +
        `  or pass --file=path.json.`
    );
    process.exitCode = 1;
    return;
  }
  console.log(`[import] Input: ${inputPath}`);

  const { candidates, decisions } = loadInput(inputPath);
  if (candidates.length === 0) {
    console.log('[import] Input file has 0 approved candidates. Nothing to do.');
    return;
  }

  const validations = candidates.map((c, i) => validateCandidate(c, i, decisions));
  const validated = validations.filter((v) => v.ok);
  const rejected = validations.filter((v) => !v.ok);

  console.log(`\n[import] Validation: ${validated.length} eligible, ${rejected.length} rejected (of ${candidates.length} total).`);
  for (const r of rejected) console.log(`  REJECTED "${r.name}" (${r.place_id}): ${r.errors.join('; ')}`);

  const alreadyImportedByUs = loadPreviouslyImportedPlaceIds();
  const notYetImported = validated.filter((v) => !alreadyImportedByUs.has(v.place_id));
  const skippedAsReimport = validated.length - notYetImported.length;
  if (skippedAsReimport > 0) {
    console.log(`[import] ${skippedAsReimport} eligible candidate(s) already imported previously (per import-manifest-*.json) — skipping re-import.`);
  }

  // Duplicate check against what's ALREADY in the local listings table —
  // not just our own prior imports. Requires a live read of the local DB.
  let existingListings;
  try {
    existingListings = fetchExistingListings();
  } catch (err) {
    console.error(`\n[import] ${err.message}`);
    console.error('[import] STOPPING — cannot safely check for duplicates without reading the existing local listings.');
    process.exitCode = 1;
    return;
  }
  console.log(`[import] Existing local listings checked for duplicates: ${existingListings.length}`);

  const byId = new Map(candidates.map((c) => [c.place_id, c]));
  const clean = [];
  const duplicateFlagged = [];
  for (const v of notYetImported) {
    const candidate = byId.get(v.place_id);
    let worstFlag = null;
    for (const existing of existingListings) {
      const risk = duplicateRisk(candidate, existing);
      if (risk.flagged && (!worstFlag || risk.distanceKm < worstFlag.risk.distanceKm)) {
        worstFlag = { existing, risk };
      }
    }
    if (worstFlag) {
      duplicateFlagged.push({ candidate, ...worstFlag });
    } else {
      clean.push(candidate);
    }
  }

  if (duplicateFlagged.length > 0) {
    console.log(`\n[import] ${duplicateFlagged.length} candidate(s) flagged as possible duplicates — STOPPED, not imported:`);
    for (const d of duplicateFlagged) {
      console.log(
        `  "${d.candidate.name}" (${d.candidate.place_id}) vs existing listing "${d.existing.name}" (${d.existing.id}): ` +
          `${d.risk.distanceKm.toFixed(3)}km apart, name overlap ${(d.risk.nameOverlapRatio * 100).toFixed(0)}%`
      );
    }
  }

  console.log(`\n[import] Final: ${clean.length} candidate(s) clear to import.`);
  for (const c of clean) {
    const isHidden = c.publish === true ? 'false' : 'true'; // default hidden until a human explicitly publishes it
    const note = buildNote(c);
    const sql =
      `insert into listings (created_by, name, note, price_rupees, latitude, longitude, city, location_label, is_hidden) ` +
      `values (${sqlString(SEED_USER_ID)}, ${sqlString(c.name)}, ${sqlString(note)}, ${c.price_rupees}, ` +
      `${c.latitude}, ${c.longitude}, ${sqlString('Bengaluru')}, null, ${isHidden}) returning id;`;

    if (!args.yes) {
      console.log(`\n[import] WOULD INSERT "${c.name}":`);
      console.log(`  ${sql}`);
      continue;
    }

    const result = spawnSync('npx', ['supabase', 'db', 'query', '--local', JSON.stringify(sql)], { encoding: 'utf8', shell: true });
    if (result.status !== 0) {
      console.error(`[import] FAILED for "${c.name}" (${c.place_id}): ${result.stderr || result.stdout}`);
      continue;
    }
    const idMatch = result.stdout.match(/"id"\s*:\s*"([0-9a-f-]{36})"/i);
    const listingId = idMatch ? idMatch[1] : null;
    console.log(`[import] Inserted "${c.name}" -> listing id ${listingId ?? '(unknown — check output)'}`);
    c.__insertedListingId = listingId;
  }

  if (!args.yes) {
    console.log(`\n[import] === DRY RUN COMPLETE — 0 rows written. Re-run with --yes to actually insert into LOCAL Supabase. ===`);
    return;
  }

  const results = clean.filter((c) => c.__insertedListingId).map((c) => ({ place_id: c.place_id, name: c.name, listing_id: c.__insertedListingId, imported_at: new Date().toISOString() }));
  if (results.length > 0) {
    const manifestPath = join(OUTPUT_DIR, `import-manifest-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(manifestPath, JSON.stringify({ imported: results }, null, 2), 'utf8');
    console.log(`[import] Wrote manifest: ${manifestPath}`);
  }
  console.log(`[import] Done. ${results.length}/${clean.length} inserted into LOCAL Supabase only. Production: untouched.`);
}

try {
  main();
} catch (err) {
  console.error(`[import] ${err.message ?? err}`);
  process.exitCode = 1;
}
