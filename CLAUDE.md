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

# Community Reviews + Listing Corrections (Phase 2 + Phase 3) — LIVE IN PRODUCTION (deployed 2026-09-09)

Built (`a161751`), then deployed to production end to end the same day: migrations `0022`-`0024` applied via `db query --linked` (each wrapped in a single atomic `DO` block — the same safety pattern `0009` established, so a new table is never briefly exposed without RLS already enabled; never a bare `db push`, see AGENTS.md's migration-ledger caveats), and the `admin-corrections` Edge Function deployed and ACTIVE. **Confirmed genuinely live**: a real anonymous site visitor submitted a real review ("Must visit" on Shivaji Military Hotel) shortly after deployment, with no prompting — the first organic, unprompted evidence this feature works end-to-end in production, not just in testing. As of this writing, production holds 1 real review and 0 corrections (0 pending/approved/rejected).

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

## Map-popup Edit Location limitation — REMOVED (2026-09-09, commit `726bd8c`), LIVE IN PRODUCTION

"Edit location" used to only appear when `ReviewOverlay` was opened from the list row's own Review link, not from the map popup's — the popup's `ListingDetailModal.tsx` unmounted while a location was being picked (`hidePopup` in `MapView.tsx`), which would have silently discarded an in-progress correction form. **Fixed, not by touching that popup-unmount logic at all**: `ListingDetailModal.tsx` no longer owns its own `ReviewOverlay` instance. Its "Review" button now calls a new `onOpenReview` prop (threaded through `MapView.tsx`) that App.tsx wires directly to `setReviewListingId` — the exact same state that already drives the list row's own `ReviewOverlay`. Both entry points now render the *same* single `ReviewOverlay` instance, owned by `App.tsx`, which never unmounts during a location pick (it already used the existing `hidden`-fade-not-unmount treatment `pickingLocation` already gave it). The popup itself still hides/unmounts during a pick exactly as before — that's fine now, since the overlay showing the review no longer lives inside it. Name and dishes corrections were already identical from both entry points and are unaffected. **Verified live**, not just locally: a fresh, uncached browser session against `www.beggarsmap.com` itself confirmed map-pin → Review → Edit location → pick → Save works end to end, with staged name/dishes/rating/text/photo all surviving the location pick.

## Verification done — local and production

Full `npm test` (350 passing, excluding the pre-existing, unrelated Discovery Workbench local-state-collision issue documented under "Discovery Workbench — current workflow and safeguards" below), `tsc --noEmit` and `npm run build` clean, plus repeated real-browser Playwright passes covering: per-field edit/save/cancel, the ₹30-₹100 dish validation still enforced on Save, the real map-picking round-trip from both entry points, only-changed-fields-create-corrections (verified directly against the DB), the canonical `listings` row staying untouched after submit, two independent anonymous sessions never overwriting each other's review, Add Listing's own create flow being unaffected, and no CSS overflow on desktop or 390px mobile. Beyond local testing, this was also smoke-tested directly against **production** (real anon-key writes to a disposable test review/correction, cleaned up afterward; one `admin_audit_log` row from that pass is permanently retained — that table is append-only/immutable by design, see `0013`) and confirmed via a live, fresh-browser walkthrough of the deployed site.

## Deployed to production — what's left is Admin v2 UI, not Phase 2+3 itself

Migrations `0022`-`0024` are applied, `admin-corrections` is deployed and ACTIVE. What remained after that — making these capabilities actually usable/manageable from the admin panel — became its own phase; see "Phase 5: Admin Corrections & Moderation" below. No real interactive walkthrough of the admin Corrections/Reviews UI by an actual logged-in human has happened yet (needs a real Google OAuth session, same limitation as every other Admin v2 feature before it) — everything so far has been verified via a locally-minted admin JWT (local Supabase stack only) plus direct read-only SQL replication against production.

# Phase 5: Admin Corrections & Moderation — LIVE IN PRODUCTION (commit `baa26d6`, deployed 2026-09-10)

Makes every Phase 2+3 backend capability reachable from the admin panel, closing gaps a full audit turned up: several backend capabilities existed with no UI, `deleteReview` was fully built server-side with zero call sites, and the Audit Log had an active bug mislabeling every `listing_correction`/`listing_review` row as `"report · {id}"` (migration `0024` widened the vocabulary; `AuditLog.tsx`'s Target-column renderer never learned about it).

- **Audit Log fix**: correct labeling for `listing_correction`/`listing_review` rows; added the missing action/target-type filter options (also closed a pre-existing, unrelated gap — `mark_reviewed`/`mark_unreviewed` were missing too, since migration `0014`).
- **Corrections Queue**: status filter (pending/approved/rejected/all — the backend's `status` param already supported this, the UI just never called it) and `correction_type` filter; shows the submitter's display name (joined server-side); shows `reviewed_at`/`reviewed_by`/`rejection_reason` for decided corrections.
- **Review moderation (new)**: a global "Reviews" admin tab plus a per-listing Reviews section in `ListingDetail`, both backed by a new `listReviews` action on `admin-corrections`. `deleteReview` now requires a reason, recorded in the audit row's existing `request_metadata` jsonb (no schema change).
- **`ListingDetail`**: a listing's own correction-approval and review-deletion history now appears in "History for this listing" — previously invisible there, since those audit rows are filed under the correction/review's own id, not the listing's (`admin-listings`' `get` action now runs two extra targeted queries to find them).
- **Dashboard**: pending-corrections and total-reviews tiles.
- **Deliberately excluded, confirmed with the user**: location-provenance fields stay read-only (adjacent Stage 2A work, not part of this phase); no bulk approve/reject.
- No migration — every gap closed was a stale frontend type/UI or new query logic against tables that already existed.

**Deployed functions**: `admin-corrections` v1→v2, `admin-listings` v7→v8, `admin-dashboard` v5→v6, all ACTIVE. Verified via the same locally-minted-JWT + production SQL-replication method as Phase 2+3's own deployment (real Google OAuth still isn't available in this environment) — auth-boundary (401/no-header) confirmed against the real deployed functions; every new/modified query's exact logic replicated against real production data with matching results. Before/after production counts (listings, hidden, reviews, corrections, Discovery Workbench batch 5) confirmed byte-identical across the whole deployment.

# Analytics: Plausible → GA4 + Cloudflare Web Analytics — LIVE IN PRODUCTION (commit `7603b55`, GA4 configured 2026-09-10)

Plausible was removed entirely (it had never been wired to a real account — see the old `index.html` comment it replaced) and replaced with Google Analytics 4 and Cloudflare Web Analytics, each loaded independently at runtime by `initAnalytics()` in `web/src/lib/analytics.ts` (called once from `main.tsx`), never as a static `<script>` tag in `index.html` — a static tag can't conditionally omit itself when its env var is unset, and the explicit requirement here was **never load a script with a blank/invented id**.

- `initAnalytics()` reads `VITE_GA4_MEASUREMENT_ID` and `VITE_CLOUDFLARE_BEACON_TOKEN` independently; each only injects its own official snippet (via `document.createElement`) when its own var is present and non-empty. Neither reads the other.
- `trackEvent()` keeps its exact pre-existing signature — every `App.tsx` call site (`'listing viewed'`, `'listing submitted'`, `'Add Listing opened'` ×3) needed zero changes. Internally it now calls `window.gtag?.('event', ...)` instead of `window.plausible?.(...)`.
- `web/vercel.json`'s CSP (Report-Only) gained `googletagmanager.com`/`static.cloudflareinsights.com` (script-src) and `google-analytics.com`/`cloudflareinsights.com` (connect-src).
- **GA4 is live and verified in production**: `VITE_GA4_MEASUREMENT_ID=G-79HX172B78` was added to Vercel's Production env vars (this environment had no Vercel session to do it directly — confirmed via `vercel whoami` reporting logged out with no `VERCEL_TOKEN`; the user added it and triggered the deploy manually) and confirmed live via a real, fresh-browser load of `www.beggarsmap.com`: exactly one `googletagmanager.com/gtag/js` script, `gtag('config', 'G-79HX172B78')` present in `dataLayer`, and zero Plausible references anywhere.
- **Cloudflare Web Analytics is NOT configured** — `VITE_CLOUDFLARE_BEACON_TOKEN` has never been set anywhere (not even a placeholder value beyond `.env.example`), so `initAnalytics()` correctly skips it entirely. Add the real token to Vercel's env vars whenever that account exists; no code change needed.
- `resolve-maps-link` (an unrelated Edge Function) was **not** touched by this work — mentioned only because it was redeployed later the same week for the unrelated location-accuracy work below; don't conflate the two.

# Location Accuracy: Map Search + POI-Tap + Paste-Link (2026-09-10 → 2026-09-11)

A multi-part pass triggered by a real user report: searching Beggars Map for **"Vigneshwara Tiffens"** (a real Nallurahalli/Whitefield restaurant) resolved to a **Hyderabad** location ~500-570 km away, and pasting the restaurant's own Google Maps share link produced a **Banashankari**-area coordinate instead. This is the concrete, shipped-and-in-progress work behind Stage 1 (OLA place-selection fix) and Stage 2A (location provenance) in the Roadmap above — not a parallel initiative.

## Root causes found, in order of discovery

1. **`extractGoogleCoordsFromUrl`'s regex priority was wrong.** A resolved Google Maps place URL can carry *both* `@lat,lng` (the map's viewport center — can be a wide, zoomed-out regional point) and `!3d lat!4d lng` (the place's own precise geocoded coordinate) in the same string. Checking `@` first silently returned the viewport as if it were the listing's location. Fixed by reordering to `!3d!4d` → `?q=` → `@` (both `web/src/lib/extractGoogleCoords.ts` and the mobile mirror `src/lib/extractGoogleCoords.ts`).
2. **OLA's own autocomplete has a genuine coverage gap, not a ranking bug** — biasing a query at the restaurant's *own* coordinates still returned zero Whitefield results (4 of 5 predictions were in Hyderabad). This is why the map-pin/search-suggestion fix below is a *sanity guard*, not a fix for OLA's index itself.
3. **The suggestion dropdown had its own, separate instance of the bug** — the pin-resolution fix alone didn't touch what the live-typing dropdown displayed, so cross-city results kept appearing there even after the pin itself was fixed.
4. **Directions links (`/maps/dir/...`) can silently produce a wrong coordinate** — their `@lat,lng` is the *route's* viewport, not either endpoint; one captured example carried the real destination coordinate via a completely different, undocumented `!1d!2d` convention that no parser here reads.
5. **The pre-existing `share.google` → OLA-text-search fallback in `resolve-maps-link` was itself a guess** — predating this pass's "never guess a restaurant's location" rule. Removed outright; a `share.google` link that resolves to a plain Search page now fails safely instead.
6. **Google's Maps JavaScript API base-map POI icons are a curated subset of the full Places index, not a mirror of it** — confirmed via Google's own developer docs/discussions ("no algorithm or rhyme or reason for which icons are shown"). A restaurant fully visible on consumer Google Maps can legitimately never render as a tappable icon on our embedded map, at any zoom. This means **POI-tap-to-select (below) cannot be a complete solution by itself** — confirmed live: this exact restaurant never rendered as an icon on our map.
7. **Some real Google Maps share links resolve to a URL with no coordinate anywhere in it** — only an opaque CID/place ID (`!1s<hex>:<hex>`, no `@`/`?q=`/`!3d!4d`). Resolving a bare CID to coordinates has no free path — only the Google Places API (Place Details) can do it, and adding that API was explicitly ruled out this pass.

## What shipped — commit `bb4e2bb`

`fix: keep map search within current city context` — the `!3d!4d`→`?q=`→`@` reorder (item 1), plus a new **geographic sanity guard** in `web/src/lib/placeRanking.ts`: `filterByBiasDistance()`/`MAX_BIAS_DISTANCE_KM = 50` excludes any OLA candidate more than 50 km from the search bias point *before* name-ranking runs. Deliberately a coarse sanity check, not a proximity-ranking system — the existing `NAME_TIE_BAND`/type-rank tie-break logic (needed for the unrelated "Juicy Spot" case, where the *correct* candidate is the farthest of four identically-named ones within ~8 km) is completely untouched, since 50 km never overlaps that case. Bengaluru is currently the only enabled city, so this protects that one context; **a future second city needs real city-selection state/config, not a wider radius here** — checked and confirmed no such state exists in `App.tsx` today (the city `<select>` is cosmetic: hardcoded value, no-op `onChange`, every option but Bengaluru disabled).

## What shipped — commit `ee6eb2c`

`feat: keep map search within current city + fix paste-link safety + POI tap-to-select` — three things bundled into one commit/deploy pass:

**Step 0 (the remaining safety fixes)**:
- The city-context guard from `bb4e2bb` was also applied to the live-typing **suggestion dropdown** (item 3 above) — `App.tsx`'s `resolveAreaMatches` now filters `placeResults` through `filterByBiasDistance` too, not just the pin-resolution candidate.
- **Directions-link guard** (item 4): `extractGoogleCoordsFromUrl` now refuses outright (`return null`) the moment a URL contains `/maps/dir/`, before any pattern match — both platform copies.
- **`share.google`-OLA-guess removed** (item 5): `supabase/functions/resolve-maps-link/index.ts`'s entire OLA-text-search branch and its `bestPlaceMatch`/`predictionsToPoints` import are gone; the function now unconditionally returns `{ finalUrl }` for every resolved redirect, letting a coordinate-less Search-page URL fail safely on the client instead.
- **Redeployed live**: `resolve-maps-link` → version 9, confirmed via a real smoke test against the actual `maps.app.goo.gl` short link (normal redirect resolution intact).

**Step 1 (POI-tap-to-select — new capability)**: while picking a location for a new listing, Google's own base-map POI icons become tappable.
- `MapView.tsx`: new `poiSelectable` prop, live-toggles `map.setOptions({ clickableIcons })` in its own effect (never touches the map-init effect's own deps, so the map is never torn down when picking mode toggles). The `'click'` handler is widened to `MapMouseEvent | IconMouseEvent`; when `placeId` exists *and* `poiSelectableRef.current` is true, calls `e.stop()` (suppresses Google's native info card/recenter — the exact behavior `clickableIcons: false` was originally added to avoid) and passes the placeId through. Two independent gates (the live `clickableIcons` toggle, and this ref check) both have to agree, so a POI tap is impossible outside picking mode — verified via a synthetic `IconMouseEvent` fired at the real, live-registered click handler.
- `App.tsx` → `AddListingModal.tsx`: the placeId threads through `searchPin` → `pickedLocation` → `locationPlaceId`, setting `location_source = 'google'` (instead of the generic `'user_pin'`) and including `provider_place_ids: { google: <id> }` in the insert payload when present.
- **Confirmed free**: reading `IconMouseEvent.placeId` is not a billed API call — it's a property already present on data the map tile load already paid for; only a *separate* Place Details call would bill, and none is made here (confirmed against Google's own docs).
- **`web/src/lib/listings.ts`**: `CreateListingInput` gained an optional `provider_place_ids` field.

