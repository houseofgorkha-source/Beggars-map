// Beggars Map — Phase 1.5 price-verification prototype (local, read-only).
//
// Takes a small hand-picked subset of the existing discovery output and
// classifies each candidate's ₹100-or-under status using real evidence.
//
// IMPORTANT — how "evidence" gets into this script: Google Places API (New)
// exposes no item-level pricing, and the two dominant sources that DO show
// menu prices for this restaurant segment (Zomato, Swiggy) are excluded —
// Swiggy's own Terms & Conditions explicitly prohibit "page-scrape,"
// "robot," "spider," or other automated device/program access; Zomato was
// unreachable via both curl and WebFetch from this environment (connection
// failures / timeouts), consistent with active bot-protection. Neither was
// queried or fetched by this script. Justdial's terms could not be
// confirmed either way and were treated with the same caution.
//
// The only source with no third-party ToS conflict — a restaurant's own
// website — has near-zero coverage for this specific segment (small
// darshini/udupi/mess-style eateries rarely run branded sites).
//
// So for this prototype, evidence was gathered by the agent via general
// web search (a search engine's own public result snippets — not a fetch
// of any individual restaurant-aggregator page) during the same session
// that wrote this file, and is recorded below with real source URLs,
// exactly as found — nothing here is invented. This is NOT a scalable
// automated pipeline; it demonstrates the schema, matching safeguards, and
// classification rules against real cases, including two genuine
// name-collision traps (see EVIDENCE below). See the chat report for the
// full feasibility conclusion and recommendation.
//
// Never touches Supabase. Never imports. Writes only new, separate
// tools/discovery/output/price-verification-*.json / .csv files — the
// original candidates-*.json is never modified.
//
// Usage: node tools/discovery/price-verify.mjs [path-to-candidates.json]

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchConfidence, classifyOffering } from './matching.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(HERE, 'output');

// Task 6's operational classification, plus DISCOVERED (Task 3's initial
// state, kept distinct from PRICE_UNKNOWN: "never attempted" vs "attempted,
// found nothing usable") and UNVERIFIED (evidence exists but is too
// inconsistent/low-quality to classify either way) — six non-collapsed
// states in total.
const STATUSES = [
  'DISCOVERED',
  'VERIFIED_LE_100',
  'PRICE_FOUND_ABOVE_100',
  'PRICE_UNKNOWN',
  'MATCH_UNCERTAIN',
  'SOURCE_UNAVAILABLE',
  'UNVERIFIED',
];

// Hand-picked subset (11 of the 127 discovered candidates): a mix of
// distinctive names (higher expected matchability) and deliberately
// repeated generic names ("New Udupi Grand" x3, "Udupi Upahar" x2) chosen
// specifically to stress-test the matching safeguard from Task 4.
// `addressContains` disambiguates which exact discovered row this refers
// to when multiple candidates share a name.
const SELECTIONS = [
  { name: 'Central Tiffin Room', addressContains: 'Malleshwaram' },
  { name: 'New Udupi Grand', addressContains: 'KHB Colony' },
  { name: 'New Udupi Grand', addressContains: 'CK Complex' },
  { name: 'New Udupi Grand', addressContains: 'Nanjappa Layout' },
  { name: 'Udupi Upahar', addressContains: 'Mahatyagi' },
  { name: 'Udupi Upahar', addressContains: '1st Main Rd' }, // note: ambiguous address text, see notes below
  { name: 'Vijaya Lakshmi Pure Veg', addressContains: 'Margosa' },
  { name: 'Brahmin Tiffins and Coffee', addressContains: '' },
  { name: 'Sri Rajarajeshwari Iyer Mess ( New)', addressContains: '' },
  { name: 'Iyer Mess', addressContains: 'West Park' },
  { name: 'Kota Kachori', addressContains: '' },
];

