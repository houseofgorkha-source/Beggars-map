/**
 * Beggars Map Sitemap Generator
 *
 * Runs at build time (Vercel deploy or local `npm run build:sitemap`):
 * 1. Fetches production listings from Supabase
 * 2. Extracts unique cuisines, dishes, meal types, localities, price ranges
 *    for every listing, via the SAME logic the live app uses at runtime
 *    (imported directly from web/src/lib/extractDimensions.ts — no
 *    duplicated keyword tables here; Node's native TS type-stripping, the
 *    same mechanism tests/*.test.mjs already relies on, makes this a plain
 *    import rather than a build step).
 * 3. Counts listings per single dimension AND per real multi-dimension
 *    combination (see tools/build/combinationDiscovery.mjs) — combinations
 *    are discovered from listings' own actual tag sets, never a blind
 *    Cartesian product of every theoretically possible value.
 * 4. Only includes a dimension or combination with >=3 matching listings
 *    (no thin pages).
 * 5. Generates sitemap.xml with priority scoring.
 *
 * Output: web/public/sitemap.xml
 */

import { createClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { buildDimensionIndex, extractListingTags, PRICE_BANDS } from '../../web/src/lib/extractDimensions.ts';
import { discoverCombinations, DIMENSION_TO_PARAM } from './combinationDiscovery.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const OUTPUT_PATH = join(REPO_ROOT, 'web', 'public', 'sitemap.xml');

const MIN_LISTINGS_FOR_INDEX = 3;
// Multi-dimension combinations: 2 dimensions minimum (a single dimension is
// already covered by the plain per-dimension loops below); capped at 3 —
// not because 4+ dimension combinations are disallowed by design, but
// because discoverCombinations only ever proposes a candidate that some
// real listing actually embodies, and at today's listing count a 4-way
// intersection clearing >=3 matches is not something the real dataset
// supports (confirmed empirically at generation time below, not assumed).
// Raising this cap later is safe and requires no other code change — the
// algorithm scales with whatever the data actually supports.
const MAX_COMBINATION_SIZE = 3;

// Supabase config — use production URLs from env or .env.local
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://nvingzluboafxzxgxxwc.supabase.co';
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';

if (!SUPABASE_ANON_KEY) {
  console.error('Error: VITE_SUPABASE_ANON_KEY not set. Set in environment or web/.env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---- Priority Scoring ----

function calculatePriority(count, totalListings) {
  // Fewer listings within a filter = higher priority (rarer, more specific)
  // More listings = lower priority (common, broad)
  // Range: 0.3 to 0.9. Rounded to 2 decimals — at today's listing counts
  // (dozens, not thousands), 1-decimal rounding collapsed every realistic
  // count into the same 0.7, making the scoring scheme a no-op in practice.
  const basePriority = 0.8 - (0.2 * Math.log(count)) / Math.log(totalListings);
  return Math.max(0.3, Math.min(0.9, Math.round(basePriority * 100) / 100));
}

// ---- URL Building ----

function buildQueryString(params) {
  // params: array of [paramName, value], in a stable order.
  const sp = new URLSearchParams();
  for (const [name, value] of params) sp.set(name, value);
  return sp.toString();
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---- XML Generation ----

function generateSitemapXML(urls) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

  for (const url of urls) {
    xml += '  <url>\n';
    xml += `    <loc>${escapeXml(url.loc)}</loc>\n`;
    xml += `    <changefreq>${url.changefreq}</changefreq>\n`;
    xml += `    <priority>${url.priority}</priority>\n`;
    xml += '  </url>\n';
  }

  xml += '</urlset>\n';
  return xml;
}

// ---- Main ----

async function main() {
  console.log('Generating sitemap...');

  // Fetch listings from production
  console.log(`Connecting to Supabase (${SUPABASE_URL})`);
  // Must specify columns explicitly because anon key only has column-level SELECT
  // on the public columns (0017_public_data_boundary.sql), not table-level SELECT
  // — '*' fails outright, and so does filtering on a column the anon key has no
  // grant on at all (is_hidden is admin-only). RLS already restricts anon SELECT
  // to non-hidden rows on its own, so no explicit is_hidden filter is needed here.
  const { data: listings, error } = await supabase
    .from('listings')
    .select('id,created_by,name,note,price_rupees,photo_url,latitude,longitude,city,created_at,location_label,dishes,rating')
    .limit(2000);

  if (error || !listings) {
    console.error('Failed to fetch listings:', error?.message || 'Unknown error');
    process.exit(1);
  }

  console.log(`Fetched ${listings.length} listings`);
  const totalListings = listings.length;

  // ---- Single-dimension index (unchanged shape, now driven by the shared
  // extraction module — including cumulative price bands) ----
  console.log('Extracting single-dimension index...');
  const index = buildDimensionIndex(listings);

  console.log('Dimension counts (all real listings, before threshold):');
  console.log(`  - Cuisines: ${Object.keys(index.cuisines).length}`);
  console.log(`  - Meal types: ${Object.keys(index.mealTypes).length}`);
  console.log(`  - Dishes: ${Object.keys(index.dishes).length}`);
  console.log(`  - Localities: ${Object.keys(index.localities).length}`);
  console.log(`  - Price bands (cumulative): ${PRICE_BANDS.map((b) => `${b}:${index.priceRanges[b] ?? 0}`).join(', ')}`);

  const urls = [];

  // Homepage
  urls.push({ loc: 'https://www.beggarsmap.com/', changefreq: 'daily', priority: 1.0 });

  const singleDimAccepted = [];
  const singleDimRejected = [];

  function addSingleDim(dimName, paramName, entries) {
    for (const [value, count] of Object.entries(entries)) {
      if (count >= MIN_LISTINGS_FOR_INDEX) {
        urls.push({
          loc: `https://www.beggarsmap.com/?${paramName}=${encodeURIComponent(value)}`,
          changefreq: 'weekly',
          priority: calculatePriority(count, totalListings),
        });
        singleDimAccepted.push({ dim: dimName, value, count });
      } else {
        singleDimRejected.push({ dim: dimName, value, count });
      }
    }
  }

  addSingleDim('cuisine', 'cuisine', index.cuisines);
  addSingleDim('mealType', 'mealType', index.mealTypes);
  addSingleDim('dish', 'dish', index.dishes);
  addSingleDim('locality', 'location', index.localities);
  addSingleDim('price', 'price', index.priceRanges);

  // ---- Multi-dimension combinations ----
  console.log('\nDiscovering real multi-dimension combinations...');
  const taggedListings = listings.map((listing) => ({ listing, tags: extractListingTags(listing) }));
  const combinationResults = discoverCombinations(taggedListings, {
    minSize: 2,
    maxSize: MAX_COMBINATION_SIZE,
    minMatches: MIN_LISTINGS_FOR_INDEX,
  });

  for (const { combo, count } of combinationResults) {
    // Canonical param order (DIMENSION_ORDER inside combinationDiscovery.mjs
    // already sorted the combo when it built the key, but re-derive here
    // from DIMENSION_TO_PARAM directly for URL construction, independent of
    // that module's internals).
    const params = combo.map(({ dim, value }) => [DIMENSION_TO_PARAM[dim], value]);
    const qs = buildQueryString(params);
    urls.push({
      loc: `https://www.beggarsmap.com/?${qs}`,
      changefreq: 'weekly',
      priority: calculatePriority(count, totalListings),
    });
  }

  console.log(`Found ${combinationResults.length} qualifying combination(s) (>=${MIN_LISTINGS_FOR_INDEX} real matching listings, size 2-${MAX_COMBINATION_SIZE}).`);

  // ---- Report: accepted and rejected (near-threshold especially) ----
  console.log('\n=== Single-dimension: accepted ===');
  for (const a of singleDimAccepted) console.log(`  ${a.dim}=${a.value} -> ${a.count} listings`);

  console.log('\n=== Single-dimension: rejected (< 3 matches) ===');
  const nearThresholdSingle = singleDimRejected.filter((r) => r.count === 2 || r.count === 1);
  for (const r of nearThresholdSingle) console.log(`  ${r.dim}=${r.value} -> ${r.count} listing(s) (rejected)`);
  console.log(`  (+ ${singleDimRejected.length - nearThresholdSingle.length} more with 0 matches, not listed individually)`);

  console.log('\n=== Multi-dimension: accepted ===');
  for (const { combo, count } of combinationResults) {
    const label = combo.map((c) => `${DIMENSION_TO_PARAM[c.dim]}=${c.value}`).join(' & ');
    console.log(`  ${label} -> ${count} listings`);
  }

  // Report near-threshold REJECTED combinations too (candidates that were
  // proposed by a real listing but didn't clear the bar) — recompute with a
  // lower minMatches to surface what got excluded, for transparency.
  const allCandidates = discoverCombinations(taggedListings, { minSize: 2, maxSize: MAX_COMBINATION_SIZE, minMatches: 1 });
  const rejectedCombos = allCandidates.filter((c) => c.count < MIN_LISTINGS_FOR_INDEX && c.count >= 2);
  console.log('\n=== Multi-dimension: rejected, near-threshold (exactly 2 real matches) ===');
  if (rejectedCombos.length === 0) {
    console.log('  (none)');
  } else {
    for (const { combo, count } of rejectedCombos) {
      const label = combo.map((c) => `${DIMENSION_TO_PARAM[c.dim]}=${c.value}`).join(' & ');
      console.log(`  ${label} -> ${count} listings (rejected)`);
    }
  }

  // ---- Sanity check: no 'nearby'/near-me param ever enters the sitemap ----
  const hasNearby = urls.some((u) => /nearby|near-me|near_me/i.test(u.loc));
  if (hasNearby) {
    console.error('FATAL: a near-me/nearby URL was about to be written to the sitemap. Aborting.');
    process.exit(1);
  }

  // Generate sitemap
  console.log('\nGenerating XML...');
  const xml = generateSitemapXML(urls);

  // Write to file
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, xml, 'utf8');

  console.log(`Wrote ${urls.length} URLs to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
