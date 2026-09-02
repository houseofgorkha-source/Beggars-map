// Beggars Map — Phase 1.6 local human verification queue (interactive CLI).
//
// Presents a prioritized subset of the discovery candidates to a human
// reviewer, one at a time, and records their independent verification
// decision. NEVER touches Supabase, NEVER imports, NEVER auto-approves
// from google_price_level alone — approval requires a real COMPLETE MEAL
// (not a single cheap item — see matching.mjs's classifyOffering, product
// policy corrected 2026-09-01), a real price 1-100, a real source, and a
// location-match check that is hard-blocked (not just warned) when
// confidence comes out 'low'.
//
// Data boundary: Google's name/address/coordinates/priceLevel are treated
// as a starting hint, not owned Beggars Map data. An APPROVE_LE_100 record
// captures what the human actually confirmed (name, location, price, item)
// plus full provenance — not a raw copy of the Places API response. The
// place_id is retained only for dedup/reference, as instructed.
//
// Usage:
//   node tools/discovery/verify-queue.mjs                 (interactive, up to 20 candidates)
//   node tools/discovery/verify-queue.mjs --limit=10
//
// Per-candidate input (one action key, then prompted follow-ups):
//   a  APPROVE ≤₹100   (asks: qualifying item/offering description, offering
//                        type [BREAKFAST/MEAL/THALI/COMBO/SINGLE_ITEM], price
//                        1-100, evidence source URL, evidence location text,
//                        optional note — refused if the offering doesn't
//                        read as a complete meal, see classifyOffering)
//   p  PRICE ABOVE ₹100 (asks: item, price, source URL, location text, optional note)
//   r  REJECT           (asks: optional note)
//   u  UNCERTAIN        (asks: optional note)
//   s  SKIP             (asks: optional note)
//   q  QUIT & SAVE PROGRESS

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { matchConfidence, classifyOffering, OFFERING_TYPES } from './matching.mjs';

