// Bulk-imports human-reviewed restaurants from the working Excel sheet into
// the LOCAL Supabase stack, with their photos.
//
// This is a sibling of import-approved.mjs, not a replacement: that one
// imports from verify-queue.mjs's JSON and has no photo handling at all.
// This one's input is the spreadsheet a human has been marking up by hand,
// and its qualifying gate is exactly one column in that sheet.
//
// ============================ SAFETY ==================================
// Local only, structurally — not by convention:
//   - every SQL statement goes through `supabase db query --local`
//   - storage uploads go to the API_URL that `supabase status` reports for
//     the local stack, and the script ABORTS unless that host is loopback
//   - there is no --linked / --project-ref code path anywhere in this file
//
// ======================= QUALIFYING RULES =============================
// A row is imported only when `Menu List Under 100` is exactly "Yes"
// (trimmed). "No", blank, or anything else is skipped, and no other signal
// (price level, cheap individual items, discovery score) can qualify a row
// in its place — that column is the human decision this script defers to.
//
//   name        <- Excel `name`, verbatim
//   price       <- the MINIMUM integer found in `Menu Details/Notes`, after
//                  URLs are stripped out (so a domain like foo123.com can
//                  never be read as a price)
//   note        <- `Menu Details/Notes`, verbatim, unchanged
//   lat/lng     <- Excel `latitude` / `longitude`
//   is_hidden   <- always true; nothing imported here goes live on its own
//   photos      <- every file in tools/discovery/photos/<place_id>/, matched
//                  STRICTLY by the row's own place_id and nothing else. No
//                  name, address, phone or fuzzy matching, by design: a
//                  wrong photo on a real restaurant is worse than no photo.
//
// The Excel place_id/address/phone/website have nowhere to go: `listings`
// has no column for them and this script does not add one (see the schema
// gap noted in AGENTS.md). They are recorded in the state file below so the
// provenance is not simply lost.
//
// ==================== RESUMABLE / DUPLICATE-SAFE ======================
// Two independent layers, because a state file alone can lie (deleted,
// stale, or written after a crash):
//   1. output/excel-import-state.json records every place_id already
//      imported, its listing_id, and every photo already uploaded.
//   2. Before ANY insert, the live database is re-read and checked with
//      matching.mjs's duplicateRisk() plus an exact name+coordinate match.
//      A hit skips the row even if the state file has never heard of it.
// Photo uploads are idempotent (an already-present object is left alone),
// and the listing + its listing_photos rows go in inside ONE transaction,
// so a crash can never leave a listing with half its photo rows.
//
// Usage:
//   node tools/discovery/import-excel.mjs                 # dry run (default)
//   node tools/discovery/import-excel.mjs --yes            # actually import
//   node tools/discovery/import-excel.mjs --status         # what's imported so far
//   node tools/discovery/import-excel.mjs --file=<xlsx>    # override input sheet
//   node tools/discovery/import-excel.mjs --backfill-location-labels
//                                          # fill location_label on rows this
//                                          # importer created before it resolved
//                                          # addresses (null labels only)

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { duplicateRisk } from './matching.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const OUTPUT_DIR = join(HERE, 'output');
const PHOTOS_DIR = join(HERE, 'photos');
const STATE_FILE = join(OUTPUT_DIR, 'excel-import-state.json');
const DEFAULT_XLSX = join(OUTPUT_DIR, 'candidates-2026-09-01T11-50-51-056Z workonprogress.xlsx');

// Fixed seed profile id from supabase/migrations/0003_seed_demo_listings.sql
// — the same owner import-approved.mjs uses, already present on any local
// stack that has run its migrations.
const SEED_USER_ID = '00000000-0000-0000-0000-000000000001';
const BUCKET = 'listing-photos';
const CITY = 'Bengaluru';
const QUALIFY_COLUMN = 'Menu List Under 100';
const NOTES_COLUMN = 'Menu Details/Notes';

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
};

// ---------------------------------------------------------------- guards

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

