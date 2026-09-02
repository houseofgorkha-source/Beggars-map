// Beggars Map — Phase 1.8: builds the prioritized city-wide verification
// queue (the BEST 30 candidates) from the existing 127-candidate discovery
// dataset. LOCAL, READ-ONLY: makes no Google API calls, touches no
// Supabase, imports nothing, writes only a new
// tools/discovery/output/verification-queue-*.json (+ .csv) — the original
// candidates-*.json and price-verification-*.json are never modified.
//
// Nothing here is ever labeled HUMAN_VERIFIED_LE_100 — that status can
// only be produced by a real person running verify-queue.mjs themselves.
// Every candidate in this queue starts at most at QUALIFIES_PENDING_HUMAN_REVIEW.
//
// Usage: node tools/discovery/build-queue.mjs [--count=30]

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(HERE, 'output');
const DEFAULT_COUNT = 30;

// The 9 states this queue must distinguish (per spec) — DISCOVERED and
// RESEARCHED/EVIDENCE_FOUND/MATCH_UNCERTAIN/PRICE_UNKNOWN/PRICE_ABOVE_100/
// QUALIFIES_PENDING_HUMAN_REVIEW can all be produced by research (agent or
// human); only a real verify-queue.mjs session run by an actual person can
// ever produce HUMAN_VERIFIED_LE_100 or REJECTED — never this script.
const EVIDENCE_STATUSES = [
  'DISCOVERED',
  'RESEARCHED',
  'EVIDENCE_FOUND',
  'MATCH_UNCERTAIN',
  'PRICE_UNKNOWN',
  'QUALIFIES_PENDING_HUMAN_REVIEW',
  'HUMAN_VERIFIED_LE_100',
  'PRICE_ABOVE_100',
  'REJECTED',
];

// Strong signal: names/types closely associated with a complete affordable
// meal (per the expanded Phase 1.8 discovery-priority list). Weak signal:
// generic restaurant/food words that could be anything.
const STRONG_MEAL_KEYWORDS = [
  'darshini', 'tiffin', 'mess', 'thali', 'bhojanalaya', 'military hotel', 'udupi', 'canteen', 'meals', 'biryani', 'upahar', 'upahara', 'thindi',
];
const WEAK_FOOD_KEYWORDS = ['restaurant', 'cafe', 'coffee', 'hotel', 'kitchen', 'bhavan', 'dosa'];

const BRAND_STOPWORDS = new Set(['new', 'sri', 'shree', 'hotel', 'restaurant', 'the', 'and', 'pure', 'veg', 'grand', 'food', 'hub']);

function latestFile(prefix) {
  if (!existsSync(OUTPUT_DIR)) return null;
  const files = readdirSync(OUTPUT_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort();
  return files.length ? join(OUTPUT_DIR, files[files.length - 1]) : null;
}

function loadCandidates() {
  const path = latestFile('candidates-');
  if (!path) throw new Error('No candidates-*.json found. Run discover.mjs first.');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  return { path, candidates: data.candidates ?? data };
}

function loadPriorEvidence() {
  const path = latestFile('price-verification-');
  const byPlaceId = new Map();
  if (!path) return { path: null, byPlaceId };
  const data = JSON.parse(readFileSync(path, 'utf8'));
  for (const r of data.records ?? []) byPlaceId.set(r.place_id, r);
  return { path, byPlaceId };
}

// Maps the Phase 1.5-era 6-status research model onto the new 9-state
// vocabulary. Crucially: the old script's "VERIFIED_LE_100" was an
// AGENT/research finding, never a real human decision — it becomes
// QUALIFIES_PENDING_HUMAN_REVIEW here, never HUMAN_VERIFIED_LE_100.
function mapLegacyStatus(oldStatus) {
  switch (oldStatus) {
    case 'VERIFIED_LE_100':
      return 'QUALIFIES_PENDING_HUMAN_REVIEW';
    case 'PRICE_FOUND_ABOVE_100':
      return 'PRICE_ABOVE_100';
    case 'SOURCE_UNAVAILABLE':
      return 'RESEARCHED'; // attempted, nothing usable found
    case 'UNVERIFIED':
      return 'EVIDENCE_FOUND'; // some evidence exists, not decisive
    case 'MATCH_UNCERTAIN':
    case 'PRICE_UNKNOWN':
      return oldStatus; // names already match the new vocabulary
    default:
      return 'DISCOVERED';
  }
}

function normalizeAddr(a) {
  return (a || '').toLowerCase();
}

function brandKey(name) {
  const tokens = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !BRAND_STOPWORDS.has(t) && !/^\d+(st|nd|rd|th)?$/.test(t));
  return tokens.slice(0, 2).join(' ') || name.toLowerCase();
}

