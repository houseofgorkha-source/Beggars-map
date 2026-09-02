// Beggars Map — Phase 1.10: builds the Bengaluru-wide ~200-candidate
// research queue from the existing 3,604-candidate discovery dataset.
// LOCAL, READ-ONLY: makes no Google API calls, touches no Supabase,
// imports nothing. Writes only a new
// tools/discovery/output/verification-queue-*.json (+ .csv) — the source
// discovery dataset and any prior price-verification file are never
// modified.
//
// Nothing here is ever HUMAN_VERIFIED_LE_100 — that status can only be
// produced by a real person running verify-queue.mjs themselves. Newly
// selected candidates default to RESEARCH_READY; candidates carrying prior
// Phase 1.5 research evidence keep that evidence, remapped onto the new
// state vocabulary (VERIFIED_LE_100 -> QUALIFIES_PENDING_HUMAN_REVIEW,
// never auto-promoted).
//
// Usage: node tools/discovery/build-city-queue.mjs [--count=200] [--source=path.json]

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AREAS } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(HERE, 'output');
const DEFAULT_COUNT = 200;
const ZONES = ['South', 'Central', 'East', 'West', 'North', 'Northeast', 'Northwest', 'Southeast', 'Southwest'];

const AREA_ZONE = Object.fromEntries(AREAS.map((a) => [a.name, a.zone]));

// The 9 states this queue distinguishes. Only a real human verify-queue.mjs
// session can ever produce HUMAN_VERIFIED_LE_100 or REJECTED — never this
// script.
const STATES = ['DISCOVERED', 'RESEARCH_READY', 'EVIDENCE_FOUND', 'QUALIFIES_PENDING_HUMAN_REVIEW', 'HUMAN_VERIFIED_LE_100', 'MATCH_UNCERTAIN', 'PRICE_UNKNOWN', 'PRICE_ABOVE_100', 'REJECTED'];

// Ordered so the first matching bucket wins — biryani/chicken and thali are
// distinct, strong signals checked before the more generic darshini/udupi
// bucket, which is explicitly the one we must not let dominate.
const CUISINE_BUCKETS = [
  { key: 'thali', label: 'THALI', keywords: ['thali'] },
  { key: 'biryani_chicken', label: 'SUBSTANTIAL_SINGLE_DISH / MEAL (biryani or chicken)', keywords: ['biryani', 'chicken'] },
  { key: 'mess_bhojanalaya', label: 'MEAL (mess/bhojanalaya/canteen)', keywords: ['mess', 'bhojanalaya', 'military hotel', 'canteen'] },
  {
    key: 'regional_meals',
    label: 'MEAL (regional thali/meals)',
    keywords: ['punjabi', 'kerala', 'andhra', 'karnataka meal', 'north indian meal', 'north indian restaurant'],
  },
  { key: 'darshini_udupi', label: 'BREAKFAST/MEAL (darshini-style)', keywords: ['darshini', 'udupi', 'upahar', 'upahara', 'thindi'] },
  { key: 'breakfast_tiffin', label: 'BREAKFAST', keywords: ['tiffin', 'dosa', 'breakfast'] },
];

function bucketOf(candidate) {
  const text = `${candidate.name} ${candidate.primary_type ?? ''} ${(candidate.types ?? []).join(' ')}`.toLowerCase();
  for (const bucket of CUISINE_BUCKETS) {
    if (bucket.keywords.some((k) => text.includes(k))) return bucket;
  }
  return { key: 'other', label: 'UNKNOWN — needs research', keywords: [] };
}

const BRAND_STOPWORDS = new Set(['new', 'sri', 'shree', 'hotel', 'restaurant', 'the', 'and', 'pure', 'veg', 'grand', 'food', 'hub']);

function brandKey(name) {
  const tokens = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !BRAND_STOPWORDS.has(t) && !/^\d+(st|nd|rd|th)?$/.test(t));
  return tokens.slice(0, 2).join(' ') || name.toLowerCase();
}

