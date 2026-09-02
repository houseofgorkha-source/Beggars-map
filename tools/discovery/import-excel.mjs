// Bulk-imports human-reviewed restaurants from the working Excel sheet into
// the LOCAL Supabase stack, with their photos.
//
// This is a sibling of import-approved.mjs, not a replacement: that one
// imports from verify-queue.mjs's JSON and has no photo handling at all.
// This one's input is the spreadsheet a human has been marking up by hand,
// and its qualifying gate is exactly one column in that sheet.
//
// ============================ SAFETY ==================================
// Two modes, and the safe one is the default.
//
// LOCAL (default — no flags):
//   - every SQL statement goes through `supabase db query --local`
//   - storage uploads go to the API_URL that `supabase status` reports for
//     the local stack, and the script ABORTS unless that host is loopback
//   - passing --linked / --project-ref is refused outright
//   - writes only with --yes
//
// PRODUCTION (--production, opt-in, never reachable by accident):
//   - refuses to do anything until assertProductionTarget() passes: the
//     LINKED project must be exactly nvingzluboafxzxgxxwc (so a machine
//     linked to RentalIntel, or to nothing, aborts), `listings` and
//     `listing_photos` must exist, the listing-photos bucket must exist,
//     and the owner profile the rows are attributed to must exist
//   - the target is hard-coded, NOT taken from a .env or a flag; there is
//     still no --linked / --project-ref option in this mode either
//   - DRY RUN IS MANDATORY: --production alone performs ZERO writes and
//     prints exactly what would change
//   - writing requires BOTH --production and --execute. One flag alone
//     never writes, so a typo or a shell-history re-run cannot import
//   - imports are is_hidden = true and are never unhidden by this script
//   - nothing here ever UPDATEs or DELETEs an existing listing
//   - no production service-role key is read or stored: storage goes
//     through `supabase storage cp`, which uses the developer's own login
//
// "Already imported" is tracked per environment, so a local test import
// never makes production look done (and vice versa).
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
//      imported, its listing_id, and every photo already uploaded — kept in
//      a separate namespace per environment (local vs production).
//   2. Before ANY insert, the database THAT IS ABOUT TO BE WRITTEN is
//      re-read and checked (see below) — never a cached list, never another
//      environment's data.
//      The check is matching.mjs's duplicateRisk() plus an exact
//      name+coordinate match. A hit skips the row even if the state file
//      has never heard of it.
// Photo uploads are idempotent (an already-present object is left alone),
// and the listing + its listing_photos rows go in inside ONE transaction,
// so a crash can never leave a listing with half its photo rows.
//
// Usage:
//   node tools/discovery/import-excel.mjs                 # LOCAL dry run (default)
//   node tools/discovery/import-excel.mjs --yes            # LOCAL import
//   node tools/discovery/import-excel.mjs --production     # PRODUCTION dry run (zero writes)
//   node tools/discovery/import-excel.mjs --production --execute   # PRODUCTION import
//   node tools/discovery/import-excel.mjs --status         # what's imported so far (add --production for that env)
//   node tools/discovery/import-excel.mjs --file=<xlsx>    # override input sheet
//   node tools/discovery/import-excel.mjs --backfill-location-labels
//                                          # fill location_label on rows this
//                                          # importer created before it resolved
//                                          # addresses (null labels only)

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { duplicateRisk } from './matching.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const OUTPUT_DIR = join(HERE, 'output');
const PHOTOS_DIR = join(HERE, 'photos');
const STATE_FILE = join(OUTPUT_DIR, 'excel-import-state.json');
const DEFAULT_XLSX = join(OUTPUT_DIR, 'candidates-2026-09-01T11-50-51-056Z workonprogress.xlsx');

// Fixed seed profile id from supabase/migrations/0003_seed_demo_listings.sql
// — the same owner import-approved.mjs uses, already present on any local
// stack that has run its migrations, and present in production too as
// "Beggars Map Team" (it owns the five demo listings there).
const SEED_USER_ID = '00000000-0000-0000-0000-000000000001';
const BUCKET = 'listing-photos';

