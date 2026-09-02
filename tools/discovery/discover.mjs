// Beggars Map — local-only Google Places discovery (Phase 1: dry run).
//
// Discovers Bengaluru restaurant candidates via Google Places API (New)
// Text Search, across a configurable grid of (area, query) combinations,
// dedupes them by place_id, and writes a structured JSON + CSV report to
// tools/discovery/output/. This script NEVER touches Supabase (local or
// production) — it only ever reads from Google's API and writes local
// files. Nothing here is imported into any database automatically.
//
// Usage:
//   node tools/discovery/discover.mjs                        (small default test run)
//   node tools/discovery/discover.mjs --areas=2 --categories=3 --max-results=5
//   node tools/discovery/discover.mjs --all                  (full configured grid — many calls, use deliberately)
//
// API key resolution (checked in this order, never printed/logged/written
// anywhere — see resolveApiKey below):
//   1. GOOGLE_PLACES_API_KEY already in the process environment
//   2. GOOGLE_PLACES_API_KEY in tools/discovery/.env, if you set one up
//   3. VITE_GOOGLE_MAPS_API_KEY in web/.env — the project's existing
//      Google Maps/Places key (web/src/lib/googleMaps.ts), reused as-is.
//      This tool never creates or writes a second key anywhere.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AREAS,
  QUERY_CATEGORIES,
  SEARCH_RADIUS_METERS,
  RESULTS_PER_QUERY,
  DEFAULT_AREA_COUNT,
  DEFAULT_CATEGORY_COUNT,
  CITY,
} from './config.mjs';
import { textSearch, PlacesApiError } from './places-client.mjs';
import { dedupeHits } from './dedupe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(HERE, 'output');
const ENV_PATH = join(HERE, '.env');
const WEB_ENV_PATH = join(HERE, '..', '..', 'web', '.env');

// Minimal, local KEY=VALUE reader — deliberately not process.loadEnvFile,
// so only the one variable we ask for ever gets touched/held, and nothing
// about this parse is ever logged.
function readEnvVar(filePath, varName) {
  if (!existsSync(filePath)) return undefined;
  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== varName) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value || undefined;
  }
  return undefined;
}

// Returns { key, source } — `source` is a human-readable label only, safe
// to print; `key` itself must never be logged, written to output files, or
// embedded in source code.
function resolveApiKey() {
  if (process.env.GOOGLE_PLACES_API_KEY) {
    return { key: process.env.GOOGLE_PLACES_API_KEY, source: 'process environment (GOOGLE_PLACES_API_KEY)' };
  }
  const ownKey = readEnvVar(ENV_PATH, 'GOOGLE_PLACES_API_KEY');
  if (ownKey) return { key: ownKey, source: 'tools/discovery/.env (GOOGLE_PLACES_API_KEY)' };

  const webKey = readEnvVar(WEB_ENV_PATH, 'VITE_GOOGLE_MAPS_API_KEY');
  if (webKey) return { key: webKey, source: 'web/.env (VITE_GOOGLE_MAPS_API_KEY) — existing project key, reused' };

  return { key: undefined, source: null };
}