// Evidence gathered live via WebSearch this session (see file header). Keyed
// by (name, addressContains) matching SELECTIONS above, in the same order.
const EVIDENCE = [
  {
    // Central Tiffin Room (CTR) — Malleshwaram
    status: 'PRICE_FOUND_ABOVE_100',
    qualifying_item: null,
    price_rupees: null,
    found_items: [{ item: 'Benne Masala Dosa', price_rupees: 110 }],
    evidence_source_type: 'third_party_menu_aggregator',
    evidence_source_url: 'https://menupricesindia.com/ctr-shri-sagar-menu-prices-malleshwaram-bengaluru/',
    evidence_location_text: 'Malleshwaram, Bengaluru',
    retrieved_via: 'web_search_snippet',
    confidence_notes:
      'Aggregator (not the restaurant\'s own site) reports Benne Masala Dosa at ₹110 — above the cap, so this candidate does NOT qualify even though it is a well-known cheap-eats institution. ' +
      'Notable discrepancy: Beggars Map\'s own existing seed listing (0003_seed_demo_listings.sql) already lists "CTR (Central Tiffin Room)" at ₹70 for the same dish, at different (independently-entered) coordinates. ' +
      'Flagging for human review, not resolving automatically — could reflect a price rise since the seed data was written, a different specific item, or the aggregator being wrong.',
  },
  {
    // New Udupi Grand — KHB Colony
    status: 'MATCH_UNCERTAIN',
    found_items: [],
    evidence_source_type: 'brand_name_search_no_address_match',
    evidence_source_url: null,
    candidate_source_urls: [
      'https://magicpin.in/Bangalore/Hegganahalli/Restaurant/New-Udupi-Grand/store/31599/menu',
      'https://magicpin.in/Bangalore/Gunjur/Restaurant/New-Udupi-Grand/store/a2b17/menu',
    ],
    evidence_location_text: null,
    retrieved_via: 'web_search_snippet',
    confidence_notes:
      '"New Udupi Grand" search surfaced branches in Yelahanka, Hegganahalli, Gunjur, Basavanagudi, Whitefield, and Magadi Road — none match this candidate\'s KHB Colony address. Refusing to attribute any of these branches\' pricing here.',
  },
  {
    // New Udupi Grand — CK Complex
    status: 'MATCH_UNCERTAIN',
    found_items: [],
    evidence_source_type: 'brand_name_search_no_address_match',
    evidence_source_url: null,
    candidate_source_urls: [
      'https://magicpin.in/Bangalore/Hegganahalli/Restaurant/New-Udupi-Grand/store/31599/menu',
      'https://magicpin.in/Bangalore/Gunjur/Restaurant/New-Udupi-Grand/store/a2b17/menu',
    ],
    evidence_location_text: null,
    retrieved_via: 'web_search_snippet',
    confidence_notes: 'Same brand-collision issue as the KHB Colony entry — none of the found branches match the CK Complex address.',
  },
  {
    // New Udupi Grand — Nanjappa Layout
    status: 'MATCH_UNCERTAIN',
    found_items: [],
    evidence_source_type: 'brand_name_search_no_address_match',
    evidence_source_url: null,
    candidate_source_urls: [
      'https://magicpin.in/Bangalore/Hegganahalli/Restaurant/New-Udupi-Grand/store/31599/menu',
      'https://magicpin.in/Bangalore/Gunjur/Restaurant/New-Udupi-Grand/store/a2b17/menu',
    ],
    evidence_location_text: null,
    retrieved_via: 'web_search_snippet',
    confidence_notes: 'Same brand-collision issue — none of the found branches match the Nanjappa Layout address.',
  },
  {
    // Udupi Upahar — Mahatyagi Laksmidevi Rd
    status: 'MATCH_UNCERTAIN',
    found_items: [
      { item: 'Meals', price_rupees: 60 },
      { item: 'Masala Dosa', price_rupees: 45 },
      { item: 'Plain Dosa', price_rupees: 35 },
      { item: 'Kesari Bath', price_rupees: 25 },
    ],
    evidence_source_type: 'brand_name_search_no_address_match',
    evidence_source_url: null,
    candidate_source_urls: [
      'https://magicpin.in/Bangalore/Kudlu-Gate/Restaurant/Udupi-Upahar/store/387690/menu/',
      'https://www.eazydiner.com/bengaluru/udupi-upahar-banashankari-331765/menu',
      'https://www.justdial.com/Bangalore/New-Udupi-Upahar-Richmond-Circle/080PXX80-XX80-180410220711-G7D4_BZDET/menu',
    ],
    evidence_location_text: null,
    retrieved_via: 'web_search_snippet',
    confidence_notes:
      'Strong itemized ≤₹100 pricing exists for the "Udupi Upahar" brand (Meals ₹60, dosas ₹35-45, Kesari Bath ₹25) — but the found branches (Richmond Circle, Kanakapura Road, JP Nagar, Banashankari, Kudlu Gate, Bommanahalli) do not include this candidate\'s Mahatyagi Laksmidevi Rd address. ' +
      'Deliberately NOT classified VERIFIED_LE_100 despite the tempting price data — this is the exact "same name, wrong branch" trap the matching design exists to catch.',
  },
  {
    // Udupi Upahar — 1st Main Rd
    status: 'MATCH_UNCERTAIN',
    found_items: [
      { item: 'Meals', price_rupees: 60 },
      { item: 'Masala Dosa', price_rupees: 45 },
    ],
    evidence_source_type: 'brand_name_search_no_address_match',
    evidence_source_url: null,
    candidate_source_urls: ['https://magicpin.in/Bangalore/Kudlu-Gate/Restaurant/Udupi-Upahar/store/387690/menu/'],
    evidence_location_text: null,
    retrieved_via: 'web_search_snippet',
    confidence_notes:
      'Same brand-collision issue as the other Udupi Upahar entry — "1st Main Rd" is too generic to confirm against any specific found branch. Not classified VERIFIED_LE_100.',
  },
  {
    // Vijaya Lakshmi Pure Veg — Margosa Rd
    status: 'UNVERIFIED',
    found_items: [],
    evidence_source_type: 'aggregate_cost_estimate_only',
    evidence_source_url: null,
    candidate_source_urls: [
      'https://www.swiggy.com/restaurants/vijayalakshmi-veg-margosa-road-malleshwaram-bangalore-173590',
      'https://magicpin.in/Bangalore/Malleshwaram/Restaurant/Vijaya-Lakshmi-Pure-Veg/store/1a5a777',
    ],
    evidence_location_text: 'Margosa Road, Malleshwaram, near Leela Hospital',
    retrieved_via: 'web_search_snippet',
    confidence_notes:
      'Search summary reported "₹1500 for two," which is inconsistent with this being a self-service tiffin counter and looks like a probable data-quality artifact of the source rather than a reliable figure. No item-level price found either way — insufficient evidence to classify as above or below the cap.',
  },
  {
    // Brahmin Tiffins and Coffee — Jayanagar
    status: 'PRICE_UNKNOWN',
    found_items: [],
    evidence_source_type: 'aggregate_cost_estimate_only',
    evidence_source_url: null,
    candidate_source_urls: [
      'https://www.eazydiner.com/bengaluru/brahmin-tiffins-n-coffee-jayanagar-333460/menu',
      'https://www.justdial.com/Bangalore/Brahmin-Tiffins-Coffee-Opposite-Madhavan-Park-Jayanagar-4th-T-Block/080PXX80-XX80-150517143721-B1X3_BZDET',
    ],
    evidence_location_text: 'Jayanagar, Bengaluru',
    retrieved_via: 'web_search_snippet',
    confidence_notes:
      'Named dishes (Kharabath, Upma, Kesari Bath, Idli, Filtered Coffee) but only inconsistent "cost for two" aggregates across sources (₹100 / ₹150 / ₹200 depending on source) — a cost-for-two average is not item-level evidence and is explicitly excluded from qualification by policy.',
  },
  {
    // Sri Rajarajeshwari Iyer Mess ( New) — 17th Cross Rd, Malleshwaram
    status: 'SOURCE_UNAVAILABLE',
    found_items: [],
    evidence_source_type: null,
    evidence_source_url: null,
    candidate_source_urls: [],
    evidence_location_text: null,
    retrieved_via: 'web_search_snippet',
    confidence_notes:
      'Searching "Iyer Mess" surfaced a well-documented result, but at West Park Road — a different street from this candidate\'s 17th Cross Rd address. Treated as a POSSIBLY DIFFERENT establishment sharing a common name pattern, not the same one. See the separate "Iyer Mess" (West Park Road) entry below — do not merge these two.',
  },
  {
    // Iyer Mess — 4/3, West Park Road, Malleshwaram
    // RECLASSIFIED 2026-09-01 under the corrected "complete meal" product
    // policy (a single cheap item, e.g. Vada ₹10, no longer qualifies on
    // its own). Re-derived from evidence already gathered in the original
    // Phase 1.5 search — no new search was run. The original search result
    // (still on record in this session) also described: "Simple homely
    // authentic South Indian meals are served on a plaintain leaf for 70rs
    // for unlimited food... kootu gravy/1 dry veg/1 papad/1 rasam and
    // unlimited rice... The meal includes Chapathi, 2 sabjis, rice, sambar,
    // rasam, vada, pickle, curd and papad" — a clearly-described, genuinely
    // multi-component meal, independent of the single-item prices below.
    // A separate, more time-limited signal from the same source ("Meal of
    // the Day" at an offer price of ₹49, original ₹115) corroborates but is
    // NOT the primary claim, since a discount price isn't stable evidence.
    status: 'VERIFIED_LE_100',
    offering_type: 'MEAL',
    qualifying_item: 'Meal (unlimited rice, sambar, rasam, 2 sabjis, chapathi, vada, curd, papad, pickle — served on a plantain leaf)',
    price_rupees: 70,
    found_items: [
      { item: 'Meal (unlimited, multi-component)', price_rupees: 70 },
      { item: '"Meal of the Day" (offer price, original ₹115 — caveat: discount pricing, not used as primary claim)', price_rupees: 49 },
      { item: 'Vada (single item — does NOT independently qualify)', price_rupees: 10 },
      { item: 'Chapati (single item — does NOT independently qualify)', price_rupees: 10 },
      { item: 'Curd Rice (single item — does NOT independently qualify)', price_rupees: 50 },
      { item: 'Sambar Rice (single item — does NOT independently qualify)', price_rupees: 50 },
    ],
    evidence_source_type: 'third_party_menu_aggregator_plus_food_blog',
    evidence_source_url: 'https://menupricesindia.com/k-iyer-mess-menu-prices-malleshwaram-bengaluru/',
    candidate_source_urls: ['https://lbb.in/bangalore/south-indian-meal-iyer-mess/', 'https://www.district.in/dining/bangalore/iyer-mess-malleshwaram'],
    evidence_location_text: '7th & 8th Cross, West Park Road, Malleshwaram, Bengaluru',
    retrieved_via: 'web_search_snippet',
    confidence_notes:
      'Qualifies as a genuine MEAL, not a single item: the source explicitly describes an unlimited multi-component meal (rice, sambar, rasam, 2 sabjis, chapathi, vada, curd, papad, pickle) for ₹70. The individual item prices (Vada ₹10, Chapati ₹10, etc.) are kept in found_items for reference but do NOT themselves qualify this candidate — this was the exact mistake the earlier version of this record made. Confidence capped at "medium": no single source was fetched first-hand, all are aggregator/search-snippet derived. A human should still spot-check before this becomes a live listing.',
  },
  {
    // Kota Kachori — No. 121, Shop No. 2
    status: 'MATCH_UNCERTAIN',
    found_items: [],
    evidence_source_type: 'conflicting_multi_outlet_signals',
    evidence_source_url: null,
    candidate_source_urls: ['https://www.sluurpy.in/bengaluru/restaurant/4422210/kota-kachori', 'https://restaurant-guru.in/Kota-Kachori-Bengaluru-5'],
    evidence_location_text: null,
    retrieved_via: 'web_search_snippet',
    confidence_notes:
      'Multiple "Kota Kachori" / "Falahaar & Kota Kachori" outlets exist (100 Feet Rd, HSR Layout) with conflicting price signals (₹150 for two vs ₹300/plate vs ₹200-400/person) and none confidently match this candidate\'s "No. 121, Shop No. 2" address. Too ambiguous to classify by price OR by match.',
  },
];