// The ONE hosted project this importer will ever accept in --production
// mode. Hard-coded on purpose: the CLI's linked project is whatever someone
// last ran `supabase link` against, and this account also holds RentalIntel.
// Anything but an exact match aborts before a single row is read.
const PRODUCTION_PROJECT_REF = 'nvingzluboafxzxgxxwc';
const PRODUCTION_API_URL = `https://${PRODUCTION_PROJECT_REF}.supabase.co`;
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

// Which database every statement below goes to. Set exactly once, in main(),
// from the command line: '--local' unless --production was passed AND passed
// every preflight check in assertProductionTarget(). Nothing else may write
// to it, and no code path defaults it to the linked project.
let DB_TARGET_FLAG = '--local';

function runSql(sql, { expectRows = false } = {}) {
  const result = spawnSync('npx', ['supabase', 'db', 'query', DB_TARGET_FLAG, JSON.stringify(sql)], {
    encoding: 'utf8',
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(`"supabase db query ${DB_TARGET_FLAG}" failed:\n${result.stderr || result.stdout}`);
  }
  // The CLI can report a query error in its stdout payload as well as via
  // the exit code; treat either as a failure rather than trusting only the
  // status, so a failed write can never be mistaken for a successful one.
  if (/"_tag"\s*:\s*"Error"/.test(result.stdout)) {
    throw new Error(`"supabase db query ${DB_TARGET_FLAG}" returned an error:\n${result.stdout.slice(0, 800)}`);
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
    if (parsed.environments && typeof parsed.environments !== 'object') {
      throw new Error('unexpected "environments" shape');
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

// Per-environment view of the state file. Local keeps the original top-level
// `entries` key (so no existing state file needs migrating); production gets
// its own namespace, because "already imported" is a fact about ONE database
// and a local test import must never make the importer think production
// already has that restaurant.
function entriesFor(state, production) {
  if (!production) return state.entries;
  state.environments = state.environments ?? {};
  state.environments.production = state.environments.production ?? { entries: {} };
  return state.environments.production.entries;
}

// ---------------------------------------------------------- storage I/O
//
// Two adapters over the same three operations, so every decision above this
// line (what qualifies, what a price is, which photos belong to a row) is
// shared and environment-blind. Only the plumbing differs:
//   local      — HTTP against the loopback API with the local stack's own
//                service key, which `supabase status` hands out.
//   production — the CLI's `storage cp/ls`, which authenticates with the
//                developer's own Supabase login. That deliberately means no
//                production service-role key is ever read, stored, or
//                passed around by this script.

function localStorageAdapter(apiUrl, serviceKey) {
  return {
    publicUrlFor: (storagePath) => `${apiUrl}/storage/v1/object/public/${BUCKET}/${encodePath(storagePath)}`,

    async objectExists(storagePath) {
      const res = await fetch(`${apiUrl}/storage/v1/object/info/public/${BUCKET}/${encodePath(storagePath)}`, {
        headers: { Authorization: `Bearer ${serviceKey}` },
      });
      return res.status === 200;
    },

    async uploadPhoto(photo, storagePath) {
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
    },
  };
}

// `supabase storage ls/cp` still sit behind --experimental in this CLI
// version; without it every call fails with LegacyExperimentalRequiredError.
// shell:false, and every argument passed as its own argv entry.
//
// This is not a style preference. The rest of this file uses shell:true and
// hand-quotes arguments with JSON.stringify to survive spaces — which works
// for `storage ls`, but silently breaks `storage cp`: the CLI receives the
// destination WITH the quote characters still in it, stops recognising the
// ss:// scheme, decides both arguments are local paths, and fails with
// "LegacyStorageUnsupportedOperationError: Unsupported operation ... to copy
// between local directories". Confirmed the hard way against production —
// the import aborted on its first photo (having written nothing).
// shell:false hands argv straight to the process, so "unnamed (1).webp"
// arrives intact AND "ss:///bucket/..." arrives unquoted.
//
// `npx` is not directly executable without a shell on Windows; the .cmd
// shim is what exists on PATH there.
// Resolving the CLI so it can be spawned WITHOUT a shell is the fiddly part
// on Windows: `npx` is a shell script (ENOENT without a shell) and `npx.cmd`
// is a batch file, which modern Node refuses to spawn shell-less at all
// (EINVAL, a deliberate security fix). Both were measured here. What does
// work is running the `supabase` npm package's own wrapper with the current
// node binary — plain argv, no shell, no quoting anywhere.
//
// Order: an explicit override, then the repo's own node_modules, then npm's
// npx cache (where `npx supabase` actually keeps it on this machine). If
// none is found we fall back to npx-through-a-shell, which is what the rest
// of this file uses for `db query` and works fine there.
let cachedCli = null;

function resolveSupabaseCli() {
  if (cachedCli) return cachedCli;

  const candidates = [];
  if (process.env.SUPABASE_CLI_JS) candidates.push(process.env.SUPABASE_CLI_JS);
  candidates.push(join(REPO_ROOT, 'node_modules', 'supabase', 'dist', 'supabase.js'));

  const npxCache = join(process.env.LOCALAPPDATA ?? process.env.HOME ?? '', 'npm-cache', '_npx');
  if (existsSync(npxCache)) {
    for (const dir of readdirSync(npxCache)) {
      candidates.push(join(npxCache, dir, 'node_modules', 'supabase', 'dist', 'supabase.js'));
    }
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      cachedCli = { command: process.execPath, prefix: [candidate], shell: false };
      return cachedCli;
    }
  }

  cachedCli = { command: 'npx', prefix: ['supabase'], shell: true };
  return cachedCli;
}

// Every argument is its own argv entry — no hand-quoting, so a filename
// containing spaces and parentheses ("unnamed (1).webp") and an unquoted
// remote destination ("ss:///listing-photos/...") both arrive intact.
function supabaseSpawn(args) {
  const cli = resolveSupabaseCli();
  return spawnSync(cli.command, [...cli.prefix, ...args], {
    encoding: 'utf8',
    shell: cli.shell,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function storageCli(args, targetFlag = '--linked') {
  return supabaseSpawn(['storage', ...args, targetFlag, '--experimental']);
}

// Counter-intuitively, `supabase storage ls` prints JSON by DEFAULT
// ({"paths":[...]}) and prints bare text lines when you ask for `-o json`
// (verified against this CLI). So never pass -o here, and fall back to
// line-splitting if the JSON shape ever changes underneath us.
function storageList(prefix, targetFlag) {
  const result = storageCli(prefix ? ['ls', prefix] : ['ls'], targetFlag);
  if (result.status !== 0) {
    throw new Error(`"supabase storage ls" failed: ${(result.stderr || result.stdout).slice(0, 300)}`);
  }
  const out = result.stdout.trim();
  const start = out.search(/[[{]/);
  if (start !== -1) {
    try {
      const parsed = JSON.parse(out.slice(start));
      if (Array.isArray(parsed.paths)) return parsed.paths;
    } catch {
      /* fall through to the text form */
    }
  }
  return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

// `targetFlag`/`apiUrl` exist so this EXACT adapter can be rehearsed against
// the local stack (see the adapter smoke test) rather than being tested by
// assumption. main() always constructs it with no arguments — production —
// and no command-line flag can reach these parameters.
function productionStorageAdapter(targetFlag = '--linked', apiUrl = PRODUCTION_API_URL) {
  return {
    publicUrlFor: (storagePath) => `${apiUrl}/storage/v1/object/public/${BUCKET}/${encodePath(storagePath)}`,

    // Lists the object's own prefix and looks for its filename, so a
    // re-run after an interrupted import skips what is already uploaded.
    async objectExists(storagePath) {
      const slash = storagePath.lastIndexOf('/');
      const prefix = storagePath.slice(0, slash + 1);
      const filename = storagePath.slice(slash + 1);
      try {
        const paths = storageList(`ss:///${BUCKET}/${prefix}`, targetFlag);
        return paths.includes(filename) || paths.includes(`${prefix}${filename}`);
      } catch {
        // Treat "couldn't tell" as "not there": the upload itself is an
        // upsert, so a re-upload is wasteful but never wrong.
        return false;
      }
    },

    async uploadPhoto(photo, storagePath) {
      const contentType = MIME_TYPES[extname(photo.filename).toLowerCase()] ?? 'application/octet-stream';

      // `supabase storage cp` breaks on an ABSOLUTE Windows path with a
      // drive letter (e.g. "C:\Projects\..."). Root cause, confirmed by
      // reproducing it cleanly: Go's net/url grammar accepts a single
      // ASCII letter as a URL scheme, so "C:" parses as scheme "c", the
      // CLI's remote/local classifier misfires on the source argument, and
      // it fails with "Unsupported operation ... to copy between local
      // directories" even though the destination is a perfectly good
      // ss:// URL. A path relative to the current directory never starts
      // with "<letter>:", so it never hits this. This importer's own
      // documented usage is "run from the repo root", so a path relative
      // to process.cwd() is exactly what the CLI itself resolves a
      // relative path against — not a guess, and not REPO_ROOT (derived
      // from this file's own location, which can differ from cwd).
      const relativeSource = relative(process.cwd(), photo.absolutePath);
      if (!relativeSource || relativeSource.startsWith('..') || isAbsolute(relativeSource)) {
        throw new Error(
          `Cannot express "${photo.absolutePath}" as a path relative to the current directory ` +
            `(${process.cwd()}) — supabase storage cp cannot take an absolute Windows path. ` +
            `Run this importer from the repository root.`
        );
      }

      const result = storageCli(
        ['cp', relativeSource, `ss:///${BUCKET}/${storagePath}`, '--content-type', contentType],
        targetFlag
      );
      const output = `${result.stdout}${result.stderr}`;
      if (result.status !== 0 || /"_tag"\s*:\s*"Error"/.test(output)) {
        throw new Error(`Upload failed for ${storagePath}:\n${output.slice(0, 400)}`);
      }
      return { contentType, bytes: statSync(photo.absolutePath).size };
    },
  };
}

// ------------------------------------------------- production preflight

function readLinkedProjectRef() {
  const result = spawnSync('npx', ['supabase', 'projects', 'list', '-o', 'json'], { encoding: 'utf8', shell: true });
  if (result.status !== 0) {
    throw new Error(`Could not list Supabase projects (are you logged in?): ${result.stderr || result.stdout}`);
  }
  // Two shapes in the wild from the same CLI: `-o json` prints a bare
  // (pretty-printed) array, while the default prints {"projects":[...]}.
  // Accept either rather than assuming one and mis-slicing the other.
  const start = result.stdout.search(/[[{]/);
  if (start === -1) throw new Error(`"supabase projects list" produced no JSON:\n${result.stdout.slice(0, 400)}`);
  const parsed = JSON.parse(result.stdout.slice(start));
  const projects = Array.isArray(parsed) ? parsed : parsed.projects ?? [];
  const linked = projects.filter((p) => p.linked);
  if (linked.length === 0) throw new Error('No Supabase project is linked. STOPPING — refusing to guess a production target.');
  if (linked.length > 1) throw new Error(`More than one project reports linked (${linked.map((p) => p.ref).join(', ')}) — refusing to guess.`);
  return linked[0];
}

// Everything that must be true before --production is allowed to proceed,
// checked in order and reported as it goes. Any failure throws; there is no
// "continue anyway" path.
function assertProductionTarget() {
  const checks = [];

  const linked = readLinkedProjectRef();
  if (linked.ref !== PRODUCTION_PROJECT_REF) {
    throw new Error(
      `REFUSING TO RUN: the linked Supabase project is "${linked.name}" (${linked.ref}), ` +
        `not Beggars Map production (${PRODUCTION_PROJECT_REF}). ` +
        `Re-link with "npx supabase link --project-ref ${PRODUCTION_PROJECT_REF}" before importing.`
    );
  }
  checks.push(`linked project is ${linked.name} (${linked.ref})`);

  // The API URL is derived from the verified ref, never from a .env file —
  // a .env can point anywhere, and this must not be steerable that way.
  checks.push(`API URL ${PRODUCTION_API_URL}`);

  const [tableRow] = runSql(
    "select to_regclass('public.listing_photos')::text as t, to_regclass('public.listings')::text as l, " +
      "to_regclass('public.admin_audit_log')::text as a;",
    { expectRows: true }
  );
  if (!tableRow?.l) throw new Error('REFUSING TO RUN: `listings` not found in the linked project — this does not look like Beggars Map.');
  if (!tableRow?.t) {
    throw new Error(
      'REFUSING TO RUN: `listing_photos` does not exist in production. Apply migration ' +
        '0009_listing_photos.sql first — photos 2..n would otherwise fail to insert.'
    );
  }
  checks.push('listing_photos table exists');
  if (!tableRow?.a) {
    throw new Error(
      'REFUSING TO RUN: `admin_audit_log` does not exist in production. Apply migration ' +
        '0013_admin_v2_provenance_and_audit.sql first — every import from here on writes a ' +
        'provenance-tagged listing row (source/actor_type/actor_label) plus an audit log entry, ' +
        'and this script no longer has an unaudited fallback path.'
    );
  }
  checks.push('admin_audit_log table exists');

  const [sourceColRow] = runSql(
    "select column_name from information_schema.columns where table_name = 'listings' and column_name = 'source';",
    { expectRows: true }
  );
  if (!sourceColRow?.column_name) {
    throw new Error(
      'REFUSING TO RUN: `listings.source` does not exist in production. Apply migration ' +
        '0013_admin_v2_provenance_and_audit.sql first.'
    );
  }
  checks.push('listings.source column exists');

  const [settingsTableRow] = runSql("select to_regclass('public.admin_settings')::text as s;", { expectRows: true });
  if (!settingsTableRow?.s) {
    throw new Error(
      'REFUSING TO RUN: `admin_settings` does not exist in production. Apply migration ' +
        '0014_admin_review_state_and_settings.sql first — this importer now reads ' +
        "the import_default_reviewed setting from it before every run."
    );
  }
  checks.push('admin_settings table exists');

  const bucketPaths = storageList(null, '--linked');
  if (!bucketPaths.some((p) => p.replace(/\/$/, '') === BUCKET)) {
    throw new Error(`REFUSING TO RUN: storage bucket "${BUCKET}" not found in production (saw: ${bucketPaths.join(', ') || 'nothing'}).`);
  }
  checks.push(`storage bucket "${BUCKET}" exists`);

  // The owner every imported row is attributed to must already exist, or
  // the insert would fail on the profiles FK halfway through a run.
  const [owner] = runSql(`select id from profiles where id = ${sqlString(SEED_USER_ID)};`, { expectRows: true });
  if (!owner?.id) {
    throw new Error(`REFUSING TO RUN: owner profile ${SEED_USER_ID} does not exist in production.`);
  }
  checks.push(`owner profile ${SEED_USER_ID} exists`);

  const [counts] = runSql(
    'select (select count(*) from listings) as listings, (select count(*) from listing_photos) as photos;',
    { expectRows: true }
  );
  checks.push(`production currently holds ${counts.listings} listing(s) and ${counts.photos} photo row(s)`);

  return checks;
}

// ------------------------------------------------------------------ main

async function main() {
  assertRepoRoot();

  const args = process.argv.slice(2);
  const production = args.includes('--production');
  const execute = args.includes('--execute');

  // --- flag guards, before anything reads or writes anything -------------
  //
  // Local mode keeps its original hard refusal: no remote target exists for
  // it at all. Production mode is opt-in, and even then read-only unless a
  // SECOND, separate flag says otherwise — one typo can never write to the
  // live database.
  if (!production && args.some((a) => a === '--linked' || a.startsWith('--project-ref'))) {
    throw new Error(
      'REFUSING TO RUN: this importer is local-only unless --production is passed, and it has no --linked/--project-ref option in either mode. ' +
        `The production target is fixed at ${PRODUCTION_PROJECT_REF}.`
    );
  }
  if (args.some((a) => a === '--linked' || a.startsWith('--project-ref'))) {
    throw new Error(
      `REFUSING TO RUN: --linked/--project-ref are not accepted. In --production mode the target is fixed at ${PRODUCTION_PROJECT_REF} and verified by preflight.`
    );
  }
  if (execute && !production) {
    throw new Error('REFUSING TO RUN: --execute is only meaningful with --production. For a local import use --yes.');
  }
  if (production && args.includes('--yes')) {
    throw new Error('REFUSING TO RUN: --yes is the LOCAL write flag. A production import is --production --execute, nothing else.');
  }

  const statusOnly = args.includes('--status');
  const backfillLabels = args.includes('--backfill-location-labels');
  if (production && backfillLabels) {
    throw new Error('REFUSING TO RUN: --backfill-location-labels is local-only.');
  }
  const fileArg = args.find((a) => a.startsWith('--file='));
  const xlsxPath = fileArg ? fileArg.slice('--file='.length) : DEFAULT_XLSX;

  // Local mode writes when --yes is given; production mode writes only when
  // BOTH --production and --execute are given.
  const apply = production ? execute : args.includes('--yes');

  const state = loadState();
  // A place_id imported locally has NOT been imported to production, and
  // vice versa — so each environment gets its own namespace in the state
  // file. `entries` stays exactly where it was (local), so existing state
  // needs no migration.
  const entries = entriesFor(state, production);

  if (statusOnly) {
    const list = Object.values(entries);
    console.log(`State file: ${STATE_FILE}`);
    console.log(`Environment: ${production ? 'PRODUCTION' : 'local'}`);
    console.log(`Imported so far: ${list.length}`);
    for (const e of list) {
      console.log(`  ${e.name} (${e.place_id}) -> listing ${e.listing_id}, ${e.photos?.length ?? 0} photo(s), ${e.imported_at}`);
    }
    return;
  }

  let apiUrl;
  let container = null;
  let storage;
  let preflight = [];

  if (production) {
    DB_TARGET_FLAG = '--linked';
    apiUrl = PRODUCTION_API_URL;
    console.log('Running production preflight...');
    preflight = assertProductionTarget();
    for (const line of preflight) console.log(`  ok: ${line}`);
    console.log('');
    storage = productionStorageAdapter();
  } else {
    const projectId = readProjectId();
    container = assertLocalStackRunning(projectId);
    const localConfig = readLocalStackConfig();
    apiUrl = localConfig.apiUrl;
    storage = localStorageAdapter(localConfig.apiUrl, localConfig.serviceKey);
  }

  const olaApiKey = readOlaApiKey();

  // Backfill for listings imported before this script resolved addresses at
  // all (their location_label went in as null). Only ever touches rows this
  // importer created — it walks its own state file and matches on the
  // recorded listing_id — and only ever fills a label that is currently
  // null, so it can't overwrite anything a human has since corrected.
  if (backfillLabels) {
    if (!olaApiKey) throw new Error('No OLA API key found — cannot resolve addresses. Set OLA_MAPS_API_KEY, or leave EXPO_PUBLIC_OLA_MAPS_API_KEY / VITE_OLA_MAPS_API_KEY in the app .env files.');
    const backfillTargets = Object.values(entries);
    console.log(`Backfilling location_label for ${backfillTargets.length} imported listing(s) on ${apiUrl}...\n`);

    let filled = 0;
    for (const entry of backfillTargets) {
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
  console.log(`Environment : ${production ? '*** PRODUCTION *** (' + PRODUCTION_PROJECT_REF + ')' : 'local'}`);
  console.log(
    `Mode        : ${
      apply
        ? production
          ? 'PRODUCTION IMPORT (writing to the live database)'
          : 'IMPORT (writing)'
        : production
          ? 'DRY RUN (mandatory first step; zero writes) — add --execute to import'
          : 'DRY RUN (nothing will be written)'
    }`
  );
  console.log(`Spreadsheet : ${xlsxPath}`);
  console.log(`Target      : ${apiUrl}${container ? `  [local container ${container}]` : ''}`);
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
    const prior = entries[placeId];
    if (prior?.listing_id && existing.some((e) => e.id === prior.listing_id)) {
      skippedAlready.push({ kind: 'state', excelRow, name, place_id: placeId, reason: `already imported as listing ${prior.listing_id}` });
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
        kind: 'live-exact',
        excelRow,
        name,
        place_id: placeId,
        reason: `a listing with this name and location already exists in the target database (${exact.id})`,
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
      skippedAlready.push({ kind: 'live-risk', excelRow, name, place_id: placeId, reason: `possible duplicate of ${detail} — needs a human decision` });
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

  const alreadyByState = skippedAlready.filter((s) => s.kind === 'state');
  const alreadyLive = skippedAlready.filter((s) => s.kind !== 'state');

  console.log(`Rows checked                        : ${rows.length}`);
  console.log(`Qualifying ("${QUALIFY_COLUMN}" = Yes) : ${toImport.length + skippedAlready.length}`);
  console.log(`  -> will be inserted               : ${toImport.length}`);
  console.log(`  -> already imported (state file)  : ${alreadyByState.length}`);
  console.log(`  -> already present / duplicate risk (live database) : ${alreadyLive.length}`);
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

  // Everything this run would change, counted before anything is written.
  // Each listing costs one statement (the listing row and all of its photo
  // rows go in together as a single data-modifying CTE), and each photo
  // costs one storage PUT — minus any object already present, which a
  // resumed run skips.
  const totalPhotos = toImport.reduce((sum, c) => sum + c.photos.length, 0);
  console.log('-'.repeat(72));
  console.log('PLANNED WRITES');
  console.log(`  listings to insert                : ${toImport.length}`);
  console.log(`  listing_photos rows to insert     : ${totalPhotos}`);
  console.log(`  photo files to upload to storage  : ${totalPhotos}`);
  console.log(`  database write statements         : ${toImport.length}  (one atomic statement per listing)`);
  console.log(`  storage write operations          : ${totalPhotos}`);
  console.log(`  TOTAL writes                      : ${toImport.length + totalPhotos}`);
  console.log(`  existing rows modified            : 0  (this importer only ever INSERTs)`);
  console.log(`  is_hidden on every new listing    : true  (never unhidden automatically)`);
  console.log('-'.repeat(72));
  console.log('');

  if (!apply) {
    console.log(
      production
        ? `DRY RUN — ZERO writes performed. To import for real, re-run the identical command with --execute added:
` +
          `  node tools/discovery/import-excel.mjs --production --execute`
        : 'DRY RUN — nothing was written. Re-run with --yes to import.'
    );
    return;
  }
  if (toImport.length === 0) {
    console.log('Nothing to import.');
    return;
  }

  // Read once per run, not once per row — an admin flipping the setting
  // mid-run is an edge case not worth chasing, and reading it up front
  // means every listing in a single run gets consistent treatment.
  const [settingsRow] = runSql("select value from admin_settings where key = 'import_default_reviewed';", { expectRows: true });
  const autoReview = settingsRow?.value === true;
  console.log(
    `import_default_reviewed = ${autoReview} -> new listings will be ${autoReview ? 'marked reviewed automatically' : 'left unreviewed (require manual review)'}\n`
  );

  for (const candidate of toImport) {
    console.log(`Importing ${candidate.name}...`);

    // Photos first: a listing is only ever written with photo_url already
    // pointing at a real object, so there is no window in which a listing
    // advertises a photo that isn't there.
    const uploaded = [];
    for (const photo of candidate.photos) {
      const storagePath = storagePathFor(candidate.place_id, photo.filename);
      const url = storage.publicUrlFor(storagePath);
      if (await storage.objectExists(storagePath)) {
        console.log(`  photo already in storage, skipping upload: ${photo.filename}`);
        uploaded.push({ ...photo, storagePath, url, reused: true });
        continue;
      }
      const result = await storage.uploadPhoto(photo, storagePath);
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
    // listing, every one of its photo rows, and its audit log entry still
    // land together or not at all.
    //
    // Every row this script creates is explicitly tagged as discovery-
    // pipeline provenance (source/actor_type/actor_label) rather than
    // falling through to the schema's 'user'/'user' defaults, which would
    // misrepresent an automated import as an organic user submission —
    // see 0013_admin_v2_provenance_and_audit.sql. The admin_audit_log row
    // uses the same 'discovery-pipeline' actor_label (not a fabricated
    // admin email — this script has no OAuth identity to attribute to);
    // `before_state` is null since this is a create, not an edit.
    //
    // reviewed_at/reviewed_by follow the import_default_reviewed setting
    // read above (0014_admin_review_state_and_settings.sql) — left null
    // (require manual review, the default) unless an admin has explicitly
    // opted in to auto-reviewing imports. When auto-reviewing, reviewed_by
    // is the same 'discovery-pipeline' label as the rest of this row's
    // provenance, never a fabricated admin identity.
    const insertListing =
      `insert into listings (created_by, name, note, price_rupees, latitude, longitude, city, location_label, photo_url, is_hidden, source, actor_type, actor_label, reviewed_at, reviewed_by) ` +
      `values (${sqlString(SEED_USER_ID)}, ${sqlString(candidate.name)}, ${sqlString(candidate.note)}, ${candidate.price}, ` +
      `${candidate.latitude}, ${candidate.longitude}, ${sqlString(CITY)}, ${sqlString(locationLabel)}, ` +
      `${uploaded.length ? sqlString(uploaded[0].url) : 'null'}, true, 'import', 'discovery_pipeline', 'discovery-pipeline', ` +
      `${autoReview ? 'now()' : 'null'}, ${autoReview ? sqlString('discovery-pipeline') : 'null'}) ` +
      `returning *`;

    const photoValues = uploaded.map((p, i) => `(${sqlString(p.url)}, ${sqlString(p.storagePath)}, ${i})`).join(', ');
    const auditInsert =
      `insert into admin_audit_log (actor_type, actor_label, action, target_type, target_id, before_state, after_state) ` +
      `select 'discovery_pipeline', 'discovery-pipeline', 'import', 'listing', ins.id, null, to_jsonb(ins.*) from ins`;

    const sql = uploaded.length
      ? `with ins as (${insertListing}), ` +
        `photos_ins as (` +
        `insert into listing_photos (listing_id, photo_url, storage_path, position) ` +
        `select ins.id, v.url, v.path, v.pos from ins, (values ${photoValues}) as v(url, path, pos) returning 1` +
        `) ` +
        `${auditInsert};`
      : `with ins as (${insertListing}) ${auditInsert};`;
    runSql(sql);

    const [inserted] = runSql(
      `select id, is_hidden from listings where created_by = ${sqlString(SEED_USER_ID)} ` +
        `and name = ${sqlString(candidate.name)} order by created_at desc limit 1;`,
      { expectRows: true }
    );
    if (!inserted?.id) throw new Error(`Insert of "${candidate.name}" reported success but the row could not be read back.`);

    entries[candidate.place_id] = {
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
    entries[candidate.place_id].environment = production ? 'production' : 'local';
    state.source_file = xlsxPath;
    saveState(state);

    console.log(`  listing ${inserted.id} created (is_hidden=${inserted.is_hidden}), ${uploaded.length} photo row(s)\n`);
  }

  console.log('='.repeat(72));
  console.log(`Imported ${toImport.length} listing(s) into ${production ? 'PRODUCTION' : 'the local stack'}. State: ${STATE_FILE}`);
  console.log('Everything is is_hidden = true — nothing is visible in the app until someone unhides it deliberately.');
  console.log('='.repeat(72));
}

// Only run when invoked as a script. Importing this module (the storage
// adapter smoke test does exactly that, to exercise the real production
// adapter against the local stack instead of testing a copy of it) must not
// kick off an import as a side effect.
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}

export { productionStorageAdapter, storageList, minPriceFrom, supabaseSpawn, resolveSupabaseCli };