function parseArgs(argv) {
  const args = { areas: DEFAULT_AREA_COUNT, categories: DEFAULT_CATEGORY_COUNT, maxResults: RESULTS_PER_QUERY };
  for (const arg of argv) {
    if (arg === '--all') {
      args.areas = AREAS.length;
      args.categories = QUERY_CATEGORIES.length;
    } else if (arg.startsWith('--areas=')) {
      args.areas = Number(arg.split('=')[1]);
    } else if (arg.startsWith('--categories=')) {
      args.categories = Number(arg.split('=')[1]);
    } else if (arg.startsWith('--max-results=')) {
      args.maxResults = Number(arg.split('=')[1]);
    }
  }
  return args;
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(candidates) {
  const headers = [
    'place_id',
    'name',
    'formatted_address',
    'latitude',
    'longitude',
    'primary_type',
    'business_status',
    'google_price_level',
    'website_uri',
    'phone',
    'google_maps_uri',
    'discovery_sources',
    'verification_status',
    'verified_le_100',
  ];
  const lines = [headers.join(',')];
  for (const c of candidates) {
    const sources = c.discovery_sources.map((s) => `${s.area}:${s.query}`).join(' | ');
    lines.push(
      [
        c.place_id,
        c.name,
        c.formatted_address,
        c.latitude,
        c.longitude,
        c.primary_type,
        c.business_status,
        c.google_price_level,
        c.website_uri,
        c.phone,
        c.google_maps_uri,
        sources,
        c.verification_status,
        c.verified_le_100,
      ]
        .map(csvEscape)
        .join(',')
    );
  }
  return lines.join('\n');
}

async function main() {
  const { key: apiKey, source } = resolveApiKey();
  if (!apiKey) {
    console.error(
      '[discover] No Google Places API key found.\n' +
        `  Checked: process.env.GOOGLE_PLACES_API_KEY, ${ENV_PATH}, and ${WEB_ENV_PATH} (VITE_GOOGLE_MAPS_API_KEY).\n` +
        '  Either set one of those, or confirm web/.env has VITE_GOOGLE_MAPS_API_KEY configured.'
    );
    process.exitCode = 1;
    return;
  }
  console.log(`[discover] API key source: ${source} (value never logged).`);

  const args = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(args.areas) || args.areas < 1 || !Number.isFinite(args.categories) || args.categories < 1) {
    console.error('[discover] --areas / --categories must be positive integers.');
    process.exitCode = 1;
    return;
  }

  const areas = AREAS.slice(0, Math.min(args.areas, AREAS.length));
  const categories = QUERY_CATEGORIES.slice(0, Math.min(args.categories, QUERY_CATEGORIES.length));
  const plannedCalls = areas.length * categories.length;

  console.log(`[discover] Beggars Map discovery — dry run only. Supabase: NOT TOUCHED by this script.`);
  console.log(`[discover] City: ${CITY}. Areas: ${areas.map((a) => a.name).join(', ')}`);
  console.log(`[discover] Categories: ${categories.join(', ')}`);
  console.log(`[discover] Planned API calls: ${plannedCalls} (areas x categories), up to ${args.maxResults} results each.\n`);

  const hits = [];
  let apiCallCount = 0;
  const errors = [];
  let abortedEarly = false;

  outer: for (const area of areas) {
    for (const query of categories) {
      apiCallCount += 1;
      const label = `${query} @ ${area.name}`;
      try {
        const places = await textSearch({
          query: `${query} in ${area.name}, ${CITY}`,
          area,
          radiusMeters: SEARCH_RADIUS_METERS,
          maxResults: args.maxResults,
          apiKey,
        });
        console.log(`[discover] (${apiCallCount}/${plannedCalls}) "${label}" -> ${places.length} result(s)`);
        for (const raw of places) hits.push({ raw, area: area.name, query });
      } catch (err) {
        const message = err instanceof PlacesApiError ? err.message : `${err}`;
        console.error(`[discover] (${apiCallCount}/${plannedCalls}) "${label}" FAILED: ${message}`);
        errors.push({ area: area.name, query, error: message });

        // If the very first call fails, it's almost certainly a systemic
        // issue (key not authorized for this API, referrer/IP restriction,
        // billing not enabled) rather than a per-query fluke — every
        // remaining combo would fail identically, so stop instead of
        // burning through the rest of the grid on a known-broken key.
        if (apiCallCount === 1) {
          console.error('[discover] First call failed — aborting the rest of the grid rather than repeating the same failure.');
          abortedEarly = true;
          break outer;
        }
      }
    }
  }

  const { candidates, totalHits, duplicateHits } = dedupeHits(hits);
  const candidateList = Array.from(candidates.values());
  const withGooglePriceLevel = candidateList.filter((c) => c.google_price_level).length;
  const verifiedLe100 = candidateList.filter((c) => c.verified_le_100).length;
  const unknownPricing = candidateList.length - verifiedLe100;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(OUTPUT_DIR, `candidates-${timestamp}.json`);
  const csvPath = join(OUTPUT_DIR, `candidates-${timestamp}.csv`);

  const output = {
    run: {
      city: CITY,
      areas: areas.map((a) => a.name),
      categories,
      max_results_per_query: args.maxResults,
      api_calls_made: apiCallCount,
      api_call_errors: errors,
      aborted_early: abortedEarly,
      raw_hits: totalHits,
      duplicate_hits_merged: duplicateHits,
      unique_candidates: candidateList.length,
      generated_at: new Date().toISOString(),
    },
    candidates: candidateList,
  };

  writeFileSync(jsonPath, JSON.stringify(output, null, 2), 'utf8');
  writeFileSync(csvPath, toCsv(candidateList), 'utf8');

  console.log('\n=== DRY RUN REPORT (no database touched — see summary below) ===');
  console.log(`Google API calls made:           ${apiCallCount}${errors.length ? ` (${errors.length} failed)` : ''}`);
  console.log(`Raw place hits:                  ${totalHits}`);
  console.log(`Duplicate hits merged:           ${duplicateHits}`);
  console.log(`Unique candidates discovered:    ${candidateList.length}`);
  console.log(`  ...with a Google price_level:  ${withGooglePriceLevel}  (weak signal only — NOT rupee evidence)`);
  console.log(`  ...with verified ≤₹100 evidence: ${verifiedLe100}  (this pipeline has no price-evidence source yet — always 0 today)`);
  console.log(`  ...with unknown/unverified pricing: ${unknownPricing}`);
  console.log(`Fields retained per candidate:    ${Object.keys(candidateList[0] ?? {}).join(', ') || '(none — no candidates)'}`);
  console.log(`Output written:                   ${jsonPath}`);
  console.log(`                                  ${csvPath}`);
  console.log('\nWhat would be imported: NOTHING, automatically. This script only ever writes local');
  console.log('JSON/CSV files. Promoting a candidate to a Beggars Map listing requires manually');
  console.log('curating tools/discovery/output/approved-candidates.json (see import-approved.mjs)');
  console.log('with a verified price_rupees + price_evidence_source per entry, then explicitly');
  console.log('running the import script — which itself refuses to run against anything but a');
  console.log('local Supabase Docker stack.');
  console.log('\nSAFETY: production writes = 0, deploy = 0, push = 0. Supabase was not touched by this run.');
}

main();