function latestFile(prefix) {
  if (!existsSync(OUTPUT_DIR)) return null;
  const files = readdirSync(OUTPUT_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort();
  return files.length ? join(OUTPUT_DIR, files[files.length - 1]) : null;
}

function loadCandidates(explicitPath) {
  const path = explicitPath || latestFile('candidates-');
  if (!path) throw new Error('No candidates-*.json found.');
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

// Maps the Phase 1.5-era research states, and Phase 1.8's, onto this
// phase's vocabulary. The critical rule: an agent/research "VERIFIED_LE_100"
// finding NEVER becomes HUMAN_VERIFIED_LE_100 here — only a real human
// verify-queue.mjs decision can do that.
function mapEvidenceStatus(oldStatus) {
  switch (oldStatus) {
    case 'VERIFIED_LE_100':
      return 'QUALIFIES_PENDING_HUMAN_REVIEW';
    case 'PRICE_FOUND_ABOVE_100':
      return 'PRICE_ABOVE_100';
    case 'SOURCE_UNAVAILABLE':
      return 'RESEARCH_READY'; // attempted, nothing usable found — still needs (re-)research
    case 'UNVERIFIED':
      return 'EVIDENCE_FOUND'; // some evidence exists, not decisive
    case 'MATCH_UNCERTAIN':
    case 'PRICE_UNKNOWN':
      return oldStatus; // already match the new vocabulary
    default:
      return 'RESEARCH_READY';
  }
}

function scoreCandidate(candidate, evidence) {
  const reasons = [];
  let score = 0;
  if (candidate.google_price_level === 'PRICE_LEVEL_INEXPENSIVE') {
    score += 3;
    reasons.push('Google INEXPENSIVE signal (hint only, not proof)');
  }
  const bucket = bucketOf(candidate);
  if (bucket.key !== 'other') {
    score += bucket.key === 'darshini_udupi' ? 2 : 3; // slightly de-weight the already-common darshini/udupi bucket
    reasons.push(`meal-oriented name/type match (${bucket.label})`);
  }
  const text = (candidate.primary_type ?? '').toLowerCase();
  if (['restaurant', 'south_indian_restaurant', 'north_indian_restaurant', 'indian_restaurant', 'breakfast_restaurant', 'fast_food_restaurant'].includes(text)) {
    score += 1;
    reasons.push(`primary_type "${text}"`);
  }
  const hitCount = candidate.discovery_sources.length;
  if (hitCount > 1) {
    score += Math.min(hitCount - 1, 3); // cap the bonus so one place can't dominate purely by keyword-collision luck
    reasons.push(`found by ${hitCount} distinct discovery queries (stronger relevance signal)`);
  }
  if (evidence) {
    score += 2;
    reasons.push(`prior Phase 1.5 research exists (${mapEvidenceStatus(evidence.status)})`);
    if (evidence.status === 'VERIFIED_LE_100') {
      score += 3;
      reasons.push('prior research found qualifying complete-meal evidence — ready for human review');
    }
  }
  return { score, reasons, bucket };
}

function searchLink(name, address, site) {
  const q = encodeURIComponent(`${name} ${address}${site ? ` site:${site}` : ''}`);
  return `https://www.google.com/search?q=${q}`;
}

function mapsUrl(lat, lng) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

// Zone-balanced, cuisine-bucket-capped, brand+zone-capped greedy selection.
// Never simply takes the top-N globally — that would just recreate the
// South/Southeast dominance already visible in the raw discovery counts.
function selectQueue(candidates, evidenceByPlaceId, targetCount) {
  const scored = candidates.map((c) => {
    const evidence = evidenceByPlaceId.get(c.place_id) ?? null;
    const area = c.discovery_sources[0]?.area ?? 'unknown';
    const zone = AREA_ZONE[area] ?? 'unknown';
    return { candidate: c, evidence, area, zone, ...scoreCandidate(c, evidence) };
  });

  // Equal-ish per-zone quota (the explicit "roughly balanced, not
  // proportional to raw discovery counts" requirement), remainder spread
  // across the two largest source zones.
  const zoneSizes = new Map();
  for (const z of ZONES) zoneSizes.set(z, scored.filter((s) => s.zone === z).length);
  const base = Math.floor(targetCount / ZONES.length);
  let remainder = targetCount - base * ZONES.length;
  const sortedZonesBySize = [...ZONES].sort((a, b) => zoneSizes.get(b) - zoneSizes.get(a));
  const zoneQuota = new Map(ZONES.map((z) => [z, base]));
  for (let i = 0; i < remainder; i++) zoneQuota.set(sortedZonesBySize[i], zoneQuota.get(sortedZonesBySize[i]) + 1);

  const byZone = new Map(ZONES.map((z) => [z, scored.filter((s) => s.zone === z).sort((a, b) => b.score - a.score)]));

  const selected = [];
  const relaxations = [];

  for (const zone of ZONES) {
    const quota = zoneQuota.get(zone);
    const pool = byZone.get(zone);
    const brandZoneCounts = new Map(); // `${brand}|${zone}` -> count, cap 1 (allows the same brand in a DIFFERENT zone)
    const bucketCounts = new Map();
    const darshiniSoftCap = Math.ceil(quota * 0.35); // the one bucket explicitly not allowed to dominate

    const zonePicks = [];
    // Pass 1: respect brand+zone cap and the darshini/udupi soft cap.
    for (const entry of pool) {
      if (zonePicks.length >= quota) break;
      const bkey = `${brandKey(entry.candidate.name)}|${zone}`;
      if ((brandZoneCounts.get(bkey) ?? 0) >= 1) continue;
      if (entry.bucket.key === 'darshini_udupi' && (bucketCounts.get('darshini_udupi') ?? 0) >= darshiniSoftCap) continue;
      zonePicks.push(entry);
      brandZoneCounts.set(bkey, (brandZoneCounts.get(bkey) ?? 0) + 1);
      bucketCounts.set(entry.bucket.key, (bucketCounts.get(entry.bucket.key) ?? 0) + 1);
    }
    // Pass 2: backfill if this zone's pool couldn't fill quota under the
    // caps above (relax brand+zone cap, then relax the darshini cap) —
    // never leave a zone short if candidates exist, but report it.
    if (zonePicks.length < quota) {
      const picked = new Set(zonePicks);
      for (const entry of pool) {
        if (zonePicks.length >= quota) break;
        if (picked.has(entry)) continue;
        zonePicks.push(entry);
        picked.add(entry);
      }
      if (zonePicks.length < quota) {
        relaxations.push(`${zone}: only ${zonePicks.length}/${quota} candidates available in the whole pool for this zone`);
      } else {
        relaxations.push(`${zone}: brand/bucket caps relaxed to fill quota (pool was thin under strict caps)`);
      }
    }
    selected.push(...zonePicks);
  }

  return { selected, zoneQuota: Object.fromEntries(zoneQuota), relaxations };
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(records) {
  const headers = [
    'place_id', 'name', 'zone', 'area', 'address', 'latitude', 'longitude', 'google_price_level',
    'primary_type', 'likely_offering_type', 'discovery_hit_count', 'evidence_status', 'website', 'phone',
    'human_verification_status', 'why_prioritized',
  ];
  const lines = [headers.join(',')];
  for (const r of records) {
    lines.push(
      [r.place_id, r.name, r.zone, r.area, r.address, r.latitude, r.longitude, r.google_price_level, r.primary_type, r.likely_offering_type, r.discovery_hit_count, r.evidence_status, r.website, r.phone, r.human_verification_status, r.why_prioritized]
        .map(csvEscape)
        .join(',')
    );
  }
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const countArg = args.find((a) => a.startsWith('--count='));
  const sourceArg = args.find((a) => a.startsWith('--source='));
  const count = countArg ? Number(countArg.split('=')[1]) : DEFAULT_COUNT;

  const { path: candidatesPath, candidates } = loadCandidates(sourceArg ? sourceArg.split('=').slice(1).join('=') : null);
  const { path: evidencePath, byPlaceId: evidenceByPlaceId } = loadPriorEvidence();

  // Quality check: no duplicate place_id in the source dataset itself.
  const seenIds = new Set();
  let sourceDuplicates = 0;
  for (const c of candidates) {
    if (seenIds.has(c.place_id)) sourceDuplicates++;
    seenIds.add(c.place_id);
  }

  const { selected, zoneQuota, relaxations } = selectQueue(candidates, evidenceByPlaceId, count);

  const records = selected.map(({ candidate, evidence, area, zone, score, reasons, bucket }) => {
    const evidenceStatus = evidence ? mapEvidenceStatus(evidence.status) : 'RESEARCH_READY';
    return {
      place_id: candidate.place_id,
      name: candidate.name,
      address: candidate.formatted_address,
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      zone,
      area,
      google_price_level: candidate.google_price_level, // SIGNAL ONLY — never proof of ≤₹100
      primary_type: candidate.primary_type,
      food_category_type: candidate.types,
      discovery_sources: candidate.discovery_sources, // full provenance: area, query, discovered_at per hit
      discovery_hit_count: candidate.discovery_sources.length,
      priority_score: score,
      why_prioritized: `score ${score}: ${reasons.join('; ') || 'baseline (no strong signal)'}`,
      likely_offering_type: bucket.label,
      evidence_status: evidenceStatus,
      existing_evidence: evidence
        ? {
            qualifying_item: evidence.qualifying_item,
            offering_type: evidence.offering_type ?? null,
            price_rupees: evidence.price_rupees,
            found_items: evidence.found_items,
            match_confidence: evidence.match_confidence,
            evidence_source_url: evidence.evidence_source_url,
            confidence_notes: evidence.confidence_notes,
          }
        : null,
      research_links: {
        google_search: searchLink(candidate.name, candidate.formatted_address),
        google_maps: mapsUrl(candidate.latitude, candidate.longitude),
        zomato_search: searchLink(candidate.name, candidate.formatted_address, 'zomato.com'),
        swiggy_search: searchLink(candidate.name, candidate.formatted_address, 'swiggy.com'),
        justdial_search: searchLink(candidate.name, candidate.formatted_address, 'justdial.com'),
      },
      website: candidate.website_uri ?? null,
      phone: candidate.phone ?? null,
      google_maps_uri: candidate.google_maps_uri ?? null,
      image_links: [], // none collected this phase — see report; preserved only if already present in local data (none is)
      human_verification_status: null, // NEVER set by this script
    };
  });

  // Quality checks
  const outIds = new Set(records.map((r) => r.place_id));
  const duplicatesInOutput = records.length - outIds.size;
  const zonesInOutput = new Set(records.map((r) => r.zone));
  const missingZones = ZONES.filter((z) => !zonesInOutput.has(z));
  const zoneCounts = {};
  for (const r of records) zoneCounts[r.zone] = (zoneCounts[r.zone] ?? 0) + 1;
  const maxZoneShare = records.length ? Math.max(...Object.values(zoneCounts)) / records.length : 0;
  const anyHumanVerified = records.some((r) => r.human_verification_status === 'HUMAN_VERIFIED_LE_100' || r.evidence_status === 'HUMAN_VERIFIED_LE_100');

  const byZone = {};
  for (const r of records) byZone[r.zone] = (byZone[r.zone] ?? 0) + 1;
  const byArea = {};
  for (const r of records) byArea[r.area] = (byArea[r.area] ?? 0) + 1;
  const byPriceLevel = {};
  for (const r of records) byPriceLevel[r.google_price_level ?? 'UNSET'] = (byPriceLevel[r.google_price_level ?? 'UNSET'] ?? 0) + 1;
  const byOfferingType = {};
  for (const r of records) byOfferingType[r.likely_offering_type] = (byOfferingType[r.likely_offering_type] ?? 0) + 1;
  const byPrimaryType = {};
  for (const r of records) byPrimaryType[r.primary_type ?? 'unknown'] = (byPrimaryType[r.primary_type ?? 'unknown'] ?? 0) + 1;
  const byDiscoveryCategory = {};
  for (const r of records) for (const s of new Set(r.discovery_sources.map((d) => d.query))) byDiscoveryCategory[s] = (byDiscoveryCategory[s] ?? 0) + 1;
  const byEvidenceStatus = {};
  for (const r of records) byEvidenceStatus[r.evidence_status] = (byEvidenceStatus[r.evidence_status] ?? 0) + 1;

  const withEvidence = records.filter((r) => r.existing_evidence !== null).length;
  const withWebsite = records.filter((r) => r.website).length;
  const withPhone = records.filter((r) => r.phone).length;
  const withImages = records.filter((r) => r.image_links.length > 0).length;
  const brandClusters = new Set(records.map((r) => brandKey(r.name))).size;

  const top20 = [...records].sort((a, b) => b.priority_score - a.priority_score).slice(0, 20);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(OUTPUT_DIR, `verification-queue-${timestamp}.json`);
  const csvPath = join(OUTPUT_DIR, `verification-queue-${timestamp}.csv`);

  const output = {
    run: {
      source_candidates_file: candidatesPath,
      source_evidence_file: evidencePath,
      total_source_candidates: candidates.length,
      selected_count: records.length,
      requested_count: count,
      zone_quota: zoneQuota,
      zone_relaxations: relaxations,
      by_zone: byZone,
      by_area: byArea,
      by_google_price_level: byPriceLevel,
      by_likely_offering_type: byOfferingType,
      by_primary_type: byPrimaryType,
      by_discovery_category: byDiscoveryCategory,
      by_evidence_status: byEvidenceStatus,
      with_existing_evidence: withEvidence,
      with_website: withWebsite,
      with_phone: withPhone,
      with_existing_images: withImages,
      distinct_brand_clusters: brandClusters,
      quality_checks: {
        source_dataset_had_duplicate_place_ids: sourceDuplicates,
        output_has_duplicate_place_ids: duplicatesInOutput,
        zones_missing_from_output: missingZones,
        max_single_zone_share_pct: Number((maxZoneShare * 100).toFixed(1)),
        any_candidate_marked_human_verified: anyHumanVerified,
      },
      generated_at: new Date().toISOString(),
    },
    top_20_highest_priority: top20.map((r) => ({ place_id: r.place_id, name: r.name, zone: r.zone, area: r.area, priority_score: r.priority_score, why_prioritized: r.why_prioritized, evidence_status: r.evidence_status })),
    candidates: records,
  };

  writeFileSync(jsonPath, JSON.stringify(output, null, 2), 'utf8');
  writeFileSync(csvPath, toCsv(records), 'utf8');

  console.log('=== BENGALURU-WIDE VERIFICATION QUEUE BUILT — LOCAL ONLY, NO API CALLS, NO DB TOUCHED ===');
  console.log(`Source candidates: ${candidates.length}`);
  console.log(`Selected: ${records.length} (target ${count})`);
  console.log(`Zone quota: ${JSON.stringify(zoneQuota)}`);
  if (relaxations.length) console.log(`Zone relaxations: ${relaxations.join(' | ')}`);
  console.log(`By zone: ${JSON.stringify(byZone)}`);
  console.log(`Quality checks: ${JSON.stringify(output.run.quality_checks)}`);
  console.log(`Output written: ${jsonPath}`);
  console.log(`                ${csvPath}`);
}

main();
