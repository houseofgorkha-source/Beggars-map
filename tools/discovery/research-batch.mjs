// Beggars Map — Phase 1.11: resumable batch research over the full
// 3,604-candidate Bengaluru discovery pool. LOCAL ONLY: never touches
// Supabase, never imports, makes no Google API calls. This script does NOT
// do the actual research itself — no search-API key/mechanism is wired
// into it, and genuine price research requires human-grade judgment
// (branch matching, reading a source's actual wording), not just a fetch.
// Its job is state management: pick the next N not-yet-researched
// candidates (worklist), and later validate+merge real research results
// (gathered by a human or research agent via their own tools) into the
// master dataset — durably, resumably, without ever re-researching a
// completed candidate or losing progress on interruption.
//
// State file: tools/discovery/output/research-state.json
//   { completed: { [place_id]: { status, batch, researched_at } },
//     in_progress: { [place_id]: { batch, started_at } } }
//
// Master results: tools/discovery/output/full-verification-results.json/.csv
// (append/merge across batches — never overwritten wholesale)
//
// Usage:
//   node tools/discovery/research-batch.mjs --generate-worklist --batch-size=50
//     -> writes output/research-batch-worklist-<ts>.json, marks those
//        place_ids in_progress
//   node tools/discovery/research-batch.mjs --commit-results=path.json --batch=1
//     -> validates each result, merges into the master dataset, marks
//        those place_ids completed
//   node tools/discovery/research-batch.mjs --status
//     -> prints how many of the 3,604 are completed/in_progress/pending

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyOffering, matchConfidence } from './matching.mjs';
import { AREAS } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(HERE, 'output');
const STATE_PATH = join(OUTPUT_DIR, 'research-state.json');
const MASTER_JSON_PATH = join(OUTPUT_DIR, 'full-verification-results.json');
const MASTER_CSV_PATH = join(OUTPUT_DIR, 'full-verification-results.csv');
const DEFAULT_BATCH_SIZE = 50;
const AREA_PER_BATCH_CAP = 6; // mild diversity guard so batch 1 isn't 50 candidates from one neighborhood

const AREA_ZONE = Object.fromEntries(AREAS.map((a) => [a.name, a.zone]));

// The 8 research-producible states, per Phase 1.11's explicit list.
// HUMAN_VERIFIED_LE_100 is deliberately absent — this script's commit path
// hard-rejects any result carrying it.
const RESEARCH_STATES = ['RESEARCHED', 'EVIDENCE_FOUND', 'QUALIFIES_PENDING_HUMAN_REVIEW', 'MATCH_UNCERTAIN', 'PRICE_UNKNOWN', 'PRICE_ABOVE_100', 'REJECTED', 'SOURCE_UNAVAILABLE'];

const STRONG_MEAL_KEYWORDS = ['darshini', 'tiffin', 'mess', 'thali', 'bhojanalaya', 'military hotel', 'udupi', 'canteen', 'meals', 'biryani', 'upahar', 'upahara', 'thindi', 'chicken'];
const WEAK_FOOD_KEYWORDS = ['restaurant', 'cafe', 'coffee', 'hotel', 'kitchen', 'bhavan', 'dosa'];

function scoreCandidate(candidate) {
  let score = 0;
  if (candidate.google_price_level === 'PRICE_LEVEL_INEXPENSIVE') score += 3;
  const text = `${candidate.name} ${candidate.primary_type ?? ''} ${(candidate.types ?? []).join(' ')}`.toLowerCase();
  if (STRONG_MEAL_KEYWORDS.some((k) => text.includes(k))) score += 3;
  else if (WEAK_FOOD_KEYWORDS.some((k) => text.includes(k))) score += 1;
  const hitCount = candidate.discovery_sources.length;
  if (hitCount > 1) score += Math.min(hitCount - 1, 3);
  return score;
}

