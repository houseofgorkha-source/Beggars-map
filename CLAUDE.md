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

# Community Reviews + Listing Corrections (Phase 2 + Phase 3, as of 2026-09-09) — LOCAL ONLY, not deployed

Built and committed (`a161751`, not yet pushed as of this writing — check "Latest relevant commits" below for current push status), but **nothing in this feature has touched production**: migrations 0022-0024 are local-only, the `admin-corrections` Edge Function has never been deployed, and no production `listings`/`listing_reviews`/`listing_corrections` row has ever been written by this work. Read this section before starting Phase 4 or any production deployment of this feature.

## What this is

Clicking "Review" on a listing (list row or map popup, same as before) now opens a two-page overlay instead of the old read-only note/rating display:

- **Page 1 (default, read-only)** — "From the listing" (the creator's own note, or the price if there's no note — never blank), "Your review" (only if the current anonymous session already has one), "Reviews from others", and one bottom button: **"Add Review"** if the session has no review yet, **"Edit Review"** if it does.
- **Page 2 (opened by that button)** — Restaurant name / Dishes & prices / Location, each shown **read-only with an "Edit X" toggle** (editing reveals an inline editor with its own Save/Cancel; Save only stages the value locally, nothing is written yet), then Your rating / Your review / Photos (always directly editable, no toggle), then one **"Submit Review"** button. A "← Back" link returns to page 1 without submitting. Both pages share one unchanged header (restaurant name + close button).

Submitting splits into two independent write paths, by design:
- **Community content** (rating, review text, photos) → always an auto-published `listing_reviews` upsert (one row per listing per anonymous session, editable by its own owner, never overwritten by another user).
- **Canonical corrections** (a *changed* name/dishes/location — unchanged fields create no row at all) → a `listing_corrections` row per changed field, `status: 'pending'`. **Nothing here ever writes to `listings` directly** — the public client has no RLS path to do that; the only way a correction reaches the canonical row is the new admin Corrections queue's **approve** action, via the `admin-corrections` Edge Function running as `service_role`.

## Key files

