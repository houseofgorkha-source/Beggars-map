// Beggars Map — read-only analysis/report generator for a discover.mjs
// output file. Computes geographic/category/price-level breakdowns that
// discover.mjs's own run summary doesn't include. Makes no API calls,
// touches no Supabase, writes nothing — prints a report to stdout only.
//
// Usage: node tools/discovery/analyze-dataset.mjs <path-to-candidates.json>

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AREAS } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(HERE, 'output');

const AREA_ZONE = Object.fromEntries(AREAS.map((a) => [a.name, a.zone]));

function latestCandidatesFile() {
  const files = readdirSync(OUTPUT_DIR)
    .filter((f) => f.startsWith('candidates-') && f.endsWith('.json'))
    .sort();
  return files.length ? join(OUTPUT_DIR, files[files.length - 1]) : null;
}

function count(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedEntries(map) {
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));
}

function main() {
  const inputPath = process.argv[2] || latestCandidatesFile();
  if (!inputPath || !existsSync(inputPath)) throw new Error(`No candidates file found at ${inputPath}.`);
  const data = JSON.parse(readFileSync(inputPath, 'utf8'));
  const candidates = data.candidates ?? data;

  const byPriceLevel = new Map();
  const byZone = new Map();
  const byArea = new Map();
  const byPrimaryType = new Map();
  const byCategory = new Map(); // counts a candidate once per distinct discovering category
  const zonesRepresented = new Set();

  for (const c of candidates) {
    count(byPriceLevel, c.google_price_level ?? 'UNSET');
    count(byPrimaryType, c.primary_type ?? 'unknown');

    const areasForThisCandidate = new Set();
    const categoriesForThisCandidate = new Set();
    for (const s of c.discovery_sources) {
      areasForThisCandidate.add(s.area);
      categoriesForThisCandidate.add(s.query);
    }
    for (const area of areasForThisCandidate) {
      count(byArea, area);
      const zone = AREA_ZONE[area] ?? 'unknown';
      zonesRepresented.add(zone);
    }
    // Zone count: count each candidate once per distinct zone it was found in
    const zonesForThisCandidate = new Set([...areasForThisCandidate].map((a) => AREA_ZONE[a] ?? 'unknown'));
    for (const zone of zonesForThisCandidate) count(byZone, zone);
    for (const category of categoriesForThisCandidate) count(byCategory, category);
  }

  const inexpensive = byPriceLevel.get('PRICE_LEVEL_INEXPENSIVE') ?? 0;
  const moderate = byPriceLevel.get('PRICE_LEVEL_MODERATE') ?? 0;
  const expensive = (byPriceLevel.get('PRICE_LEVEL_EXPENSIVE') ?? 0) + (byPriceLevel.get('PRICE_LEVEL_VERY_EXPENSIVE') ?? 0);
  const unset = byPriceLevel.get('UNSET') ?? 0;

  const ALL_ZONES = ['North', 'South', 'East', 'West', 'Central', 'Northeast', 'Northwest', 'Southeast', 'Southwest'];
  const missingZones = ALL_ZONES.filter((z) => !zonesRepresented.has(z));
  const dominantAreaShare = candidates.length > 0 ? Math.max(...byArea.values()) / candidates.length : 0;

  console.log('=== DATASET ANALYSIS (read-only, no API calls, no DB touched) ===');
  console.log(`Source: ${inputPath}`);
  console.log(`Total unique candidates: ${candidates.length}`);
  console.log();
  console.log('--- By Google price level ---');
  console.log(`  INEXPENSIVE: ${inexpensive}`);
  console.log(`  MODERATE: ${moderate}`);
  console.log(`  EXPENSIVE/VERY_EXPENSIVE: ${expensive}`);
  console.log(`  Unset/unknown: ${unset}`);
  console.log();
  console.log('--- By geographic zone (candidate counted once per zone it appeared in) ---');
  console.log(JSON.stringify(sortedEntries(byZone), null, 2));
  console.log(`Zones represented: ${[...zonesRepresented].sort().join(', ')}`);
  console.log(`Zones with ZERO candidates: ${missingZones.length ? missingZones.join(', ') : 'none — full 9-zone coverage'}`);
  console.log();
  console.log('--- By area ---');
  console.log(JSON.stringify(sortedEntries(byArea), null, 2));
  console.log(`Largest single area's share of total candidates: ${(dominantAreaShare * 100).toFixed(1)}%`);
  console.log();
  console.log('--- By primary_type (top 15) ---');
  console.log(JSON.stringify(Object.fromEntries(Object.entries(sortedEntries(byPrimaryType)).slice(0, 15)), null, 2));
  console.log();
  console.log('--- By discovery category (how many candidates each query surfaced) ---');
  console.log(JSON.stringify(sortedEntries(byCategory), null, 2));
  console.log();
  console.log('--- Genuine city-wide coverage assessment ---');
  const original4 = ['Koramangala', 'Indiranagar', 'Jayanagar', 'Malleswaram'];
  const original4Count = original4.reduce((sum, a) => sum + (byArea.get(a) ?? 0), 0);
  console.log(`Candidates touching the original 4 areas (may overlap with new areas): ${original4Count} of ${candidates.length} (${((original4Count / candidates.length) * 100).toFixed(1)}%)`);
  console.log(missingZones.length === 0 ? 'VERDICT: genuine 9-zone coverage achieved.' : `VERDICT: ${missingZones.length} zone(s) still have zero candidates — not yet full city-wide coverage.`);
}

main();
