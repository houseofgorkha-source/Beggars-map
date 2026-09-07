@AGENTS.md

# Location Architecture Roadmap

Authoritative future-context roadmap for Beggars Map's map/location provider stack, based on the approved "Beggars Map Location Stack" architecture investigation (3 Sep 2026). This section is the durable plan; **live deployment status for any stage below is tracked in AGENTS.md, not here** — check AGENTS.md's "Deployment status" and "Location provenance (Stage 2A)" sections before assuming anything here has shipped to production.

The original investigation defined 3 implementation stages. Stage 2 was subsequently, deliberately split into **Stage 2A** and **Stage 2B** during implementation — that split is intentional, not a deviation from the original plan.

## Stage 1: OLA place-selection fix

- Preserve OLA `types` from place predictions.
- Prefer real POI types over `street_address` when resolving same-name candidates.
- Fix the demonstrated branch/coordinate ambiguity.
- Require explicit pin confirmation before submission.

This stage is the low-cost accuracy fix and must remain conceptually separate from later provider migration.

## Stage 2A: Location Provenance + Evidence Foundation

- Add location provenance and confidence fields.
- Track `location_source`, `location_confidence`, verification metadata, and provider place IDs.
- Record provenance across web, mobile, paste-link, and discovery-import paths.
- Protect verification fields from ordinary user self-assignment.
- Support admin provenance/audit behavior.

This stage deliberately establishes the plumbing only. It does **NOT** perform actual coordinate verification. Production deployment status must remain whatever is currently documented in AGENTS.md — do not assume production migration/deployment has occurred.

## Stage 2B: Coordinate Verification — FUTURE / DEFERRED

This is the actual verification portion of the original Stage 2.

- Use Google Places **selectively** to cross-check a newly submitted human/device coordinate — not as the coordinate source of record.
- The database's human-confirmed/user-submitted coordinate remains canonical.
- Store Google `place_id`, not Google's latitude/longitude.
- Use independent-source agreement and distance gating to determine confidence.
- Ambiguous/distant matches must be flagged for human/admin review rather than automatically correcting coordinates.
- Admin review/backfill should be introduced only when this stage is explicitly approved.
- Before implementation, re-evaluate Google API/server-side key architecture, pricing, licensing, and the actual production data/requirements at that time.

**Do not implement Stage 2B now unless explicitly instructed.**

## Stage 3: Web MapLibre Migration — FUTURE / SCALE-TRIGGERED

- Move web map rendering from Google Maps JS to MapLibre.
- Mobile already uses MapLibre.
- Keep the tile provider swappable.
- OLA can remain the current base-map source while a future self-hosted PMTiles architecture is considered.

This stage is primarily driven by Google Maps rendering usage/cost approaching the relevant free-tier limit, not by a fixed calendar date or arbitrary user count.

**Do not start this migration prematurely.**

## Architectural principles that must survive all stages

- Our database is the canonical listing coordinate store.
- A provider's search/autocomplete result is a hint, not automatically truth.
- Never silently auto-correct a coordinate from provider disagreement.
- Google Places is for identity/verification, not permanent coordinate storage.
- Never store Google Places latitude/longitude permanently.
- Do not combine Google Places content with a non-Google map in a way prohibited by Google's terms.
- OLA remains useful for everyday India-focused search/labels/base tiles while its known coordinate-quality limitations are handled.
- OSM public infrastructure must not be treated as production infrastructure; self-hosting/buying appropriate OSM-derived infrastructure is a separate consideration.
- Degrade rather than fabricate a location when a provider fails.

## Sequencing rule

Stage 2A is complete foundation work. Stage 2B and Stage 3 are future stages and must remain separately scoped. Do not infer missing requirements or begin either stage without explicit approval.

# Current Project State (as of 2026-09-08)

Concise, factual snapshot of what is actually true right now — kept separate from the roadmap above, which is durable/forward-looking. Full narrative and historical detail for everything below lives in AGENTS.md; this section exists so a fresh session can get oriented without reading that much longer log first. Verify against AGENTS.md and production directly before relying on this for anything consequential — it decays the same way any status snapshot does.

## Production listings

**60 listings live in production, 0 hidden.** The original 28 (seed/import/user-submitted, predating this pass) plus 32 newly imported from Discovery Workbench Batch 3 and unhidden (see below). Confirmed directly against production, not inferred.

