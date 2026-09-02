// Beggars Map — Phase 1.12: RE-VERIFICATION of the existing 250 researched
// candidates. LOCAL ONLY: never touches Supabase, never imports, makes no
// Google Places API calls, and never mutates the original discovery dataset,
// research-state.json, or full-verification-results.json.
//
// Why this exists: the Phase 1.11 pass was too shallow in places — e.g.
// "Madura Darshini" was recorded SOURCE_UNAVAILABLE even though an ordinary
// public Google result surfaces a Zomato menu with visible item prices. This
// pass re-researches the SAME 250 with a deeper public-source/menu-photo
// treatment, and keeps the OLD status beside the NEW one so shallow calls are
// visible and auditable.
//
// Two distinct kinds of food information are recorded per restaurant:
//   A) cheap_items_under_100[] — individually cheap items (<=Rs100) that are
//      useful as listing-note colour but do NOT qualify the restaurant.
//   B) a qualifying complete meal — only this can produce
//      QUALIFIES_PENDING_HUMAN_REVIEW.
// A meal is NEVER synthesised by summing unrelated individual item prices.
//
// State:   output/reverification-state.json   (separate from research-state.json)
// Master:  output/reverification-250.json / .csv
//
// Usage:
//   node reverify-batch.mjs --status
//   node reverify-batch.mjs --generate-worklist --batch-size=50
//   node reverify-batch.mjs --commit-results=path.json --batch=1

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyOffering } from './matching.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(HERE, 'output');
const SOURCE_MASTER = join(OUTPUT_DIR, 'full-verification-results.json'); // READ ONLY
const STATE_PATH = join(OUTPUT_DIR, 'reverification-state.json');
const MASTER_JSON_PATH = join(OUTPUT_DIR, 'reverification-250.json');
const MASTER_CSV_PATH = join(OUTPUT_DIR, 'reverification-250.csv');
const DEFAULT_BATCH_SIZE = 50;

// Same 8 research-producible states as Phase 1.11. HUMAN_VERIFIED_LE_100 is
// deliberately absent — the commit path hard-rejects it. Only the user's own
// explicit approval can ever create human verification.
const RESEARCH_STATES = [
  'RESEARCHED', 'EVIDENCE_FOUND', 'QUALIFIES_PENDING_HUMAN_REVIEW', 'MATCH_UNCERTAIN',
  'PRICE_UNKNOWN', 'PRICE_ABOVE_100', 'SOURCE_UNAVAILABLE', 'REJECTED',
];
const IMAGE_TYPES = ['EXTERIOR', 'SIGNBOARD', 'MENU', 'FOOD', 'MEAL', 'OTHER'];

function loadSourceMaster() {
  const data = JSON.parse(readFileSync(SOURCE_MASTER, 'utf8'));
  const results = data.results ?? [];
  if (results.length === 0) throw new Error(`${SOURCE_MASTER} has no results.`);
  return results;
}

// The original Places-API candidate records carry fields the Phase 1.11 master
// dropped (google_maps_uri, phone, website, business_status). Re-attach them so
// the human-review workbook can show them. Note: google_rating and
// google_review_count were never in the discovery field mask, so they stay null
// rather than being invented.
function loadCandidateIndex() {
  const files = readdirSync(OUTPUT_DIR).filter((f) => f.startsWith('candidates-') && f.endsWith('.json')).sort();
  if (files.length === 0) throw new Error('No candidates-*.json found.');
  const data = JSON.parse(readFileSync(join(OUTPUT_DIR, files[files.length - 1]), 'utf8'));
  const candidates = data.candidates ?? data;
  return new Map(candidates.map((c) => [c.place_id, c]));
}