function likelyMealType(candidate) {
  const text = `${candidate.name} ${candidate.primary_type ?? ''} ${(candidate.types ?? []).join(' ')}`.toLowerCase();
  if (text.includes('biryani')) return 'SUBSTANTIAL_SINGLE_DISH (biryani)';
  if (text.includes('thali')) return 'THALI';
  if (text.includes('mess') || text.includes('bhojanalaya') || text.includes('military hotel') || text.includes('canteen') || text.includes('meals')) return 'MEAL';
  // darshini/udupi/upahar/thindi-style eateries typically serve BOTH
  // breakfast tiffin items AND lunch meals in Bengaluru — don't commit to
  // just BREAKFAST for these, that would understate what research might find.
  if (text.includes('darshini') || text.includes('udupi') || text.includes('upahar') || text.includes('thindi')) return 'BREAKFAST/MEAL (darshini-style, likely serves both)';
  if (text.includes('tiffin') || text.includes('dosa')) return 'BREAKFAST';
  return 'UNKNOWN — needs research';
}

function scoreCandidate(candidate, evidence) {
  const reasons = [];
  let score = 0;
  if (candidate.google_price_level === 'PRICE_LEVEL_INEXPENSIVE') {
    score += 3;
    reasons.push('Google INEXPENSIVE signal (a hint only, not proof)');
  }
  const text = `${candidate.name} ${candidate.primary_type ?? ''} ${(candidate.types ?? []).join(' ')}`.toLowerCase();
  const strongHit = STRONG_MEAL_KEYWORDS.find((k) => text.includes(k));
  if (strongHit) {
    score += 3;
    reasons.push(`strong complete-meal keyword match ("${strongHit}")`);
  } else if (WEAK_FOOD_KEYWORDS.some((k) => text.includes(k))) {
    score += 1;
    reasons.push('generic restaurant/food-type match');
  }
  if (evidence) {
    score += 2;
    reasons.push(`prior Phase 1.5 research exists (${mapLegacyStatus(evidence.status)})`);
    if (evidence.status === 'VERIFIED_LE_100') {
      score += 3;
      reasons.push('prior research found qualifying complete-meal evidence — ready for human review');
    }
  }
  return { score, reasons };
}

function searchLink(name, address, site) {
  const q = encodeURIComponent(`${name} ${address}${site ? ` site:${site}` : ''}`);
  return `https://www.google.com/search?q=${q}`;
}