// Same discovery mechanism as scripts/restore-local-db.mjs and
// import-approved.mjs — refuses to guess, refuses any fallback.
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
    throw new Error(
      `No running local Supabase DB container for project "${projectId}". ` +
        `Run "npx supabase start" first. STOPPING — will not fall back to production.`
    );
  }
  if (names.length > 1) {
    throw new Error(`Found multiple matching containers (${names.join(', ')}) — refusing to guess.`);
  }
  return names[0];
}

// The local stack's own API URL + service key, read from the CLI rather
// than hard-coded or taken from any .env (a .env could point anywhere).
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

  // The hard stop. Anything that isn't loopback means this is not the
  // local stack, and this script must never touch it.
  const host = new URL(apiUrl).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(
      `REFUSING TO RUN: API_URL "${apiUrl}" is not the local stack. ` +
        `This importer only ever writes to a loopback Supabase.`
    );
  }
  return { apiUrl: apiUrl.replace(/\/$/, ''), serviceKey };
}

// ------------------------------------------------------------------ sql

// Builds a SQL text expression for an arbitrary JS string.
//
// Not just quote-doubling: `supabase db query --local` receives its SQL as
// a single shell argument (shell:true), and a raw control character in that
// argument does NOT survive the trip — a real newline arrives at Postgres
// as the two literal characters \ and n, so the note stored for a listing
// stops being byte-identical to the spreadsheet cell it came from
// (confirmed live: an 8-character probe string came back 10 characters
// long). Every character outside plain printable ASCII is therefore emitted
// as a chr(N) concatenation instead of being placed in the argument
// literally, which keeps the value exact no matter what the shell does to
// it. Backslash is included in that set because JSON.stringify doubles it
// on the way out.
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