function loadCandidates() {
  const files = readdirSync(OUTPUT_DIR)
    .filter((f) => f.startsWith('candidates-') && f.endsWith('.json'))
    .sort();
  if (files.length === 0) throw new Error('No candidates-*.json found.');
  const path = join(OUTPUT_DIR, files[files.length - 1]);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  return { path, candidates: data.candidates ?? data };
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

function writeMasterCsv(master) {
  const headers = [
    'place_id', 'name', 'address', 'latitude', 'longitude', 'zone', 'area', 'google_price_level', 'primary_type',
    'qualifying_status', 'offering_type', 'qualifying_meal_description', 'price_rupees', 'included_items',
    'evidence_source_url', 'match_confidence', 'image_count', 'research_timestamp', 'human_verification_status',
  ];
  const lines = [headers.join(',')];
  for (const r of master.results) {
    lines.push(
      [
        r.place_id, r.name, r.address, r.latitude, r.longitude, r.zone, r.area, r.google_price_level, r.primary_type,
        r.qualifying_status, r.offering_type, r.qualifying_meal_description, r.price_rupees, r.included_items,
        r.evidence_source_url, r.match_confidence, r.image_urls.length, r.research_timestamp, r.human_verification_status,
      ]
        .map(csvEscape)
        .join(',')
    );
  }
  writeFileSync(MASTER_CSV_PATH, lines.join('\n'), 'utf8');
}

function generateWorklist(batchSize) {
  const { path: candidatesPath, candidates } = loadCandidates();
  const state = loadState();

  const pending = candidates.filter((c) => !state.completed[c.place_id] && !state.in_progress[c.place_id]);
  const scored = pending.map((c) => ({ candidate: c, score: scoreCandidate(c) })).sort((a, b) => b.score - a.score);

  const areaCounts = new Map();
  const worklist = [];
  for (const entry of scored) {
    if (worklist.length >= batchSize) break;
    const area = entry.candidate.discovery_sources[0]?.area ?? 'unknown';
    const areaCount = areaCounts.get(area) ?? 0;
    if (areaCount >= AREA_PER_BATCH_CAP) continue;
    worklist.push(entry);
    areaCounts.set(area, areaCount + 1);
  }
  // Backfill if the area cap left the batch short (thin remaining pool).
  if (worklist.length < batchSize) {
    for (const entry of scored) {
      if (worklist.length >= batchSize) break;
      if (worklist.includes(entry)) continue;
      worklist.push(entry);
    }
  }

  const nextBatchNumber = (Object.values(state.completed).reduce((max, c) => Math.max(max, c.batch ?? 0), 0)) + 1;
  const startedAt = new Date().toISOString();
  for (const { candidate } of worklist) {
    state.in_progress[candidate.place_id] = { batch: nextBatchNumber, started_at: startedAt };
  }
  saveState(state);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const worklistPath = join(OUTPUT_DIR, `research-batch-worklist-${timestamp}.json`);
  const worklistData = {
    batch: nextBatchNumber,
    generated_at: startedAt,
    source_candidates_file: candidatesPath,
    count: worklist.length,
    candidates: worklist.map(({ candidate, score }) => {
      const area = candidate.discovery_sources[0]?.area ?? 'unknown';
      return {
        place_id: candidate.place_id,
        name: candidate.name,
        address: candidate.formatted_address,
        latitude: candidate.latitude,
        longitude: candidate.longitude,
        zone: AREA_ZONE[area] ?? 'unknown',
        area,
        google_price_level: candidate.google_price_level,
        primary_type: candidate.primary_type,
        website_uri: candidate.website_uri,
        phone: candidate.phone,
        priority_score: score,
      };
    }),
  };
  writeFileSync(worklistPath, JSON.stringify(worklistData, null, 2), 'utf8');

  console.log(`[research-batch] Batch ${nextBatchNumber}: ${worklist.length} candidates selected for research.`);
  console.log(`[research-batch] Worklist written: ${worklistPath}`);
  console.log(`[research-batch] Marked in_progress: ${worklist.length} place_ids.`);
  return worklistPath;
}

// Validates one research result. Hard-rejects HUMAN_VERIFIED_LE_100 —
// research findings can only ever reach QUALIFIES_PENDING_HUMAN_REVIEW.
function validateResult(r, index) {
  const errors = [];
  const where = `[${index}] (${r?.name ?? r?.place_id ?? 'unknown'})`;
  if (!r.place_id) errors.push('missing place_id');
  if (!RESEARCH_STATES.includes(r.qualifying_status)) {
    errors.push(`qualifying_status "${r.qualifying_status}" is not a valid research state (${RESEARCH_STATES.join('/')})`);
  }
  if (r.qualifying_status === 'QUALIFIES_PENDING_HUMAN_REVIEW') {
    if (!r.qualifying_meal_description || typeof r.price_rupees !== 'number' || r.price_rupees <= 0 || r.price_rupees > 100) {
      errors.push('QUALIFIES_PENDING_HUMAN_REVIEW requires qualifying_meal_description + price_rupees 1-100');
    }
    if (!r.evidence_source_url) errors.push('QUALIFIES_PENDING_HUMAN_REVIEW requires evidence_source_url');
    const offering = classifyOffering({ description: r.qualifying_meal_description, offeringType: r.offering_type });
    if (!offering.qualifies) errors.push(`does not actually qualify as a complete meal: ${offering.reason}`);
    if (r.match_confidence === 'low') errors.push('match_confidence is "low" — cannot mark QUALIFIES_PENDING_HUMAN_REVIEW on an unmatched branch');
  }
  if (r.human_verification_status === 'HUMAN_VERIFIED_LE_100' || r.qualifying_status === 'HUMAN_VERIFIED_LE_100') {
    errors.push('REFUSED: research can never set HUMAN_VERIFIED_LE_100 — only an explicit human verify-queue.mjs decision can');
  }
  return errors;
}

function commitResults(resultsPath, batchNumber) {
  const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
  if (!Array.isArray(results)) throw new Error(`${resultsPath} must be a JSON array of research results.`);

  const allErrors = [];
  results.forEach((r, i) => {
    const errs = validateResult(r, i);
    if (errs.length) allErrors.push(`${r.name ?? r.place_id ?? `#${i}`}: ${errs.join('; ')}`);
  });
  if (allErrors.length) {
    throw new Error(`Refusing to commit — ${allErrors.length} invalid result(s):\n  ${allErrors.join('\n  ')}`);
  }

  const state = loadState();
  const master = loadMaster();
  const existingIds = new Set(master.results.map((r) => r.place_id));
  const now = new Date().toISOString();

  let added = 0;
  let updated = 0;
  for (const r of results) {
    const record = { ...r, human_verification_status: null, research_timestamp: r.research_timestamp || now };
    const existingIndex = master.results.findIndex((x) => x.place_id === r.place_id);
    if (existingIndex >= 0) {
      master.results[existingIndex] = record;
      updated++;
    } else {
      master.results.push(record);
      added++;
    }
    state.completed[r.place_id] = { status: r.qualifying_status, batch: batchNumber, researched_at: record.research_timestamp };
    delete state.in_progress[r.place_id];
  }

  master.run.batches.push({ batch: batchNumber, committed_at: now, count: results.length, added, updated });
  master.run.total_researched = Object.keys(state.completed).length;
  master.run.last_updated = now;

  saveState(state);
  writeFileSync(MASTER_JSON_PATH, JSON.stringify(master, null, 2), 'utf8');
  writeMasterCsv(master);

  console.log(`[research-batch] Committed batch ${batchNumber}: ${added} new, ${updated} updated. Master total: ${master.results.length}.`);
  console.log(`[research-batch] Master: ${MASTER_JSON_PATH}`);
  console.log(`[research-batch] State: ${STATE_PATH}`);
}

function printStatus() {
  const { candidates } = loadCandidates();
  const state = loadState();
  const completed = Object.keys(state.completed).length;
  const inProgress = Object.keys(state.in_progress).length;
  const pending = candidates.length - completed - inProgress;
  console.log(`[research-batch] Total candidates: ${candidates.length}`);
  console.log(`[research-batch] Completed: ${completed}`);
  console.log(`[research-batch] In progress (worklist generated, not yet committed): ${inProgress}`);
  console.log(`[research-batch] Pending: ${pending}`);
  const statusCounts = {};
  for (const c of Object.values(state.completed)) statusCounts[c.status] = (statusCounts[c.status] ?? 0) + 1;
  console.log(`[research-batch] Completed by status: ${JSON.stringify(statusCounts)}`);
}

function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const args = process.argv.slice(2);
  if (args.includes('--status')) return printStatus();

  if (args.includes('--generate-worklist')) {
    const sizeArg = args.find((a) => a.startsWith('--batch-size='));
    const batchSize = sizeArg ? Number(sizeArg.split('=')[1]) : DEFAULT_BATCH_SIZE;
    generateWorklist(batchSize);
    return;
  }

  const commitArg = args.find((a) => a.startsWith('--commit-results='));
  if (commitArg) {
    const batchArg = args.find((a) => a.startsWith('--batch='));
    const batchNumber = batchArg ? Number(batchArg.split('=')[1]) : 1;
    commitResults(commitArg.split('=').slice(1).join('='), batchNumber);
    return;
  }

  console.log('Usage: --generate-worklist [--batch-size=N] | --commit-results=path.json --batch=N | --status');
}

try {
  main();
} catch (err) {
  console.error(`[research-batch] ${err.message ?? err}`);
  process.exitCode = 1;
}