- Schema: `supabase/migrations/0022_listing_reviews.sql` (`listing_reviews`, `listing_review_photos`), `0023_listing_corrections.sql` (`listing_corrections`), `0024_audit_log_correction_actions.sql` (widens `admin_audit_log`'s `action`/`target_type` CHECK constraints for `approve_correction`/`reject_correction`/`delete_review` and `listing_correction`/`listing_review`).
- Backend: `supabase/functions/admin-corrections/index.ts` (list/approve/reject/deleteReview), `_shared/listingActions.ts`'s new `applyListingCorrection`/`rejectListingCorrection` (the only code path that ever writes a correction into `listings`, with full before/after audit logging), `_shared/adminAuth.ts` (widened `AuditAction`/target-type unions).
- Frontend: `web/src/components/ReviewOverlay.tsx` (the two-page overlay described above — this is where almost all the new UI logic lives), `web/src/components/DishPriceRows.tsx` (extracted from `AddListingModal.tsx` for reuse in the dishes-editing section), `web/src/lib/reviews.ts` / `reviewValidation.ts` / `corrections.ts` (data-access + pure validation).
- Admin: `web/src/admin/views/CorrectionsQueue.tsx` (new nav tab — list pending corrections with a current-vs-proposed diff, Approve, or Reject with a required reason).
- **`AddListingModal.tsx` is untouched** — after an earlier pass tried reusing it in a "review mode" and was explicitly reverted, it's back to being create-mode-only, byte-for-byte its pre-this-feature self (the one harmless diff is the `DishPriceRows` extraction, a pure markup move).

## Deliberate scoping decision, not a bug

"Edit location" (and the whole location-correction section) only appears when `ReviewOverlay` is opened from the **list row's own Review link** — not from the map popup's. The popup's `ListingDetailModal.tsx` unmounts while a location is being picked (`hidePopup` in `MapView.tsx`), which would silently discard an in-progress correction form; fixing that would mean touching fragile, already-documented popup-positioning/marker-rebuild logic outside this feature's scope, so it was deliberately left out of scope. Name and dishes corrections work identically from both entry points.

## Verification already done (local only)

Full `npm test` (423 passing — the only failures are pre-existing, out-of-scope Discovery Workbench tooling issues, unrelated), `tsc --noEmit` and `npm run build` clean on both migrations, plus repeated real-browser Playwright passes covering: per-field edit/save/cancel, the ₹30-₹100 dish validation still enforced on Save, the real map-picking round-trip, only-changed-fields-create-corrections (verified directly against the DB), the canonical `listings` row staying untouched after submit, two independent anonymous sessions never overwriting each other's review, Add Listing's own create flow being unaffected, and no CSS overflow on desktop or 390px mobile. None of this exercised production.

## Not yet done — do this before/at the start of Phase 4 if corrections should go live

- Migrations 0022-0024 have **not** been applied to production (same direct `supabase db query --linked` method every prior migration in this repo used — never a bare `db push`, see AGENTS.md's own migration-ledger caveats).
- `admin-corrections` has **not** been deployed (`npx supabase functions deploy admin-corrections --project-ref nvingzluboafxzxgxxwc`, same convention as every other admin-* function).
- No real interactive walkthrough of the admin Corrections queue has happened yet (needs a human's own Google OAuth session, same limitation as every other Admin v2 feature before it).

# Current Project State (as of 2026-09-08)

Concise, factual snapshot of what is actually true right now — kept separate from the roadmap above, which is durable/forward-looking. Full narrative and historical detail for everything below lives in AGENTS.md; this section exists so a fresh session can get oriented without reading that much longer log first. Verify against AGENTS.md and production directly before relying on this for anything consequential — it decays the same way any status snapshot does.

## Production listings

**89 listings live in production, 0 hidden.** The original 28 (seed/import/user-submitted, predating this pass) plus 32 from Discovery Workbench Batch 3 plus 29 from Discovery Workbench Batch 4 (both fully imported and unhidden — see below). Confirmed directly against production, not inferred.

## Discovery Workbench Batch 3 — completed and published

Fully closed out, end to end:
- 100 candidates were researched by a remote intern through the deployed `discovery.html` page against **production**'s own `discovery-workbench` Edge Function — a separate path from the owner's local `workbench-sync.mjs` (see below).
- All 100 rows' completed research (Number Valid / Menu List Under 100 / Menu Details/Notes) were pulled from production into the local WIP xlsx and verified field-for-field; photos were downloaded to `tools/discovery/photos/<place_id>/`.
- Production's `discovery_batch_rows` was purged clean afterward (0 rows), verified directly.
- Of the 100, 42 qualified (`Menu List Under 100 = Yes`): 32 were new inserts (their prices corrected by `import-excel.mjs`'s rupee-prefix fix, commit `2cdab35`, after 11 were initially found using a bare quantity number instead of the real price); 10 were already-imported duplicates, correctly skipped.
- All 32 new listings were imported `is_hidden = true`, then unhidden via the new admin `bulkUnhide` action (see commits below) — confirmed live, 0 hidden remain.

## Discovery Workbench Batch 4 — completed and published

Fully closed out end to end, following the same lifecycle as Batch 3 (see "The established Discovery Workbench batch lifecycle" below):
- 100 candidates were pushed locally (`workbench-sync.mjs --push --batch-size=100`), then transferred to production's `discovery_batch_rows` for the intern via the same one-time production-transfer step Batch 3 needed.
- Of the 100, 94 had at least one researched field filled in; 29 qualified (`Menu List Under 100 = Yes`), 33 were marked `No`, 6 were left fully blank by the intern.
- All 100 rows' research was pulled from production into the local WIP xlsx and verified field-for-field (94 rows updated, 0 unrelated rows touched, 0 conflicts with existing Excel data); 45 photos across 29 place_ids were downloaded to `tools/discovery/photos/<place_id>/`.
- Production's `discovery_batch_rows` and `discovery-photos` bucket were purged clean afterward (0 rows, 0 files), verified directly.
- All 29 qualifying rows were new inserts (0 already-imported duplicates from this batch) — imported `is_hidden = true` via `import-excel.mjs --production --execute`, then unhidden via the admin `bulkUnhide` action — confirmed live: production reached 89 listings, 0 hidden.

## Discovery Workbench Batch 5 — staged in production, NOT yet researched

- Pushed locally (`workbench-sync.mjs --push --batch-size=100`, batch ID 5, 100 candidates, 0 photos — none of these place_ids have local photos on disk yet) and transferred to production the same way Batches 3 and 4 were.
- Confirmed live in production: `discovery_batch_rows` holds exactly batch_id `5`, 100 rows, 100 distinct place_ids, 100% match against the local set, 0 duplicates. Production listings unaffected throughout this transfer (89, 0 hidden).
- **Not yet researched by the intern.** Do NOT pull, purge, import, or publish Batch 5 until the intern's research is complete — as of now it is staged and visible to the intern, nothing more.

## The established Discovery Workbench batch lifecycle

Production Workbench → Pull → verify Excel → purge Workbench → production import dry-run → import → verify → admin bulk unhide → final verification.

This is the exact sequence both Batch 3 and Batch 4 followed end to end and is the one to follow for every future batch — see the Batch 4 section above for what "verify" means at each step (field-for-field Excel/photo checks before purge; dry-run review before import; count/audit/integrity checks before and after unhide).

## Discovery Workbench — current workflow and safeguards

- **`tools/discovery/workbench-sync.mjs` is LOCAL-ONLY by design** — no `--linked`/`--production` code path exists anywhere in it, and it refuses those flags outright if passed. It only ever pushes/pulls against the local Docker Supabase stack.
- **Production's Discovery Workbench is a separate, independently-deployed instance** (its own `discovery_batch_rows` table, `discovery-workbench` Edge Function, and the deployed `discovery.html` page) that a real intern uses directly, authenticated via their own Google OAuth session — not reachable by `workbench-sync.mjs` at all.
- Getting a batch in front of the intern therefore requires a deliberate, separate, one-time production-transfer step (as done for Batches 3, 4, and 5) — `workbench-sync.mjs --push` alone only ever stages a batch locally.
- Eligibility is a permanent rule on one column only: `Menu List Under 100` blank = eligible; `No`/`Yes` = permanently excluded (a decision already made elsewhere). `Number Valid` plays no role in eligibility.
- `reconcileState()` re-reads the live (local) table before every command and self-heals the local state file against it — adopts orphaned live rows, completes rows no longer live. This is what safely closed out a stale, all-blank local leftover from Batch 3's own local testing (100 rows, reconciled straight to `completed`, zero Excel writes) before Batch 4 could be pushed.
- **Never run `--pull` against a batch that hasn't been confirmed to hold genuine, current research.** Pulling writes directly into the WIP xlsx's `Number Valid`/`Menu List Under 100`/`Menu Details/Notes` columns — a stale or blank batch would silently overwrite real, already-correct data with blanks.
- **A stale LOCAL batch can outlive a batch that was already fully closed out in production.** Local and production keep independent `discovery_batch_rows` copies, so purging production's rows when closing out a batch does not touch local's own original, all-blank copy from that batch's initial local push. Before Batch 5 could be pushed, local still held Batch 4's original 100 blank rows even though the state file already had them marked `completed` — `reconcileState()` only checks `in_progress`, not `completed`, so it would have silently re-adopted them, blocking the next `--push` and, had `--pull` been run instead, overwriting valid Excel data with those stale blanks. Fix: verify and delete the stale local rows directly (after confirming no local photos exist for them) — never run `--pull`/`--pull --purge` to "clean up" a batch already known to be closed out elsewhere.
- **`supabase storage rm --linked --experimental` silently no-ops without `--yes` in a non-interactive shell** — it defaults the confirmation prompt to "No," still exits 0, and returns `{"deleted":[]}` with no error. A purge that trusts that exit code alone can report success while deleting nothing. Always pass `--yes` explicitly for a non-interactive storage delete, and always re-list the bucket afterward to independently confirm it's actually empty before purging the corresponding database rows — this is what caught it during Batch 4's photo purge.

## Latest relevant commits

- `a161751` — feat: add community reviews and listing corrections (Phase 2 + Phase 3 — see the dedicated section above; local-only, not yet applied/deployed to production)
- `758f5fc` — docs: add current project state snapshot to CLAUDE.md
- `2cdab35` — fix: parse rupee-prefixed discovery prices correctly (the `minPriceFrom()` fix behind all 32 Batch 3 imports having correct, non-quantity prices)
- `fe09249` — fix: add Select All checkbox to admin Listings table
- `6c23372` — feat: add admin bulkUnhide action for batch-unhiding listings
- `b900912` — feat: add data-driven query-param SEO/sitemap for real search intent

## Parked / uncommitted — do not touch without explicit instruction

- **The "No Answer" call-attempt counter feature is parked, unfinished, in a local git stash** (`parked: No Answer counter (unfinished, for later)`) — it is not in tracked history and not in production. Do not revive it without being explicitly asked.
- **`.claude/settings.json` carries a pre-existing, intentional local modification** unrelated to any project work above — do not commit it or otherwise resolve it without being explicitly asked.