function normalizeAddr(a) {
  return (a || '').toLowerCase();
}

function findCandidate(candidates, selection) {
  const matches = candidates.filter(
    (c) => c.name.trim().toLowerCase() === selection.name.trim().toLowerCase() && normalizeAddr(c.formatted_address).includes(selection.addressContains.toLowerCase())
  );
  if (matches.length !== 1) {
    throw new Error(`Selection ${JSON.stringify(selection)} matched ${matches.length} candidate(s), expected exactly 1.`);
  }
  return matches[0];
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(records) {
  const headers = [
    'place_id',
    'restaurant',
    'address',
    'status',
    'offering_type',
    'qualifying_item',
    'price_rupees',
    'match_confidence',
    'evidence_confidence_notes',
    'evidence_source_url',
  ];
  const lines = [headers.join(',')];
  for (const r of records) {
    lines.push(
      [r.place_id, r.restaurant, r.address, r.status, r.offering_type, r.qualifying_item, r.price_rupees, r.match_confidence, r.confidence_notes, r.evidence_source_url]
        .map(csvEscape)
        .join(',')
    );
  }
  return lines.join('\n');
}

function latestCandidatesFile() {
  const files = readdirSync(OUTPUT_DIR)
    .filter((f) => f.startsWith('candidates-') && f.endsWith('.json'))
    .sort();
  if (files.length === 0) throw new Error(`No candidates-*.json file found in ${OUTPUT_DIR}. Run discover.mjs first.`);
  return join(OUTPUT_DIR, files[files.length - 1]);
}

function main() {
  const inputPath = process.argv[2] || latestCandidatesFile();
  if (!existsSync(inputPath)) throw new Error(`No such file: ${inputPath}`);
  const data = JSON.parse(readFileSync(inputPath, 'utf8'));
  const candidates = data.candidates ?? data;

  if (SELECTIONS.length !== EVIDENCE.length) {
    throw new Error(`SELECTIONS (${SELECTIONS.length}) and EVIDENCE (${EVIDENCE.length}) length mismatch.`);
  }

  const records = SELECTIONS.map((selection, i) => {
    const candidate = findCandidate(candidates, selection);
    const evidence = EVIDENCE[i];
    if (!STATUSES.includes(evidence.status)) throw new Error(`Unknown status "${evidence.status}" for ${candidate.name}.`);

    // Hard rule: VERIFIED_LE_100 requires an actual qualifying COMPLETE MEAL
    // (not a single item, however cheap) + price + source + non-'low'
    // match confidence — never inferred. classifyOffering() is the single
    // source of truth for "is this really a complete meal" — see
    // matching.mjs for the product-policy rationale.
    const confidence = matchConfidence({
      candidateName: candidate.name,
      candidateAddress: candidate.formatted_address,
      evidenceLocationText: evidence.evidence_location_text,
    });
    if (evidence.status === 'VERIFIED_LE_100') {
      if (!evidence.qualifying_item || typeof evidence.price_rupees !== 'number' || evidence.price_rupees <= 0 || evidence.price_rupees > 100) {
        throw new Error(`VERIFIED_LE_100 for ${candidate.name} is missing a valid qualifying_item/price_rupees.`);
      }
      if (!evidence.evidence_source_url) throw new Error(`VERIFIED_LE_100 for ${candidate.name} is missing evidence_source_url.`);
      if (confidence === 'low') throw new Error(`VERIFIED_LE_100 for ${candidate.name} has 'low' match confidence — refusing to verify an unmatched candidate.`);
      const offering = classifyOffering({ description: evidence.qualifying_item, offeringType: evidence.offering_type });
      if (!offering.qualifies) {
        throw new Error(`VERIFIED_LE_100 for ${candidate.name} does not qualify as a complete meal: ${offering.reason}`);
      }
    }

    return {
      place_id: candidate.place_id,
      restaurant: candidate.name,
      address: candidate.formatted_address,
      google_price_level: candidate.google_price_level,
      status: evidence.status,
      offering_type: evidence.offering_type ?? null,
      qualifying_item: evidence.qualifying_item ?? null,
      price_rupees: evidence.price_rupees ?? null,
      found_items: evidence.found_items ?? [],
      match_confidence: confidence,
      evidence_source_type: evidence.evidence_source_type ?? null,
      evidence_source_url: evidence.evidence_source_url ?? null,
      candidate_source_urls: evidence.candidate_source_urls ?? [],
      retrieved_via: evidence.retrieved_via,
      retrieved_at: new Date().toISOString(),
      confidence_notes: evidence.confidence_notes,
    };
  });

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(OUTPUT_DIR, `price-verification-${timestamp}.json`);
  const csvPath = join(OUTPUT_DIR, `price-verification-${timestamp}.csv`);

  const counts = Object.fromEntries(STATUSES.map((s) => [s, records.filter((r) => r.status === s).length]));

  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        run: {
          source_candidates_file: inputPath,
          processed: records.length,
          status_counts: counts,
          generated_at: new Date().toISOString(),
          note: 'Prototype: evidence gathered via WebSearch by the agent this session, not by an automated scraper. See file header for source-policy rationale.',
        },
        records,
      },
      null,
      2
    ),
    'utf8'
  );
  writeFileSync(csvPath, toCsv(records), 'utf8');

  console.log('=== PRICE VERIFICATION PROTOTYPE — LOCAL ONLY, NO DB TOUCHED ===');
  console.log(`Source candidates file: ${inputPath}`);
  console.log(`Candidates processed:   ${records.length}`);
  for (const s of STATUSES) console.log(`  ${s.padEnd(22)} ${counts[s]}`);
  console.log(`Output written: ${jsonPath}`);
  console.log(`                ${csvPath}`);
}

main();