## Discovery Workbench Batch 3 — completed and published

Fully closed out, end to end:
- 100 candidates were researched by a remote intern through the deployed `discovery.html` page against **production**'s own `discovery-workbench` Edge Function — a separate path from the owner's local `workbench-sync.mjs` (see below).
- All 100 rows' completed research (Number Valid / Menu List Under 100 / Menu Details/Notes) were pulled from production into the local WIP xlsx and verified field-for-field; photos were downloaded to `tools/discovery/photos/<place_id>/`.
- Production's `discovery_batch_rows` was purged clean afterward (0 rows), verified directly.
- Of the 100, 42 qualified (`Menu List Under 100 = Yes`): 32 were new inserts (their prices corrected by `import-excel.mjs`'s rupee-prefix fix, commit `2cdab35`, after 11 were initially found using a bare quantity number instead of the real price); 10 were already-imported duplicates, correctly skipped.
- All 32 new listings were imported `is_hidden = true`, then unhidden via the new admin `bulkUnhide` action (see commits below) — confirmed live, 0 hidden remain.

## Discovery Workbench — current workflow and safeguards

- **`tools/discovery/workbench-sync.mjs` is LOCAL-ONLY by design** — no `--linked`/`--production` code path exists anywhere in it, and it refuses those flags outright if passed. It only ever pushes/pulls against the local Docker Supabase stack.
- **Production's Discovery Workbench is a separate, independently-deployed instance** (its own `discovery_batch_rows` table, `discovery-workbench` Edge Function, and the deployed `discovery.html` page) that a real intern uses directly, authenticated via their own Google OAuth session — not reachable by `workbench-sync.mjs` at all.
- Getting a batch in front of the intern therefore requires a deliberate, separate, one-time production-transfer step (as was done for Batch 3) — `workbench-sync.mjs --push` alone only ever stages a batch locally.
- Eligibility is a permanent rule on one column only: `Menu List Under 100` blank = eligible; `No`/`Yes` = permanently excluded (a decision already made elsewhere). `Number Valid` plays no role in eligibility.
- `reconcileState()` re-reads the live (local) table before every command and self-heals the local state file against it — adopts orphaned live rows, completes rows no longer live. This is what safely closed out a stale, all-blank local leftover from Batch 3's own local testing (100 rows, reconciled straight to `completed`, zero Excel writes) before Batch 4 could be pushed.
- **Never run `--pull` against a batch that hasn't been confirmed to hold genuine, current research.** Pulling writes directly into the WIP xlsx's `Number Valid`/`Menu List Under 100`/`Menu Details/Notes` columns — a stale or blank batch would silently overwrite real, already-correct data with blanks.

## Discovery Workbench Batch 4 — pushed locally, NOT yet in production

- Pushed via `workbench-sync.mjs --push --batch-size=100` (the script's own default is 50 — 100 was passed explicitly to match the standard batch size).
- **Batch ID 4, 100 candidates, 0 photos** (none of these 100 place_ids have local photos on disk yet — expected, not an error).
- Confirmed staged in the **local** Docker stack's `discovery_batch_rows` only. Production was directly re-checked immediately after: still 0 `discovery_batch_rows` and 60 listings, unchanged.
- **Not yet visible to the intern.** That requires the same kind of explicit, separate production-transfer step Batch 3 needed — not performed for Batch 4, and out of scope of this pass.

## Latest relevant commits

- `2cdab35` — fix: parse rupee-prefixed discovery prices correctly (the `minPriceFrom()` fix behind all 32 Batch 3 imports having correct, non-quantity prices)
- `fe09249` — fix: add Select All checkbox to admin Listings table
- `6c23372` — feat: add admin bulkUnhide action for batch-unhiding listings
- `b900912` — feat: add data-driven query-param SEO/sitemap for real search intent

## Parked / uncommitted — do not touch without explicit instruction

- **The "No Answer" call-attempt counter feature is parked, unfinished, in a local git stash** (`parked: No Answer counter (unfinished, for later)`) — it is not in tracked history and not in production. Do not revive it without being explicitly asked.
- **`.claude/settings.json` carries a pre-existing, intentional local modification** unrelated to any project work above — do not commit it or otherwise resolve it without being explicitly asked.