// readline/promises' rl.question() only resolves once against a piped
// (non-TTY) stdin in this environment — the second call hangs forever
// (reproduced in isolation, unrelated to this script's own logic). This
// pull-based line reader over the plain event-based `readline` module
// works reliably for both a real terminal and piped/redirected input.
function makeLineReader(input) {
  const rl = createInterface({ input, terminal: false });
  const queue = [];
  const waiters = [];
  let ended = false;

  rl.on('line', (line) => {
    if (waiters.length) waiters.shift()(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    ended = true;
    while (waiters.length) waiters.shift()(null);
  });

  return {
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      rl.close();
    },
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(HERE, 'output');
const DEFAULT_LIMIT = 20;

const FOOD_KEYWORDS = ['darshini', 'udupi', 'mess', 'tiffin', 'restaurant', 'upahar', 'upahara', 'bhavan', 'cafe', 'coffee', 'hotel', 'thindi', 'meals', 'dosa', 'kitchen'];

function latestFile(prefix) {
  if (!existsSync(OUTPUT_DIR)) return null;
  const files = readdirSync(OUTPUT_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort();
  return files.length ? join(OUTPUT_DIR, files[files.length - 1]) : null;
}

function loadCandidates(explicitPath) {
  const path = explicitPath || latestFile('candidates-');
  if (!path) throw new Error('No candidates-*.json found. Run discover.mjs first.');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  return { path, candidates: data.candidates ?? data };
}

function loadPriorEvidence() {
  const path = latestFile('price-verification-');
  const byPlaceId = new Map();
  if (!path) return byPlaceId;
  const data = JSON.parse(readFileSync(path, 'utf8'));
  for (const r of data.records ?? []) byPlaceId.set(r.place_id, r);
  return byPlaceId;
}

function isFoodType(candidate) {
  const haystack = `${candidate.name} ${candidate.primary_type ?? ''} ${(candidate.types ?? []).join(' ')}`.toLowerCase();
  return FOOD_KEYWORDS.some((k) => haystack.includes(k));
}

// Priority tiers per spec: 1) INEXPENSIVE, 2) food/restaurant type,
// 3) existing price evidence, 4) unresolved, 5) other. Implemented as a
// composite sort key — lower is higher priority — rather than independent
// buckets, so a candidate satisfying more/earlier tiers always outranks
// one satisfying fewer/later ones.
function priorityKey(candidate, evidence) {
  const notInexpensive = candidate.google_price_level === 'PRICE_LEVEL_INEXPENSIVE' ? 0 : 1;
  const notFood = isFoodType(candidate) ? 0 : 1;
  const hasEvidence = evidence && evidence.status !== 'DISCOVERED';
  const noEvidence = hasEvidence ? 0 : 1;
  return [notInexpensive, notFood, noEvidence];
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function searchLink(name, address, site) {
  const q = encodeURIComponent(`${name} ${address}${site ? ` site:${site}` : ''}`);
  return `https://www.google.com/search?q=${q}`;
}

function printCandidate(index, total, candidate, evidence) {
  console.log('\n' + '='.repeat(72));
  console.log(`[${index + 1}/${total}] ${candidate.name}`);
  console.log('='.repeat(72));
  console.log(`Google price signal: ${candidate.google_price_level ?? '(unset)'}  <-- SIGNAL ONLY, not price evidence`);
  const sources = candidate.discovery_sources.map((s) => `${s.query} @ ${s.area}`).join('; ');
  console.log(`Discovered via:      ${sources}`);
  console.log(`ADDRESS (match on this): ${candidate.formatted_address}`);
  console.log(`Coordinates:         ${candidate.latitude}, ${candidate.longitude}`);
  console.log(`place_id:            ${candidate.place_id}`);

  if (evidence) {
    console.log(`\nExisting state (Phase 1.5): ${evidence.status}`);
    if (evidence.found_items?.length) {
      console.log('Existing found items:');
      for (const it of evidence.found_items) console.log(`  - ${it.item}: ₹${it.price_rupees}`);
    }
    if (evidence.confidence_notes) console.log(`Notes: ${evidence.confidence_notes}`);
    if (evidence.evidence_source_url) console.log(`Source: ${evidence.evidence_source_url}`);
  } else {
    console.log('\nExisting state: DISCOVERED (no prior verification attempt)');
  }

  console.log('\nManual investigation links (for YOU to open — nothing here is auto-fetched):');
  console.log(`  Google:  ${searchLink(candidate.name, candidate.formatted_address)}`);
  console.log(`  Zomato:  ${searchLink(candidate.name, candidate.formatted_address, 'zomato.com')}`);
  console.log(`  Swiggy:  ${searchLink(candidate.name, candidate.formatted_address, 'swiggy.com')}`);
  console.log(`  Justdial: ${searchLink(candidate.name, candidate.formatted_address, 'justdial.com')}`);

  console.log('\nAction? [a]pprove<=100  [p]rice>100  [r]eject  [u]ncertain  [s]kip  [q]uit&save');
}

// Returns null on EOF (piped input ran out) as well as on a blank/invalid
// answer's downstream check — callers treat null as "can't proceed."
async function ask(reader, question) {
  process.stdout.write(question);
  const answer = await reader.next();
  return answer === null ? null : answer.trim();
}

async function collectPriceFields(reader, requireCap) {
  const item = await ask(reader, '  Qualifying item/offering description: ');
  if (item === null) return null;
  let offeringType = null;
  if (requireCap) {
    // Approval only — a price-above-100 record doesn't need this since it
    // can never be approved anyway.
    const raw = await ask(reader, `  Offering type (${OFFERING_TYPES.join('/')}): `);
    if (raw === null) return null;
    offeringType = raw.trim().toUpperCase();
    if (!OFFERING_TYPES.includes(offeringType)) {
      console.log(`  ! Offering type must be one of ${OFFERING_TYPES.join('/')}.`);
      return null;
    }
  }
  const priceRaw = await ask(reader, '  Price (rupees, integer): ');
  if (priceRaw === null) return null;
  const price = Number(priceRaw);
  if (!Number.isInteger(price) || price <= 0 || (requireCap && price > 100)) {
    console.log(`  ! Invalid price for this action (${requireCap ? '1-100' : 'positive integer'} required). Aborting this field set.`);
    return null;
  }
  const sourceUrl = await ask(reader, '  Evidence source URL: ');
  if (!sourceUrl) {
    console.log('  ! Evidence source URL is required.');
    return null;
  }
  const locationText = await ask(reader, '  Location/address text as stated at that source: ');
  if (!locationText) {
    console.log('  ! Evidence location text is required (used for the branch-match check).');
    return null;
  }
  if (requireCap) {
    const offering = classifyOffering({ description: item, offeringType });
    if (!offering.qualifies) {
      console.log(`  ! REFUSED: ${offering.reason}. A single cheap item does not qualify — Beggars Map lists complete affordable meals, not individual cheap items.`);
      return null;
    }
  }
  return { item, price, sourceUrl, locationText, offeringType };
}

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : DEFAULT_LIMIT;

  const { path: candidatesPath, candidates } = loadCandidates();
  const priorEvidence = loadPriorEvidence();

  const prioritized = [...candidates].sort((a, b) => compareKeys(priorityKey(a, priorEvidence.get(a.place_id)), priorityKey(b, priorEvidence.get(b.place_id))));
  const queue = prioritized.slice(0, Math.max(1, limit));

  console.log(`Beggars Map — local verification queue. Supabase: NOT TOUCHED by this script.`);
  console.log(`Source: ${candidatesPath}`);
  console.log(`Presenting ${queue.length} of ${candidates.length} candidates (priority: INEXPENSIVE > food-type > has prior evidence > rest).\n`);

  const reader = makeLineReader(process.stdin);
  const decisions = [];
  const approved = [];
  let quit = false;

  for (let i = 0; i < queue.length && !quit; i++) {
    const candidate = queue[i];
    const evidence = priorEvidence.get(candidate.place_id) ?? null;
    printCandidate(i, queue.length, candidate, evidence);

    let recorded = false;
    while (!recorded) {
      const rawAction = await ask(reader, '> ');
      if (rawAction === null) {
        // Input ended (EOF) — save progress as if the reviewer quit.
        quit = true;
        recorded = true;
        break;
      }
      const action = rawAction.toLowerCase();

      if (action === 'q') {
        quit = true;
        recorded = true;
        break;
      }

      if (action === 'a' || action === 'p') {
        const fields = await collectPriceFields(reader, action === 'a');
        if (!fields) continue; // re-prompt the same candidate

        const confidence = matchConfidence({
          candidateName: candidate.name,
          candidateAddress: candidate.formatted_address,
          evidenceLocationText: fields.locationText,
        });

        if (action === 'a' && confidence === 'low') {
          console.log(
            `  ! REFUSED: match confidence is 'low' — the evidence location ("${fields.locationText}") does not ` +
              `clearly correspond to this candidate's address ("${candidate.formatted_address}"). ` +
              `Choose [u]ncertain or [r]eject instead, or re-enter with a location that actually matches this branch.`
          );
          continue; // re-prompt same candidate, does NOT record an approval
        }

        const note = await ask(reader, '  Optional note (enter to skip): ');
        const decision = {
          place_id: candidate.place_id,
          name: candidate.name,
          address: candidate.formatted_address,
          action: action === 'a' ? 'HUMAN_VERIFIED_LE_100' : 'PRICE_ABOVE_100',
          offering_type: fields.offeringType,
          qualifying_item: fields.item,
          price_rupees: fields.price,
          evidence_source_url: fields.sourceUrl,
          evidence_location_text: fields.locationText,
          match_confidence: confidence,
          note: note || null,
          reviewed_at: new Date().toISOString(),
        };
        decisions.push(decision);

        if (action === 'a') {
          approved.push({
            place_id: candidate.place_id,
            name: candidate.name,
            latitude: candidate.latitude,
            longitude: candidate.longitude,
            price_rupees: fields.price,
            note: note || null,
            verification_status: 'verified', // matches import-approved.mjs's expected shape
            price_evidence_source: fields.sourceUrl,
            offering_type: fields.offeringType, // BREAKFAST/MEAL/THALI/COMBO — never SINGLE_ITEM, gated in collectPriceFields
            qualifying_item: fields.item,
            google_price_level_signal: candidate.google_price_level,
            verification: {
              evidence_source_url: fields.sourceUrl,
              evidence_location_text: fields.locationText,
              match_confidence: confidence,
              verified_at: new Date().toISOString(),
              reviewed_via: 'verify-queue.mjs (human CLI review)',
            },
          });
        }
        recorded = true;
      } else if (action === 'r' || action === 'u' || action === 's') {
        const note = await ask(reader, '  Optional note (enter to skip): ');
        decisions.push({
          place_id: candidate.place_id,
          name: candidate.name,
          address: candidate.formatted_address,
          action: action === 'r' ? 'REJECTED' : action === 'u' ? 'UNCERTAIN' : 'SKIP',
          qualifying_item: null,
          price_rupees: null,
          evidence_source_url: null,
          evidence_location_text: null,
          match_confidence: null,
          note: note || null,
          reviewed_at: new Date().toISOString(),
        });
        recorded = true;
      } else {
        console.log('  Unrecognized action. Use a / p / r / u / s / q.');
      }
    }
  }

  reader.close();

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = join(OUTPUT_DIR, 'verified-candidates.json');

  const counts = { HUMAN_VERIFIED_LE_100: 0, REJECTED: 0, PRICE_ABOVE_100: 0, UNCERTAIN: 0, SKIP: 0 };
  for (const d of decisions) counts[d.action] = (counts[d.action] ?? 0) + 1;

  writeFileSync(
    outPath,
    JSON.stringify(
      {
        run: {
          source_candidates_file: candidatesPath,
          presented: queue.length,
          reviewed: decisions.length,
          quit_early: quit,
          status_counts: counts,
          generated_at: new Date().toISOString(),
        },
        decisions,
        approved,
      },
      null,
      2
    ),
    'utf8'
  );

  console.log('\n=== LOCAL VERIFICATION QUEUE — SESSION SUMMARY (no database touched) ===');
  console.log(`Presented: ${queue.length}   Reviewed: ${decisions.length}${quit ? '  (quit early)' : ''}`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(18)} ${v}`);
  console.log(`Output written: ${outPath}`);
}

main();