function selectQueue(candidates, evidenceByPlaceId, count) {
  const scored = candidates.map((c) => ({ candidate: c, evidence: evidenceByPlaceId.get(c.place_id) ?? null, ...scoreCandidate(c, evidenceByPlaceId.get(c.place_id)) }));
  scored.sort((a, b) => b.score - a.score);

  const AREA_SOFT_CAP = Math.ceil((count / 4) * 1.5); // 4 areas currently have data; see report for the geographic-coverage caveat
  const BRAND_CAP = 2;

  const selected = [];
  const areaCounts = new Map();
  const brandCounts = new Map();

  for (const entry of scored) {
    if (selected.length >= count) break;
    const area = entry.candidate.discovery_sources[0]?.area ?? 'unknown';
    const brand = brandKey(entry.candidate.name);
    const areaCount = areaCounts.get(area) ?? 0;
    const brandCount = brandCounts.get(brand) ?? 0;
    if (areaCount >= AREA_SOFT_CAP || brandCount >= BRAND_CAP) continue;
    selected.push(entry);
    areaCounts.set(area, areaCount + 1);
    brandCounts.set(brand, brandCount + 1);
  }

  // Backfill if area/brand caps left the queue short of `count` (relax caps).
  if (selected.length < count) {
    for (const entry of scored) {
      if (selected.length >= count) break;
      if (selected.includes(entry)) continue;
      selected.push(entry);
    }
  }

  return { selected, areaCounts };
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(records) {
  const headers = ['place_id', 'name', 'zone', 'area', 'address', 'latitude', 'longitude', 'google_price_level', 'likely_meal_type', 'evidence_status', 'human_verification_status', 'why_prioritized'];
  const lines = [headers.join(',')];
  for (const r of records) {
    lines.push(
      [r.place_id, r.name, r.zone, r.area, r.address, r.latitude, r.longitude, r.google_price_level, r.likely_meal_type, r.evidence_status, r.human_verification_status, r.why_prioritized]
        .map(csvEscape)
        .join(',')
    );
  }
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const countArg = args.find((a) => a.startsWith('--count='));
  const count = countArg ? Number(countArg.split('=')[1]) : DEFAULT_COUNT;

  const { path: candidatesPath, candidates } = loadCandidates();
  const { path: evidencePath, byPlaceId: evidenceByPlaceId } = loadPriorEvidence();

  // Zone lookup by area name — mirrors config.mjs's AREAS metadata, kept
  // local here to avoid this read-only report script depending on the
  // discovery-time area list (a candidate's discovery_sources already
  // records the literal area name it was found under).
  const AREA_ZONES = {
    Koramangala: 'South', Indiranagar: 'Northeast', Jayanagar: 'South', Malleswaram: 'Central',
  };

  const { selected, areaCounts } = selectQueue(candidates, evidenceByPlaceId, count);

  const records = selected.map(({ candidate, evidence, score, reasons }) => {
    const area = candidate.discovery_sources[0]?.area ?? 'unknown';
    const legacyStatus = evidence ? mapLegacyStatus(evidence.status) : 'DISCOVERED';
    const researchStatus = evidence ? 'RESEARCHED' : 'DISCOVERED';

    return {
      place_id: candidate.place_id,
      name: candidate.name,
      address: candidate.formatted_address,
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      google_price_level: candidate.google_price_level, // SIGNAL ONLY — never proof of ≤₹100
      area,
      zone: AREA_ZONES[area] ?? 'unknown',
      food_type: candidate.primary_type,
      why_prioritized: `score ${score}: ${reasons.join('; ') || 'baseline (no strong signal)'}`,
      likely_meal_type: likelyMealType(candidate), // heuristic guess for triage only — NOT a qualification
      research_status: researchStatus,
      evidence_status: legacyStatus,
      existing_evidence: evidence
        ? {
            qualifying_item: evidence.qualifying_item,
            price_rupees: evidence.price_rupees,
            found_items: evidence.found_items,
            match_confidence: evidence.match_confidence,
            evidence_source_url: evidence.evidence_source_url,
            confidence_notes: evidence.confidence_notes,
          }
        : null,
      candidate_source_links: {
        google: searchLink(candidate.name, candidate.formatted_address),
        zomato: searchLink(candidate.name, candidate.formatted_address, 'zomato.com'),
        swiggy: searchLink(candidate.name, candidate.formatted_address, 'swiggy.com'),
        justdial: searchLink(candidate.name, candidate.formatted_address, 'justdial.com'),
      },
      image_links: [], // not collected in this batch-selection pass — see report
      human_verification_status: null, // NEVER set by this script — only a real verify-queue.mjs session can set this
    };
  });

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(OUTPUT_DIR, `verification-queue-${timestamp}.json`);
  const csvPath = join(OUTPUT_DIR, `verification-queue-${timestamp}.csv`);

  const zoneCoverage = {};
  for (const r of records) zoneCoverage[r.zone] = (zoneCoverage[r.zone] ?? 0) + 1;
  const mealTypeCoverage = {};
  for (const r of records) mealTypeCoverage[r.likely_meal_type] = (mealTypeCoverage[r.likely_meal_type] ?? 0) + 1;
  const evidenceStatusCoverage = {};
  for (const r of records) evidenceStatusCoverage[r.evidence_status] = (evidenceStatusCoverage[r.evidence_status] ?? 0) + 1;

  const output = {
    run: {
      source_candidates_file: candidatesPath,
      source_evidence_file: evidencePath,
      selected_count: records.length,
      requested_count: count,
      area_coverage: Object.fromEntries(areaCounts),
      zone_coverage: zoneCoverage,
      likely_meal_type_coverage: mealTypeCoverage,
      evidence_status_coverage: evidenceStatusCoverage,
      geographic_coverage_caveat:
        'The 127-candidate source dataset only covers 4 areas (Koramangala, Indiranagar, Jayanagar, Malleswaram — South/Central Bengaluru). ' +
        'This queue cannot include genuine North/East/West/far-South representation until a wider discovery pass runs — see chat report.',
      generated_at: new Date().toISOString(),
    },
    candidates: records,
  };

  writeFileSync(jsonPath, JSON.stringify(output, null, 2), 'utf8');
  writeFileSync(csvPath, toCsv(records), 'utf8');

  console.log('=== VERIFICATION QUEUE BUILT — LOCAL ONLY, NO DB TOUCHED, NO API CALLS MADE ===');
  console.log(`Selected: ${records.length} of ${candidates.length} candidates`);
  console.log(`Area coverage: ${JSON.stringify(Object.fromEntries(areaCounts))}`);
  console.log(`Zone coverage: ${JSON.stringify(zoneCoverage)}`);
  console.log(`Likely meal type coverage: ${JSON.stringify(mealTypeCoverage)}`);
  console.log(`Evidence status coverage: ${JSON.stringify(evidenceStatusCoverage)}`);
  console.log(`Output written: ${jsonPath}`);
  console.log(`                ${csvPath}`);
}

main();