function runSql(sql, { expectRows = false } = {}) {
  const result = spawnSync('npx', ['supabase', 'db', 'query', '--local', JSON.stringify(sql)], {
    encoding: 'utf8',
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(`"supabase db query --local" failed:\n${result.stderr || result.stdout}`);
  }
  // The CLI can report a query error in its stdout payload as well as via
  // the exit code; treat either as a failure rather than trusting only the
  // status, so a failed write can never be mistaken for a successful one.
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
  // The CLI's own output carries a `warning` field noting that row DATA is
  // untrusted database content, not instructions. Respected: nothing read
  // back here is ever executed or interpolated into a later statement —
  // only compared numerically/structurally.
  if (!rows) throw new Error(`Query output had no rows array:\n${out.slice(0, 800)}`);
  return rows;
}

function fetchExistingListings() {
  const rows = runSql('select id, name, latitude, longitude from listings;', { expectRows: true });
  for (const row of rows) {
    if (typeof row.name !== 'string' || typeof row.latitude !== 'number' || typeof row.longitude !== 'number') {
      throw new Error(
        `An existing listing is missing name/latitude/longitude — refusing to import blind to duplicates. Row: ${JSON.stringify(row)}`
      );
    }
  }
  return rows;
}

// --------------------------------------------------------------- parsing

function readWorkbook(xlsxPath) {
  if (!existsSync(xlsxPath)) throw new Error(`Input spreadsheet not found: ${xlsxPath}`);
  // Both paths are quoted because shell:true is in play and the real
  // workbook filename contains spaces — unquoted, the shell splits it and
  // python sees two bad arguments instead of one good one.
  const result = spawnSync('python', [JSON.stringify(join(HERE, 'xlsx-to-json.py')), JSON.stringify(xlsxPath)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(`Reading the spreadsheet failed (is Python + openpyxl available?):\n${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout);
  for (const column of ['place_id', 'name', 'latitude', 'longitude', QUALIFY_COLUMN, NOTES_COLUMN]) {
    if (!parsed.headers.includes(column)) {
      throw new Error(`Spreadsheet is missing the required column "${column}". Found: ${parsed.headers.join(', ')}`);
    }
  }
  return parsed.rows;
}

// Minimum integer in the notes, with URLs removed first. Bare integers
// only: a digit run that is part of a decimal or a longer number is
// ignored, so a postcode inside an address fragment can't become a price.
//
// A number that is a QUANTITY rather than a price is excluded too. Real
// example that made this necessary: "Biryani rice 90, parotha(2nos) 60,
// rahi ball(2nos) 60" — the 2 in "(2nos)" is how many parothas you get,
// not what they cost, and being the smallest number in the string it would
// otherwise become the listing's price (Rs 2, sorting straight to the top
// of a cheapest-first map). Covers the forms these notes actually use —
// 2nos / 2 nos / 2no / 2pcs / 2 pcs / 2 piece / 2 pieces, any case — and
// nothing else: a plain "60" or "60," is still read exactly as before, so
// genuine prices are untouched.
//
// Written as one regex literal rather than assembled from a template
// string: a template literal swallows the backslashes ("\d" becomes a plain
// "d"), which silently turns [\d.] into [d.] and breaks the whole pattern.
//   (?<![\d.])                      not preceded by a digit or a decimal point
//   \d{1,4}                         the number itself
//   (?![\d.])                       not followed by a digit or a decimal point
//   (?!\s*(?:nos?|pcs?|pieces?)\b)  ...and not a quantity like "(2nos)"
const PRICE_PATTERN = /(?<![\d.])\d{1,4}(?![\d.])(?!\s*(?:nos?|pcs?|pieces?)\b)/gi;

function minPriceFrom(note) {
  if (typeof note !== 'string') return null;
  const withoutUrls = note.replace(/https?:\/\/\S+/g, ' ');
  // String.match with a /g regex ignores lastIndex, so reusing this shared
  // pattern across calls is safe.
  const numbers = (withoutUrls.match(PRICE_PATTERN) ?? []).map(Number);
  if (numbers.length === 0) return null;
  return Math.min(...numbers);
}

function photosFor(placeId) {
  const dir = join(PHOTOS_DIR, placeId);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ filename: name, absolutePath: join(dir, name), bytes: statSync(join(dir, name)).size }));
}

function storagePathFor(placeId, filename) {
  // <owner>/<place_id>/<filename>: the owner prefix is what the bucket's
  // RLS policies key off — (storage.foldername(name))[1] — and the
  // place_id segment keeps every photo traceable to the exact row that
  // claimed it.
  return `${SEED_USER_ID}/${placeId}/${filename}`;
}

function encodePath(storagePath) {
  return storagePath.split('/').map(encodeURIComponent).join('/');
}

function publicUrlFor(apiUrl, storagePath) {
  return `${apiUrl}/storage/v1/object/public/${BUCKET}/${encodePath(storagePath)}`;
}

// ------------------------------------------------- location_label (OLA)

// Google's `formatted_address` from the discovery data is a full postal
// address ("Ground Floor, 102/B, 17th Main Rd, Sector 3, HSR Layout,
// Bengaluru, Karnataka 560102, India") — not the short "Street, Area"
// descriptor `listings.location_label` is defined to hold (migration 0010),
// and the popup that displays it has room for one short line. So the label
// is resolved the same way the web app resolves it at Add Listing time:
// OLA's reverse-geocode endpoint against the listing's own coordinates.
// Same provider, same key, same preference order as
// web/src/lib/reverseGeocode.ts — deliberately duplicated rather than
// shared, matching how this repo already duplicates content-moderation and
// bestPlaceMatch across runtimes.
//
// Never fabricates: any failure (no key, network error, bad response,
// nothing usable in the payload) yields null, and null is always safe —
// latitude/longitude remain the authoritative location and the UI simply
// omits the line.
const OLA_BASE = 'https://api.olamaps.io';
const REVERSE_GEOCODE_TIMEOUT_MS = 8000;

function readOlaApiKey() {
  if (process.env.OLA_MAPS_API_KEY) return process.env.OLA_MAPS_API_KEY;
  // Falls back to the keys the two apps already keep in their own env
  // files, so this script needs no new secret of its own.
  for (const [file, name] of [
    [join(REPO_ROOT, '.env'), 'EXPO_PUBLIC_OLA_MAPS_API_KEY'],
    [join(REPO_ROOT, 'web', '.env'), 'VITE_OLA_MAPS_API_KEY'],
  ]) {
    if (!existsSync(file)) continue;
    const match = readFileSync(file, 'utf8').match(new RegExp(`^${name}\\s*=\\s*(.+)$`, 'm'));
    if (match) {
      const value = match[1].trim();
      if (value) return value;
    }
  }
  return null;
}

function componentOf(components, type) {
  return components.find((c) => Array.isArray(c.types) && c.types.includes(type))?.long_name;
}

// Same shape as web/src/lib/reverseGeocode.ts's buildLabel: prefer
// "Street, Area", fall back to whichever half exists, then the city, then
// give up. Never state or country — useless for a Bengaluru-only app.
function buildLocationLabel(components) {
  const street = componentOf(components, 'route') ?? componentOf(components, 'street_address');
  const area = componentOf(components, 'sublocality') ?? componentOf(components, 'neighborhood');

  if (street && area) return `${street}, ${area}`;
  if (area) return area;
  if (street) return street;

  const city = componentOf(components, 'locality');
  return city ?? null;
}

async function resolveLocationLabel(apiKey, latitude, longitude) {
  if (!apiKey) return null;
  try {
    const params = new URLSearchParams({ latlng: `${latitude},${longitude}`, api_key: apiKey });
    // The web copy of this has no timeout, which is a known loose end there
    // (a hung request leaves its "Finding the address…" text stuck). Nothing
    // stops this one from having one.
    const res = await fetch(`${OLA_BASE}/places/v1/reverse-geocode?${params.toString()}`, {
      signal: AbortSignal.timeout(REVERSE_GEOCODE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const components = data?.results?.[0]?.address_components ?? [];
    return buildLocationLabel(components);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- state file

function loadState() {
  if (!existsSync(STATE_FILE)) return { source_file: null, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object') {
      throw new Error('unexpected shape');
    }
    return parsed;
  } catch (err) {
    throw new Error(
      `Could not read ${STATE_FILE} (${err.message}). Refusing to continue — fix or delete it, ` +
        `but note that deleting it loses the record of what was already imported.`
    );
  }
}

function saveState(state) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------- upload

async function objectExists(apiUrl, serviceKey, storagePath) {
  const res = await fetch(`${apiUrl}/storage/v1/object/info/public/${BUCKET}/${encodePath(storagePath)}`, {
    headers: { Authorization: `Bearer ${serviceKey}` },
  });
  return res.status === 200;
}

async function uploadPhoto(apiUrl, serviceKey, photo, storagePath) {
  const contentType = MIME_TYPES[extname(photo.filename).toLowerCase()] ?? 'application/octet-stream';
  const body = readFileSync(photo.absolutePath);
  const res = await fetch(`${apiUrl}/storage/v1/object/${BUCKET}/${encodePath(storagePath)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': contentType,
      // Makes a re-run after a partial failure a no-op rather than a 409.
      'x-upsert': 'true',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Upload failed for ${storagePath} (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return { contentType, bytes: body.length };
}

// ------------------------------------------------------------------ main

async function main() {
  assertRepoRoot();

  const args = process.argv.slice(2);
  if (args.some((a) => a === '--linked' || a.startsWith('--project-ref'))) {
    throw new Error('REFUSING TO RUN: this importer is local-only and has no remote target.');
  }
  const apply = args.includes('--yes');
  const statusOnly = args.includes('--status');
  const backfillLabels = args.includes('--backfill-location-labels');
  const fileArg = args.find((a) => a.startsWith('--file='));
  const xlsxPath = fileArg ? fileArg.slice('--file='.length) : DEFAULT_XLSX;

  const state = loadState();

  if (statusOnly) {
    const entries = Object.values(state.entries);
    console.log(`State file: ${STATE_FILE}`);
    console.log(`Imported so far: ${entries.length}`);
    for (const e of entries) {
      console.log(`  ${e.name} (${e.place_id}) -> listing ${e.listing_id}, ${e.photos?.length ?? 0} photo(s), ${e.imported_at}`);
    }
    return;
  }

  const projectId = readProjectId();
  const container = assertLocalStackRunning(projectId);
  const { apiUrl, serviceKey } = readLocalStackConfig();
  const olaApiKey = readOlaApiKey();

  // Backfill for listings imported before this script resolved addresses at
  // all (their location_label went in as null). Only ever touches rows this
  // importer created — it walks its own state file and matches on the
  // recorded listing_id — and only ever fills a label that is currently
  // null, so it can't overwrite anything a human has since corrected.
  if (backfillLabels) {
    if (!olaApiKey) throw new Error('No OLA API key found — cannot resolve addresses. Set OLA_MAPS_API_KEY, or leave EXPO_PUBLIC_OLA_MAPS_API_KEY / VITE_OLA_MAPS_API_KEY in the app .env files.');
    const entries = Object.values(state.entries);
    console.log(`Backfilling location_label for ${entries.length} imported listing(s) on ${apiUrl}...\n`);

    let filled = 0;
    for (const entry of entries) {
      const [row] = runSql(
        `select id, location_label from listings where id = ${sqlString(entry.listing_id)};`,
        { expectRows: true }
      );
      if (!row) {
        console.log(`  ${entry.name}: listing ${entry.listing_id} no longer exists — skipped.`);
        continue;
      }
      if (row.location_label) {
        console.log(`  ${entry.name}: already has "${row.location_label}" — left alone.`);
        continue;
      }
      const label = await resolveLocationLabel(olaApiKey, entry.latitude, entry.longitude);
      if (!label) {
        console.log(`  ${entry.name}: reverse geocoding resolved nothing — left null (never fabricated).`);
        continue;
      }
      runSql(`update listings set location_label = ${sqlString(label)} where id = ${sqlString(entry.listing_id)};`);
      entry.location_label = label;
      saveState(state);
      filled += 1;
      console.log(`  ${entry.name}: "${label}"`);
    }
    console.log(`\nFilled ${filled} label(s).`);
    return;
  }

  console.log('='.repeat(72));
  console.log(`Mode        : ${apply ? 'IMPORT (writing)' : 'DRY RUN (nothing will be written)'}`);
  console.log(`Spreadsheet : ${xlsxPath}`);
  console.log(`Target      : ${apiUrl}  [local container ${container}]`);
  console.log(`Address lookup : ${olaApiKey ? 'OLA reverse-geocode' : 'DISABLED (no OLA key found — location_label will be null)'}`);
  console.log('='.repeat(72));

  const rows = readWorkbook(xlsxPath);
  const existing = fetchExistingListings();

  const skippedNotYes = [];
  const skippedAlready = [];
  const skippedOther = [];
  const toImport = [];

  for (const [index, row] of rows.entries()) {
    const excelRow = index + 2; // +1 for the header row, +1 for 1-based rows
    const qualifier = row[QUALIFY_COLUMN];
    if (typeof qualifier !== 'string' || qualifier.trim() !== 'Yes') {
      skippedNotYes.push({ excelRow, name: row.name, value: qualifier ?? null });
      continue;
    }

    const placeId = row.place_id;
    const name = row.name;
    const note = row[NOTES_COLUMN];
    const latitude = typeof row.latitude === 'number' ? row.latitude : Number(row.latitude);
    const longitude = typeof row.longitude === 'number' ? row.longitude : Number(row.longitude);

    const problems = [];
    if (typeof placeId !== 'string' || !placeId.trim()) problems.push('missing place_id');
    if (typeof name !== 'string' || !name.trim()) problems.push('missing name');
    else if (name.length > 120) problems.push(`name is ${name.length} chars (DB cap is 120)`);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) problems.push('latitude missing/out of range');
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) problems.push('longitude missing/out of range');

    const price = minPriceFrom(note);
    if (price === null) problems.push(`no numeric price found in "${NOTES_COLUMN}"`);
    else if (!(price > 0 && price <= 100)) problems.push(`price ${price} is outside the 0 < price <= 100 cap`);

    if (problems.length) {
      skippedOther.push({ excelRow, name, place_id: placeId, problems });
      continue;
    }

    // Layer 1: has this exact place_id already been imported, and is that
    // listing still really there? A state entry whose listing has since
    // been deleted is stale, and must not block a re-import.
    const prior = state.entries[placeId];
    if (prior?.listing_id && existing.some((e) => e.id === prior.listing_id)) {
      skippedAlready.push({ excelRow, name, place_id: placeId, reason: `already imported as listing ${prior.listing_id}` });
      continue;
    }

    // Layer 2: ask the database itself, regardless of what the state file
    // thinks. Exact same-name-same-place first, then the deliberately
    // over-flagging proximity/name check from matching.mjs.
    const exact = existing.find(
      (e) =>
        e.name.trim().toLowerCase() === name.trim().toLowerCase() &&
        Math.abs(e.latitude - latitude) < 1e-4 &&
        Math.abs(e.longitude - longitude) < 1e-4
    );
    if (exact) {
      skippedAlready.push({
        excelRow,
        name,
        place_id: placeId,
        reason: `a listing with this name and location already exists (${exact.id})`,
      });
      continue;
    }
    const risky = existing
      .map((e) => ({ e, risk: duplicateRisk({ name, latitude, longitude }, e) }))
      .filter(({ risk }) => risk.flagged);
    if (risky.length) {
      const detail = risky
        .map(({ e, risk }) => `${e.name} (${Math.round(risk.distanceKm * 1000)}m, ${Math.round(risk.nameOverlapRatio * 100)}% name overlap)`)
        .join('; ');
      skippedAlready.push({ excelRow, name, place_id: placeId, reason: `possible duplicate of ${detail} — needs a human decision` });
      continue;
    }

    toImport.push({
      excelRow,
      place_id: placeId,
      name,
      note: typeof note === 'string' ? note : null,
      price,
      latitude,
      longitude,
      address: row.formatted_address ?? null,
      phone: row.phone ?? null,
      website_uri: row.website_uri ?? null,
      google_maps_uri: row.google_maps_uri ?? null,
      primary_type: row.primary_type ?? null,
      photos: photosFor(placeId),
    });
  }

  // Resolved here rather than inside the import loop so a dry run reports
  // the exact location_label the real import would store, and so the import
  // itself doesn't repeat the lookup. Read-only either way — reverse
  // geocoding never writes anything.
  if (toImport.length) {
    for (const candidate of toImport) {
      candidate.locationLabel = await resolveLocationLabel(olaApiKey, candidate.latitude, candidate.longitude);
    }
  }

  console.log(`Rows checked                        : ${rows.length}`);
  console.log(`Qualifying ("${QUALIFY_COLUMN}" = Yes) : ${toImport.length + skippedAlready.length}`);
  console.log(`  -> to import now                  : ${toImport.length}`);
  console.log(`  -> skipped, already imported      : ${skippedAlready.length}`);
  console.log(`Skipped, not "Yes"                  : ${skippedNotYes.length}`);
  console.log(`Skipped, other reasons              : ${skippedOther.length}`);
  console.log('');

  for (const s of skippedAlready) console.log(`  [already] row ${s.excelRow} ${s.name}: ${s.reason}`);
  for (const s of skippedOther) console.log(`  [problem] row ${s.excelRow} ${s.name}: ${s.problems.join('; ')}`);
  if (skippedAlready.length || skippedOther.length) console.log('');

  for (const c of toImport) {
    console.log(`  [import] row ${c.excelRow} ${c.name}`);
    console.log(`           place_id : ${c.place_id}`);
    console.log(`           price    : Rs ${c.price}   (from ${JSON.stringify(c.note)})`);
    console.log(`           location : ${c.latitude}, ${c.longitude}`);
    console.log(`           address  : ${c.address ?? '(none)'}`);
    console.log(`           label    : ${c.locationLabel ?? '(unresolved — will be stored as null)'}`);
    console.log(`           photo dir: ${c.photos.length ? join(PHOTOS_DIR, c.place_id) : '(no folder for this place_id)'}`);
    console.log(
      `           photos   : ${c.photos.length}${c.photos.length ? ' -> ' + c.photos.map((p) => p.filename).join(', ') : ' (none)'}`
    );
  }
  console.log('');

  if (!apply) {
    console.log('DRY RUN — nothing was written. Re-run with --yes to import.');
    return;
  }
  if (toImport.length === 0) {
    console.log('Nothing to import.');
    return;
  }

  for (const candidate of toImport) {
    console.log(`Importing ${candidate.name}...`);

    // Photos first: a listing is only ever written with photo_url already
    // pointing at a real object, so there is no window in which a listing
    // advertises a photo that isn't there.
    const uploaded = [];
    for (const photo of candidate.photos) {
      const storagePath = storagePathFor(candidate.place_id, photo.filename);
      const url = publicUrlFor(apiUrl, storagePath);
      if (await objectExists(apiUrl, serviceKey, storagePath)) {
        console.log(`  photo already in storage, skipping upload: ${photo.filename}`);
        uploaded.push({ ...photo, storagePath, url, reused: true });
        continue;
      }
      const result = await uploadPhoto(apiUrl, serviceKey, photo, storagePath);
      console.log(`  uploaded ${photo.filename} (${result.bytes} bytes, ${result.contentType})`);
      uploaded.push({ ...photo, storagePath, url, reused: false });
    }

    const locationLabel = candidate.locationLabel ?? null;
    console.log(`  location_label: ${locationLabel ?? '(unresolved — stored as null)'}`);

    // ONE statement, not a begin/commit block: `supabase db query --local`
    // runs its argument as a prepared statement, which Postgres refuses to
    // accept more than one command in ("cannot insert multiple commands
    // into a prepared statement" — confirmed live). A data-modifying CTE
    // gives the same guarantee anyway: a single statement is atomic, so the
    // listing and every one of its photo rows still land together or not
    // at all.
    const insertListing =
      `insert into listings (created_by, name, note, price_rupees, latitude, longitude, city, location_label, photo_url, is_hidden) ` +
      `values (${sqlString(SEED_USER_ID)}, ${sqlString(candidate.name)}, ${sqlString(candidate.note)}, ${candidate.price}, ` +
      `${candidate.latitude}, ${candidate.longitude}, ${sqlString(CITY)}, ${sqlString(locationLabel)}, ` +
      `${uploaded.length ? sqlString(uploaded[0].url) : 'null'}, true)`;

    const photoValues = uploaded.map((p, i) => `(${sqlString(p.url)}, ${sqlString(p.storagePath)}, ${i})`).join(', ');
    const sql = uploaded.length
      ? `with ins as (${insertListing} returning id) ` +
        `insert into listing_photos (listing_id, photo_url, storage_path, position) ` +
        `select ins.id, v.url, v.path, v.pos from ins, (values ${photoValues}) as v(url, path, pos);`
      : `${insertListing};`;
    runSql(sql);

    const [inserted] = runSql(
      `select id, is_hidden from listings where created_by = ${sqlString(SEED_USER_ID)} ` +
        `and name = ${sqlString(candidate.name)} order by created_at desc limit 1;`,
      { expectRows: true }
    );
    if (!inserted?.id) throw new Error(`Insert of "${candidate.name}" reported success but the row could not be read back.`);

    state.entries[candidate.place_id] = {
      place_id: candidate.place_id,
      name: candidate.name,
      listing_id: inserted.id,
      price_rupees: candidate.price,
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      location_label: locationLabel,
      // Kept here because `listings` has no column for any of it and this
      // script does not add one.
      address: candidate.address,
      phone: candidate.phone,
      website_uri: candidate.website_uri,
      google_maps_uri: candidate.google_maps_uri,
      primary_type: candidate.primary_type,
      excel_row: candidate.excelRow,
      photos: uploaded.map((p, i) => ({
        filename: p.filename,
        storage_path: p.storagePath,
        url: p.url,
        position: i,
        bytes: p.bytes,
      })),
      source_file: xlsxPath,
      imported_at: new Date().toISOString(),
    };
    state.source_file = xlsxPath;
    saveState(state);

    console.log(`  listing ${inserted.id} created (is_hidden=${inserted.is_hidden}), ${uploaded.length} photo row(s)\n`);
  }

  console.log('='.repeat(72));
  console.log(`Imported ${toImport.length} listing(s). State: ${STATE_FILE}`);
  console.log('Everything is is_hidden = true — nothing is visible in the app yet.');
  console.log('='.repeat(72));
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