**Vercel deploy status**: this environment has never had Vercel credentials (`vercel whoami` confirmed logged out, no token) — pushing `bb4e2bb`/`ee6eb2c` to `origin/main` does not by itself mean the live site is running this code. The user was told exactly this each time; **whether either commit has actually been deployed to `www.beggarsmap.com` is unconfirmed as of this writing** — verify the live bundle before assuming either fix (or POI-tap) is actually live, the same standing caution AGENTS.md already documents for this repo's history of stalled deploys.

## The POI-tap limitation, confirmed live (no code change — investigation only)

After `ee6eb2c` shipped, the same restaurant was confirmed live on **consumer** Google Maps but still did not render as a tappable icon on Beggars Map's own embedded map — proving item 6 above in production, not just in theory. Also confirmed: this is **not** the sandbox's known `localhost` API-key-referrer-restriction issue (production's key is authorized — zero `RefererNotAllowedMapError` on a live fetch of `www.beggarsmap.com`); it's the inherent base-map POI curation limitation. A full options comparison (accuracy/API/billing/complexity) concluded the only *complete* remaining paths without a paid Places API are manual: "Pick on map" (already built) and copying an exact coordinate from Google Maps' own "What's here?"/long-press feature (not yet supported by the paste box at the time).

## Location provenance: client INSERT can now keep honest values — migration `0025`, **NOT YET COMMITTED, NOT applied to production**

`supabase/migrations/0025_location_provenance_insert_persistence.sql` amends `lock_listing_location_fields()` (0015) so a client INSERT can keep a genuinely-known, non-escalating provenance claim instead of 0015's original "always collapse to `unknown`":
- `location_source`: passes through only if `user_pin`/`device_gps`/`ola`/`google`/`unknown` — `admin`/`import` (or anything else) still forced to `unknown`.
- `location_confidence`: a submitted `human_confirmed` is still forced to `unknown`; nothing else changes.
- `location_verified_at`/`location_verified_by`: still unconditionally `null` on every client INSERT — completely unchanged.
- `provider_place_ids`: passes through only when it validates as a genuine object-of-strings (new `is_valid_provider_place_ids()` SQL function, mirroring the existing JS validator's exact rule); anything else forced to `{}`.
- UPDATE-time protection is byte-identical to 0015's — untouched.

This is what finally lets a POI-tap's captured `provider_place_ids.google` actually reach storage; until this applies anywhere beyond local, POI-tap's identity capture is verified only up to the database boundary. **Verified live against the local stack only** (real anonymous session, real INSERT/UPDATE attempts, service-role readback — anon/authenticated only hold a column-level SELECT grant per `0017` that excludes every provenance column, so verification always reads back via service_role). Found and fixed one genuinely stale expectation in `tests/rls.test.mjs`'s own C-1 forged-fields test while verifying this (it assumed *any* client-submitted `provider_place_ids` must revert — updated to use an actually-invalid shape for that assertion, plus a new positive-case test proving a valid one now legitimately persists).

## Paste-link: simplified to coordinates-only — COMMITTED

Two passes here, and the second one supersedes most of the first:

**First pass** (still present in the working tree, now largely superseded by the second): `web/src/lib/extractGoogleCoords.ts` (+ mobile mirror) gained `extractLatLngFromText()` (a bare `lat, lng` paste, whole-string-anchored so it can never misfire against a real URL, range-validated, tagged `user_pin`) and `extractPlaceNameFromUrl()` (pulls a name/address out of a coordinate-less place URL's path — verified against the real captured CID-only Nallurahalli URL). `web/src/lib/googleMapsLink.ts` was rewritten to try the bare-coordinate check first, then short-link resolution (now also matching `g.co`, not just `goo.gl`/`share.google`), returning a discriminated `{ok:true,...} | {ok:false, reason, name?, address?}` result. `resolve-maps-link`'s server-side allowlist also gained `g.co` — **this specific change has not been redeployed**, so the live v9 function does not yet recognize `g.co` links.

**Second pass, after seeing the actual UI** (screenshot showed real confusion from the URL-resolution path's complexity): `AddListingModal.tsx`'s paste box was simplified to **coordinates-only** — "Paste link" became **"Paste coordinates from Google Maps"**, and `usePastedCoordinates()` (renamed from `useMapsLink`) now calls `extractLatLngFromText` directly and synchronously, with no network call, no short-link resolution, no Places API, no OLA, no guessing of any kind. The now-pointless async "…" busy state (`parsingLink`) was removed. **As a direct consequence, `googleMapsLink.ts`'s rewritten `parseGoogleMapsUrl` (URL resolution, `g.co`, name/address extraction, the three-reason error split) is no longer called by web's UI at all** — `web/src/lib/googleMapsLink.ts` itself was deliberately left **uncommitted** (see "Parked" below): nothing imports it any more, so its own content, committed or not, has no effect on the running app. `extractPlaceNameFromUrl` (in `extractGoogleCoords.ts`, which **is** committed alongside `extractLatLngFromText`) is likewise orphaned/unused, kept only because deleting it wasn't asked for. Verified live: pasting `12.9723, 77.7345` produces an exact pin instantly, reverse-geocoded to "Nallurahalli Road, Whitefield."

## Add Listing location UX polish (2026-09-11) — COMMITTED

Two follow-up passes on the same `AddListingModal.tsx` location section, both reacting to real UI feedback after the coordinates-only simplification above shipped:

- **Location-tabs redesign, fixing a real (not just cosmetic) state bug.** "Use current location" used to render with a permanent solid-pink `active` fill from the moment the modal opened — `locationMode` defaults to `'current'`, and critically is *also* reset to `'current'` by the `pickedLocation` effect once "Pick on map" resolves, so the button stayed lit even after the user picked a location the other way. Since the separate "Pinned ✓" banner already shows whichever location actually got confirmed, this `active` styling was redundant at best and misleading at worst. Fixed: "Use current location" and "Pick on map" no longer carry any `active` state; "Paste coordinates from Google Maps" keeps one, but softened from a solid fill to a light pink tint (`var(--pink-accent-soft)`), since for that one button it legitimately means "this section is expanded," not "this is the confirmed source." All three buttons were also switched from wrapping pills (which left the long "Paste coordinates…" label stranded alone on its own line) to a consistent full-width stacked layout, matching every other button in this modal (`10px` radius, not a pill).
- **Coordinate-help ⓘ popover.** A small circular ⓘ button beside "Paste coordinates from Google Maps" opens a compact popover explaining how to actually get a coordinate off Google Maps — desktop (right-click the exact spot, click the coordinates in the menu to copy) and mobile (long-press the exact spot; the coordinates can appear at the *top or bottom* of the screen depending on device — copy them, then come back and paste them here, since they never fill in automatically), plus a worked example (`12.9723, 77.7345`). Implementation notes worth keeping:
  - Reuses `ListingDetailModal.tsx`'s existing report-popover interaction pattern exactly (a wrap `ref` + a `mousedown`-outside-click effect) rather than inventing a new one.
  - The ⓘ button is positioned *absolutely* on top of the "Paste coordinates" button's own right edge (with `padding-right` on the button reserving the visual space), not laid out beside it in a flex row — an earlier version shared row width between the button and the icon, which made that one button narrower than its two siblings. All three are now pixel-identical widths.
  - The popover measures real available space via `getBoundingClientRect()` against `window.innerHeight` at the moment it opens and flips to open **upward** (`.location-info-popover-top`) instead of downward whenever there isn't roughly 190px of room below — this modal's body scrolls and the trigger sits well down the form, so a fixed "always opens below" popover was observed running past the visible viewport and covering the Post listing button entirely.

## A real, unrelated CSS bug fixed in the same pass — COMMITTED

The Add Listing modal's header (`Add a listing` + ✕) visually overlapped with scrolled dish rows once enough "+ Add more" rows were added. Root cause: `.modal-header` had `position: sticky; top: 0` but no `z-index` — sticky alone doesn't guarantee paint order, so `.modal-body`'s later-in-DOM content painted *over* the header the instant scrolled content overlapped it. Fixed with one line, `z-index: 1` on `.modal-header` (`web/src/styles.css`). Verified with real screenshots across the full scroll range (0/25/50/75/100%) after adding 6 extra dish rows — clean at every position.

# Mobile Web: Search Camera Zoom, Keyboard, and Enter-Key Hint (2026-09-11)

**Important scoping correction, worth remembering:** a report of "map freezes / keyboard stays open / searching a locality zooms out to India-level / Vigneshwara Tiffens still resolves to the wrong city / nearby listings don't show" was initially — and incorrectly — diagnosed and partially "fixed" against the **React Native mobile app** (`src/`). The actual report was about **mobile web** (`beggarsmap.com` opened in a phone's browser), a completely different codebase. The RN-app diagnostic and its fixes were caught before being committed and were **deliberately left uncommitted** — see "Parked" below; none of it shipped, and the RN app itself is untouched by this section. Everything below is the corrected, actual mobile-web fix.

## Root cause: `MapView.tsx`'s search-camera `fitBounds` padding wasn't breakpoint-aware

`MapView.tsx`'s `searchFocus` effect (the camera move triggered by an executed search — Whitefield, a named restaurant, Vigneshwara Tiffens, all of it) called `map.fitBounds(bounds, { top: 100, right: 380, bottom: 60, left: 60 })` unconditionally, on every breakpoint. That padding was correctly sized for desktop's floating list panel (~340-460px wide, docked on the right) — but mobile portrait has no such panel at all (it's a bottom sheet, per AGENTS.md's own "Web mobile portrait only" section), and `right: 380` alone reserves more width than a real phone viewport even has (~360-430px). With `left: 60` added, `fitBounds` was left with zero or negative usable width to fit anything into. **Confirmed live**, not just in theory: the exact `right:380` bytes were found in production's own deployed bundle (`main-*.js`, fetched and grepped directly from `www.beggarsmap.com`) before this fix — Google Maps degrades to an extremely low (country-level) zoom when asked to satisfy an impossible padding constraint, which is exactly what "zooms out to India" looked like. The pre-existing over-zoom guard (`if (zoom > 15) setZoom(15)`) only ever protected against zooming in too far — nothing protected the opposite direction, so this failure mode was completely unguarded.

The area-search logic itself (`resolveAreaMatches`, `AREA_MATCH_RADIUS_KM`, the nearby-Beggars-Map-listings lookup) and the 50km geographic sanity guard (`filterByBiasDistance`, from `bb4e2bb` above) were both already correct and confirmed live in production (same bundle-inspection method — the guard's `haversineKm` constant `6371` appears twice in the live bundle, once for it and once for the pre-existing `distanceKm`, matching a clean local build byte-for-byte). Neither needed a fix. The *visible symptom* — a correctly-resolved point still rendering as a country-level zoom-out — was purely this one padding bug, since even a single resolved point goes through `fitBounds` rather than a plain `panTo` (see the effect's own comment for why: "a single point becomes a zero-area bounds").

**Fix** (`web/src/components/MapView.tsx`): the effect now checks `window.matchMedia('(max-width: 720px) and (orientation: portrait)')` — the same breakpoint constant `App.tsx` already uses everywhere else, duplicated locally rather than threading a new prop through — and switches to `{ top: 90, right: 40, bottom: 140, left: 40 }` on mobile portrait. Desktop/tablet/landscape padding is byte-for-byte unchanged.

## Keyboard fixes

- **Dismiss on search** (`web/src/App.tsx`): the search `<input>`'s Enter handler now calls `e.currentTarget.blur()` right after `executeSearch(query)` fires. Previously nothing ever blurred this input, so the on-screen keyboard stayed open after submitting a search, covering roughly half the screen.
- **`enterKeyHint="search"`** (`web/src/App.tsx`): the on-screen keyboard's Enter key now shows "Search" instead of a generic return glyph — the direct web equivalent of a native app's `returnKeyType`.
- **iOS Safari auto-zoom fix** (`web/src/styles.css`): `.search-input-inline`'s font-size was `14px` (shared phone rule) and `12px` (landscape-phone rule) — both under the 16px threshold at which iOS Safari auto-zooms the whole page when a text input receives focus, which read as "the page zooms when I tap search." Both floored to `16px`; padding on both left unchanged, so the layout only grows by exactly what the larger text requires.

## Verification

`cd web && npx tsc --noEmit` and `npm run build` both clean after every change in this section. `npm test` (full repo suite): consistently ~403 passing regardless of run (one run counted 447 tests/44 fail, another 419/16 fail — the difference is `adminAuth.test.mjs`/`discoveryWorkbench.test.mjs` self-skipping when the local Docker stack isn't reachable at that moment, not a regression; the remaining failures are always exactly `workbenchSync.test.mjs`'s own pre-existing, known, local-state-dependent set) — zero regressions from any change in this section, confirmed by name and count before and after. Verified the live production bundle directly (fetched, not assumed) both before this fix (to confirm the bug was genuinely deployed, not a stale-build artifact) and after (see below): committed as `8c9b35e`/`eec7f76`/`0164dc6`, pushed, and **confirmed LIVE in production** within roughly a minute of pushing — the deployed `main-*.js`/`main-*.css` were fetched directly from `www.beggarsmap.com` and grepped for `right:40`/`bottom:140` (mobile padding), `right:380` (desktop padding, unchanged), `enterKeyHint`, `.blur()`, `location-info-popover`/`location-tab-with-info`, the `12.9723, 77.7345` example string, `.search-input-inline{...font-size:16px` (both phone rules), and `.modal-header{...z-index:1` — every one present. Homepage and `/admin.html` both still return `200`.

No device/emulator was available in this environment for a real on-screen tap-through; all of the above is code-level, bundle-inspection, and build/test verified, not hand-tested on a physical phone.

## Current, honest state of this whole pass (as of this writing)

- **Committed and pushed**: `7603b55` (analytics), `bb4e2bb` (city-context guard), `ee6eb2c` (dropdown fix + Directions guard + OLA-removal + POI-tap). GA4 confirmed live in production; whether `bb4e2bb`/`ee6eb2c`'s *code* has reached the live site is unconfirmed (no Vercel access from this environment either time) — see the mobile-web section above, which independently reconfirmed both are in fact live via direct bundle inspection.
- **Deployed**: `resolve-maps-link` Edge Function is live at version 9 (includes the Directions-guard-adjacent OLA removal; does **not** include the later `g.co` addition, since that was written after this deploy and was never committed — see "Parked" below).
- **Not committed, sitting in the working tree**: migration `0025` + its `tests/rls.test.mjs`/`tests/locationProvenance.test.mjs` coverage; `web/src/lib/googleMapsLink.ts`'s rewritten-but-orphaned `parseGoogleMapsUrl`; the `resolve-maps-link` `g.co` allowlist addition. See "Parked" below for the full, current list — this bullet is deliberately not repeated there in full.
- **Full verification for every committed piece**: `npm test`, `tsc --noEmit`, and `npm run build` all clean at each step — see each section's own "Verification" note above for exact counts.

# Add Listing: Photo Copy/Paste + Contextual Location Help (2026-09-11)

A follow-up UX pass on `AddListingModal.tsx` (and, for one piece, the full-screen map's own picking-location dialog in `App.tsx`), driven by direct user feedback across several rounds after the initial coordinate-help ⓘ popover shipped in the "Add Listing location UX polish" section above.

## Paste-coordinates button — real centering, not just visual

The ⓘ trigger beside "Paste coordinates from Google Maps" used to reserve its own `padding-right` and force `text-align: left` on that one button, so its label text didn't actually center the same way its two siblings ("Use current location"/"Pick on map") did — all three needed to be pixel-identical. Fixed by removing that override entirely: the button now inherits `.location-tabs .tab-button`'s styling completely unstyled, and the ⓘ button is a pure `position: absolute` overlay with zero reserved layout space, so its presence can never shift where the label text centers.

The ⓘ button itself was also too subtle to read as an information affordance — a faint white circle with a light gray border and gray glyph, indistinguishable from the white button it sat on except on hover. Switched to a solid `var(--pink-accent)` fill with white text and a small drop shadow (matching this app's `.primary-button` accent language), so it reads as "tap me for information" at a glance instead of only on hover.

## Photo copy/paste — a real Discovery-Workbench-style paste box, not an invisible one

Went through two iterations here, worth recording since the first one looked right on paper but didn't actually work as asked:

1. **First attempt**: a document-level native `paste` event listener, active for the modal's whole lifetime, so Ctrl+V anywhere in the form would add a photo with zero new UI. This technically worked for the keyboard shortcut, but delivered **no right-click → Paste option and no mobile long-press → Paste option** — browsers only offer those two in their native context/selection menus over an element they recognize as an actual text-editing surface (a real input/textarea, or `contentEditable`), and a plain focusable `<div>` (even with `tabIndex`) doesn't qualify, no matter how it's styled.
2. **Fixed version**: the paste target is now a small `contentEditable` box (`.photo-paste-box`, 56×56px to match the existing `.photo-thumb` size) placed directly beside any already-added photo thumbnails in `.photo-thumbs`, with "+ Add photos" moved to its own line below that row. Because it's genuinely `contentEditable`, right-click → Paste (desktop) and the long-press selection menu → Paste (mobile) both now appear over it, exactly mirroring the Discovery Workbench's own `discovery-photo-paste-box` pattern (`CandidateDetail.tsx`) — the explicit reference point for this feature. `handlePhotoPaste` calls `preventDefault()` so the browser's own contentEditable behavior (inserting the image as a real `<img>` node, or raw text) never actually lands inside the box — its real DOM content must always stay empty; the "Paste" hint text is a pure CSS `:empty::before`, and a small `onKeyDown` guard blocks ordinary typing (Ctrl+V/Cmd+V still passes through) so a stray click-and-type can't leave real text sitting in it.

Both the file-picker's `onChange` and the paste handler now funnel through one shared `addPhotoFiles()` — same `MAX_PHOTOS` limit, same preview generation, same everything else, regardless of how the File arrived. No new client-side type/size validation was added (matching the pre-existing file-picker path, which also has none — the storage bucket's own `0018` restrictions remain the actual enforcement layer).

## "Can't find the restaurant?" — moved to where it can actually help

This was first added as a static link inside `AddListingModal.tsx`'s own location section. That placement didn't survive contact with the real flow: the modal is `hidden` (not unmounted, but invisible) for the entire duration of "Pick on map," so a note living inside it could never be seen by someone actually stuck searching on the full-screen map — exactly the moment (the Vigneshwara Tiffens case) this is meant to help with.

**Moved to `App.tsx`'s existing `picking-dialog`** — the one-time acknowledgment card that already appears the instant "Pick on map" is clicked ("Tap the map, tap a restaurant shown on it, or search a location/landmark..."). A second paragraph was added underneath it, visually separated by a top divider (`.picking-dialog-fallback`, same convention as the coordinate-help popover's own `.location-info-example` divider):

> Can't find the restaurant? Search for a nearby landmark or area, then directly pinpoint the restaurant on the map and click "Add this place". You can also copy the coordinates from Google Maps and paste them in the Add Listing form's "Paste coordinates from Google Maps" option.

Deliberately reworded from an earlier draft that said "...and paste them here" — that phrasing only made sense when this lived inside the modal itself; now that it's shown on a different screen (the modal is hidden throughout), it explicitly points back to the Add Listing form and names the exact button by its real label. Scoped to the `pickingSource !== 'current-location'` branch only (the GPS-confirmation dialog isn't about searching for a place, so the fallback doesn't apply there). Deliberately **not** tied to any search-results state (no "zero results" detection) — it's static guidance shown once per pick session, so it can never interfere with or depend on the actual search/map pipeline.

## Verification

`cd web && npx tsc --noEmit` and `npm run build` clean after every change in this pass. Full `npm test`: 403 passing consistently across every run; failure count fluctuated between runs (44 / 28 / 16 depending on which of `adminAuth.test.mjs`/`discoveryWorkbench.test.mjs` happened to self-skip due to local Docker stack reachability at that moment) but the *pass* count never moved and every failure was confirmed by name to be the same pre-existing `adminAuth`/`discoveryWorkbench`/`workbenchSync` local-state-dependent set — zero regressions from anything in this pass. No physical device/emulator was available to hand-test the actual right-click/long-press context menus; the `contentEditable` mechanism itself is standard, well-documented browser behavior, not something invented for this app, but the real on-device menus were not visually confirmed.

# Current Project State (as of 2026-09-10)

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
- **`supabase storage rm <path> --recursive` on a bucket-root path deletes the bucket itself, not just its contents.** Confirmed the hard way while closing out Batch 5: `supabase storage rm ss:///discovery-photos --recursive` removed `discovery-photos` from `storage.buckets` entirely (`storage ls ss:///` afterward showed only `listing-photos`), not just the objects inside it — a real gap in the Batch 3/4 precedent this project had been treating as safe. Recovered immediately by re-running migration `0021`'s own bucket-creation `INSERT` verbatim (`id/name='discovery-photos', public=false, allowed_mime_types=['image/jpeg','image/png','image/webp'], file_size_limit=2097152`, `ON CONFLICT DO NOTHING`) — no data was actually lost since all photos in that bucket had already been confirmed backed up locally first. **Going forward: never pass `--recursive` on a bare bucket-root path when the intent is only to empty it — list the exact object paths first and delete those, or delete-then-immediately-verify-and-recreate-the-bucket like this incident did, but don't assume `--recursive` on a bucket root is content-only.**
- **Local and production `discovery_batch_rows` schemas can drift** — local's Docker stack currently has an extra `no_answer_count integer` column production doesn't have (a remnant of the parked "No Answer" call-attempt-counter feature's abandoned migration, per "Parked / uncommitted" below). Any manual production-transfer INSERT must use an explicit column list matching production's actual schema (verified via `information_schema.columns` on both sides first), never a blind `select *`.

## Discovery Workbench: current-batch progress counters (2026-09-11) — LIVE IN PRODUCTION

Small, additive UI change to the intern-facing Workbench page (`discovery.html`) — a request from the workbench-batch work above to make the intern's own progress against the current batch visible without needing the CLI's `--status` output. The header now shows all three at once, e.g. `62 / 100 reviewed · 14 / 100 no answer · 23 / 100 yes menu under ₹100`, in place of the previous `X / Y reviewed in this batch`-only line.

**Deliberately zero new state.** Before touching anything, checked what already existed: `web/src/discovery/lib/discoveryApi.ts`'s `isReviewed()` already mirrors `tools/discovery/workbench-sync.mjs`'s own `isReviewedDbRow()` exactly (by that function's own comment), and the "Reviewed" count itself already existed in `DiscoveryApp.tsx`'s header. `Candidate.number_valid` (`'Yes' | 'No' | 'No Answer' | null`) and `Candidate.menu_list_under_100` (`'Yes' | 'No' | null`) were already fully typed, populated fields. So "No Answer" and "Yes Menu Under ₹100" are just two more `.filter()` counts over the exact same `candidates` array, computed the identical way as the pre-existing `reviewedCount` — no new component, no new API call, no new column, nothing persisted beyond what already existed.

**Why this can't double-count or go stale on edit, by construction, not by extra logic**: all three counts are pure re-derivations over the live `candidates` array on every render, never separately-tracked incrementing/decrementing counters. `CandidateDetail.tsx`'s save flow already calls `onSaved(res.data)` with the full server-saved candidate — `res.data` from the Edge Function's own `update` action response, not a locally-guessed value — and `updateCandidateLocally` (in `DiscoveryApp.tsx`) replaces that one row in the `candidates` array in place. The next render just re-scans the whole (now-updated) array from scratch for all three counts, so editing a previously-saved row's `Number Valid`/`Menu List Under 100` naturally moves it in or out of each count with no special-casing needed anywhere.

**File changed**: `web/src/discovery/DiscoveryApp.tsx` only. Nothing else — `matching.mjs`/qualification logic, Excel/sync logic (`workbench-sync.mjs`), schema, `listings`, the RN app, the public web app, and the Admin panel are all untouched.

**Verification**: `cd web && npx tsc --noEmit` and `npm run build` clean (only the `discovery-*.js`/`discovery-*.css` bundle hashes changed; `main-*`/`admin-*`/`index-*` bundle hashes byte-identical, confirming the public site and Admin panel are untouched). `npm test`: 447 tests / 403 pass / 44 fail, the 44 being the same pre-existing `adminAuth`/`discoveryWorkbench`/`workbenchSync` local-Docker-state-dependent set by name — zero regressions. No dedicated unit test exists for this component (a plain React header string), so this is code-review-level verified, not test-covered.

## Latest relevant commits

- `0164dc6` — docs: record Phase 2+3/Admin v2 production status, mobile-web fixes, and Add Listing location UX in CLAUDE.md
- `eec7f76` — fix(web): mobile browser search camera zoom, keyboard dismissal, and enter-key hint (see "Mobile Web" above; **confirmed LIVE in production** via direct bundle fetch within ~1 minute of push)
- `8c9b35e` — feat(web): simplify Add Listing location entry to paste-coordinates + add coordinate-help popover (see "Add Listing location UX polish" above; **confirmed LIVE in production**, same verification pass as `eec7f76`)
- `ee6eb2c` — feat: keep map search within current city + fix paste-link safety + POI tap-to-select (see "Location Accuracy" above; `resolve-maps-link` redeployed live; web/Vercel deploy status **now confirmed live** — re-verified via direct bundle inspection during the mobile-web fix pass above, e.g. `clickableIcons`/`poiSelectable` and the `filterByBiasDistance` guard's `6371` constant both present in the deployed bundle)
- `bb4e2bb` — fix: keep map search within current city context (see "Location Accuracy" above; web/Vercel deploy status **now confirmed live**, same re-verification as `ee6eb2c` above)
- `7603b55` — feat: replace Plausible with GA4 + Cloudflare Web Analytics (see the dedicated section above; GA4 confirmed live in production 2026-09-10, Cloudflare not yet configured)
- `baa26d6` — feat: Phase 5 — admin corrections & moderation (see the dedicated section above; deployed to production 2026-09-10)
- `726bd8c` — fix: let map-pin Review reach Edit location without losing draft state (see "Map-popup Edit Location limitation — REMOVED" above; deployed to production)
- `9c18ca0` — docs: record Phase 2/3 review+corrections status in CLAUDE.md
- `a161751` — feat: add community reviews and listing corrections (Phase 2 + Phase 3 — see the dedicated section above; deployed to production 2026-09-09)
- `758f5fc` — docs: add current project state snapshot to CLAUDE.md
- `2cdab35` — fix: parse rupee-prefixed discovery prices correctly (the `minPriceFrom()` fix behind all 32 Batch 3 imports having correct, non-quantity prices)

## Parked / uncommitted — do not touch without explicit instruction

- **The "No Answer" call-attempt counter feature is parked, unfinished, in a local git stash** (`parked: No Answer counter (unfinished, for later)`) — it is not in tracked history and not in production. Do not revive it without being explicitly asked.
- **`.claude/settings.json` carries a pre-existing, intentional local modification** unrelated to any project work above — do not commit it or otherwise resolve it without being explicitly asked.
- **Migration `0025_location_provenance_insert_persistence.sql`, plus `tests/rls.test.mjs`/`tests/locationProvenance.test.mjs`'s matching coverage for it** — see "Location Accuracy" above. Written, applied to the **local** stack only, fully verified there. Not committed, not applied to production. Do not apply to production, and do not commit either test file's current diff (it exercises this migration specifically), without explicit instruction.
- **`web/src/lib/googleMapsLink.ts`'s URL-resolution rewrite (bare-coordinate-first, `g.co`, name/address extraction, three-reason discriminated result) and `resolve-maps-link`'s matching `g.co` allowlist addition** — see "Location Accuracy" above. Uncommitted. Nothing in web's UI imports `googleMapsLink.ts` any more (superseded by the coordinates-only simplification, which **is** committed) — don't assume it's wired to anything without checking `AddListingModal.tsx`'s actual imports first.
- **The React Native mobile app's own diagnostic/fix pass** (`src/screens/MapScreen.tsx`, `src/components/ListingsMap.tsx`, `src/lib/placeRanking.ts`, `src/lib/olaMaps.ts`, plus `tests/placeRanking.test.mjs`'s extension of the "geographic sanity guard" describe block to also cover `mobile`) — see the "Mobile Web" section above for why this exists at all: a bug report was initially misdiagnosed as the RN app when it was actually mobile *web*, and this is that misdirected work. It was caught before being committed and is being **deliberately left uncommitted** — do not commit, delete, or otherwise resolve any of these five files without explicit instruction. The RN app itself was never touched by the actual (mobile-web) fix.
- **`AddListingModal.tsx`'s coordinates-only paste box (`usePastedCoordinates`) and `web/src/styles.css`'s `.modal-header` `z-index: 1` fix** — see "Location Accuracy" above. Both implemented and verified (real browser screenshots + a live end-to-end coordinate-paste test), not committed.