function loadState() {
  if (!existsSync(STATE_PATH)) return { completed: {}, in_progress: {} };
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function loadMaster() {
  if (!existsSync(MASTER_JSON_PATH)) return { run: { batches: [] }, results: [] };
  return JSON.parse(readFileSync(MASTER_JSON_PATH, 'utf8'));
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function summariseCheapItems(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return items.map((i) => `${i.item_name} Rs${i.price_rupees}`).join('; ');
}

function writeMasterCsv(master) {
  const headers = [
    'place_id', 'name', 'address', 'area', 'zone', 'latitude', 'longitude', 'google_maps_uri', 'phone', 'website',
    'old_status', 'qualifying_status', 'status_changed', 'offering_type', 'qualifying_meal_description', 'price_rupees',
    'included_items', 'cheap_items_under_100', 'cheap_item_count', 'evidence_source_url', 'evidence_description',
    'match_confidence', 'image_count', 'research_timestamp', 'price_checked_at', 'human_verification_status',
  ];
  const lines = [headers.join(',')];
  for (const r of master.results) {
    lines.push([
      r.place_id, r.name, r.address, r.area, r.zone, r.latitude, r.longitude, r.google_maps_uri, r.phone, r.website,
      r.old_status, r.qualifying_status, r.old_status === r.qualifying_status ? 'no' : 'yes', r.offering_type,
      r.qualifying_meal_description, r.price_rupees,
      Array.isArray(r.included_items) ? r.included_items.join('; ') : r.included_items,
      summariseCheapItems(r.cheap_items_under_100), (r.cheap_items_under_100 ?? []).length,
      r.evidence_source_url, r.evidence_description, r.match_confidence, (r.image_urls ?? []).length,
      r.research_timestamp, r.price_checked_at, r.human_verification_status,
    ].map(csvEscape).join(','));
  }
  writeFileSync(MASTER_CSV_PATH, lines.join('\n'), 'utf8');
}

function generateWorklist(batchSize) {
  const source = loadSourceMaster();
  const candidateIndex = loadCandidateIndex();
  const state = loadState();

  // Deterministic order: the order the 250 already sit in the Phase 1.11
  // master, so "the first 50" is stable and re-runnable.
  const pending = source.filter((r) => !state.completed[r.place_id] && !state.in_progress[r.place_id]);
  const worklist = pending.slice(0, batchSize);

  const nextBatchNumber = Object.values(state.completed).reduce((max, c) => Math.max(max, c.batch ?? 0), 0) + 1;
  const startedAt = new Date().toISOString();
  for (const r of worklist) state.in_progress[r.place_id] = { batch: nextBatchNumber, started_at: startedAt };
  saveState(state);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const worklistPath = join(OUTPUT_DIR, `reverification-worklist-${timestamp}.json`);
  writeFileSync(worklistPath, JSON.stringify({
    batch: nextBatchNumber,
    generated_at: startedAt,
    source: 'full-verification-results.json (250 Phase 1.11 records, read-only)',
    count: worklist.length,
    candidates: worklist.map((r) => {
      const c = candidateIndex.get(r.place_id) ?? {};
      return {
        place_id: r.place_id,
        name: r.name,
        address: r.address,
        area: r.area,
        zone: r.zone,
        latitude: r.latitude,
        longitude: r.longitude,
        google_price_level: r.google_price_level,
        primary_type: r.primary_type,
        phone: c.phone ?? null,
        website: c.website_uri ?? null,
        google_maps_uri: c.google_maps_uri ?? null,
        business_status: c.business_status ?? null,
        old_status: r.qualifying_status,
        old_evidence_description: r.evidence_description,
        old_match_confidence: r.match_confidence,
      };
    }),
  }, null, 2), 'utf8');

  console.log(`[reverify] Batch ${nextBatchNumber}: ${worklist.length} of the existing 250 selected for re-verification.`);
  console.log(`[reverify] Worklist: ${worklistPath}`);
  return worklistPath;
}

function validateResult(r, index) {
  const errors = [];
  const where = `[${index}] (${r?.name ?? r?.place_id ?? 'unknown'})`;
  if (!r.place_id) errors.push(`${where} missing place_id`);
  if (!RESEARCH_STATES.includes(r.qualifying_status)) {
    errors.push(`${where} qualifying_status "${r.qualifying_status}" is not a valid research state`);
  }
  if (r.qualifying_status === 'QUALIFIES_PENDING_HUMAN_REVIEW') {
    if (!r.qualifying_meal_description || typeof r.price_rupees !== 'number' || r.price_rupees <= 0 || r.price_rupees > 100) {
      errors.push(`${where} QUALIFIES requires qualifying_meal_description + price_rupees 1-100`);
    }
    if (!r.evidence_source_url) errors.push(`${where} QUALIFIES requires evidence_source_url`);
    const offering = classifyOffering({ description: r.qualifying_meal_description, offeringType: r.offering_type });
    if (!offering.qualifies) errors.push(`${where} does not qualify as a complete meal: ${offering.reason}`);
    if (r.match_confidence === 'low') errors.push(`${where} match_confidence "low" cannot carry QUALIFIES`);
  }
  if (r.human_verification_status === 'HUMAN_VERIFIED_LE_100' || r.qualifying_status === 'HUMAN_VERIFIED_LE_100') {
    errors.push(`${where} REFUSED: re-verification research can never set HUMAN_VERIFIED_LE_100 — only the user's explicit approval can`);
  }
  for (const [i, item] of (r.cheap_items_under_100 ?? []).entries()) {
    if (!item.item_name) errors.push(`${where} cheap_items[${i}] missing item_name`);
    if (typeof item.price_rupees !== 'number' || item.price_rupees <= 0 || item.price_rupees > 100) {
      errors.push(`${where} cheap_items[${i}] price_rupees must be 1-100 (got ${JSON.stringify(item.price_rupees)})`);
    }
    if (!item.source_url) errors.push(`${where} cheap_items[${i}] missing source_url`);
  }
  for (const [i, img] of (r.image_urls ?? []).entries()) {
    if (!img.url) errors.push(`${where} image_urls[${i}] missing url`);
    if (!IMAGE_TYPES.includes(img.image_type)) {
      errors.push(`${where} image_urls[${i}] image_type must be one of ${IMAGE_TYPES.join('/')}`);
    }
  }
  return errors;
}

function commitResults(resultsPath, batchNumber) {
  const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
  if (!Array.isArray(results)) throw new Error(`${resultsPath} must be a JSON array.`);

  const sourceById = new Map(loadSourceMaster().map((r) => [r.place_id, r]));
  const candidateIndex = loadCandidateIndex();

  const allErrors = [];
  results.forEach((r, i) => {
    if (!sourceById.has(r.place_id)) {
      allErrors.push(`[${i}] ${r.place_id} is not one of the existing 250 — re-verification must not add new candidates`);
    }
    allErrors.push(...validateResult(r, i));
  });
  if (allErrors.length) throw new Error(`Refusing to commit — ${allErrors.length} problem(s):\n  ${allErrors.join('\n  ')}`);

  const state = loadState();
  const master = loadMaster();
  const now = new Date().toISOString();

  let added = 0;
  let updated = 0;
  let statusChanged = 0;
  for (const r of results) {
    const src = sourceById.get(r.place_id);
    const cand = candidateIndex.get(r.place_id) ?? {};
    const record = {
      place_id: r.place_id,
      name: src.name,
      address: src.address,
      latitude: src.latitude,
      longitude: src.longitude,
      zone: src.zone,
      area: src.area,
      google_price_level: src.google_price_level,
      primary_type: src.primary_type,
      phone: cand.phone ?? null,
      website: cand.website_uri ?? null,
      google_maps_uri: cand.google_maps_uri ?? null,
      business_status: cand.business_status ?? null,
      // Never in the original Places field mask — left null rather than invented.
      google_rating: null,
      google_review_count: null,
      old_status: src.qualifying_status,
      old_evidence_description: src.evidence_description,
      old_match_confidence: src.match_confidence,
      qualifying_status: r.qualifying_status,
      offering_type: r.offering_type ?? null,
      qualifying_meal_description: r.qualifying_meal_description ?? null,
      price_rupees: r.price_rupees ?? null,
      included_items: r.included_items ?? null,
      cheap_items_under_100: r.cheap_items_under_100 ?? [],
      evidence_source_url: r.evidence_source_url ?? null,
      evidence_description: r.evidence_description ?? null,
      match_confidence: r.match_confidence ?? null,
      image_urls: r.image_urls ?? [],
      research_timestamp: r.research_timestamp || now,
      price_checked_at: r.price_checked_at || now,
      human_verification_status: null,
      reverification_batch: batchNumber,
    };
    if (record.old_status !== record.qualifying_status) statusChanged++;
    const existingIndex = master.results.findIndex((x) => x.place_id === r.place_id);
    if (existingIndex >= 0) { master.results[existingIndex] = record; updated++; } else { master.results.push(record); added++; }
    state.completed[r.place_id] = { status: r.qualifying_status, old_status: record.old_status, batch: batchNumber, reverified_at: record.research_timestamp };
    delete state.in_progress[r.place_id];
  }

  master.run.batches.push({ batch: batchNumber, committed_at: now, count: results.length, added, updated, status_changed: statusChanged });
  master.run.total_reverified = Object.keys(state.completed).length;
  master.run.source_universe = 250;
  master.run.last_updated = now;

  saveState(state);
  writeFileSync(MASTER_JSON_PATH, JSON.stringify(master, null, 2), 'utf8');
  writeMasterCsv(master);

  console.log(`[reverify] Committed batch ${batchNumber}: ${added} new, ${updated} updated, ${statusChanged} status change(s). Master total: ${master.results.length}/250.`);
}

function printStatus() {
  const source = loadSourceMaster();
  const state = loadState();
  const completed = Object.keys(state.completed).length;
  const inProgress = Object.keys(state.in_progress).length;
  console.log(`[reverify] Source universe (Phase 1.11 records): ${source.length}`);
  console.log(`[reverify] Re-verified: ${completed}`);
  console.log(`[reverify] In progress: ${inProgress}`);
  console.log(`[reverify] Pending: ${source.length - completed - inProgress}`);
  const newCounts = {};
  const changed = [];
  for (const [id, c] of Object.entries(state.completed)) {
    newCounts[c.status] = (newCounts[c.status] ?? 0) + 1;
    if (c.old_status && c.old_status !== c.status) changed.push(`${c.old_status} -> ${c.status}`);
  }
  console.log(`[reverify] New status counts: ${JSON.stringify(newCounts)}`);
  console.log(`[reverify] Status changes vs Phase 1.11: ${changed.length}`);
}

function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const args = process.argv.slice(2);
  if (args.includes('--status')) return printStatus();
  if (args.includes('--generate-worklist')) {
    const sizeArg = args.find((a) => a.startsWith('--batch-size='));
    return void generateWorklist(sizeArg ? Number(sizeArg.split('=')[1]) : DEFAULT_BATCH_SIZE);
  }
  const commitArg = args.find((a) => a.startsWith('--commit-results='));
  if (commitArg) {
    const batchArg = args.find((a) => a.startsWith('--batch='));
    return commitResults(commitArg.split('=').slice(1).join('='), batchArg ? Number(batchArg.split('=')[1]) : 1);
  }
  console.log('Usage: --generate-worklist [--batch-size=N] | --commit-results=path.json --batch=N | --status');
}

try {
  main();
} catch (err) {
  console.error(`[reverify] ${err.message ?? err}`);
  process.exitCode = 1;
}
