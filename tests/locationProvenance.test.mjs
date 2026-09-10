// Stage 2A (location provenance, 0015) tests.
//
// What these tests CAN verify without a running Postgres: every pure
// function this stage introduced (the admin auto-provenance-on-move logic,
// the provider_place_ids validator, the paste-link source tagging on both
// platforms) plus a static check that the committed migration SQL itself
// still says what these tests assume it says.
//
// What these tests CANNOT verify (needs a live database — see this stage's
// own implementation report for what WAS verified live, against the local
// Docker stack, earlier in the same pass): that applying 0015 leaves the 25
// production listings' coordinates byte-identical, that the lock trigger
// actually rejects a non-service-role write to the new columns (INSERT and
// UPDATE alike — 0015 now carries its own INSERT+UPDATE trigger for these
// five columns, `lock_listing_location_fields`, kept deliberately separate
// from 0016's `lock_listing_admin_fields` for the 11 pre-Stage-2A columns;
// see 0015's own comment on why they aren't merged), and that service_role
// can still write them. Re-run those checks (documented in the report) once
// the local stack is back up, before this is applied anywhere beyond local.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { computeLocationProvenanceOnMove, isValidProviderPlaceIds } from '../supabase/functions/_shared/locationProvenance.ts';
import { extractGoogleCoordsFromUrl as extractWeb } from '../web/src/lib/extractGoogleCoords.ts';
import { extractGoogleCoordsFromUrl as extractMobile } from '../src/lib/extractGoogleCoords.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(__dirname, '..', 'supabase', 'migrations', '0015_location_provenance.sql');
const RESOLVE_MAPS_LINK_PATH = join(__dirname, '..', 'supabase', 'functions', 'resolve-maps-link', 'index.ts');

// ---------------------------------------------------------------------------
// Static schema check: parse the actual committed migration file rather than
// re-typing its constraint lists by hand, so this test fails the moment the
// migration's real allowed values drift from what the rest of the app (the
// TypeScript types, admin-listings' VALID_* arrays) assumes they are.
// ---------------------------------------------------------------------------
describe('0015 migration (static check against the committed SQL)', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');

  function checkValues(columnName) {
    const re = new RegExp(`check \\(${columnName} in \\(([^)]+)\\)\\)`);
    const match = sql.match(re);
    assert.ok(match, `expected a CHECK constraint for ${columnName}`);
    return match[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  }

  test('location_source allows exactly the seven documented values', () => {
    assert.deepEqual(
      checkValues('location_source'),
      ['user_pin', 'device_gps', 'ola', 'google', 'admin', 'import', 'unknown']
    );
  });

  test('location_confidence allows exactly the five documented values', () => {
    assert.deepEqual(checkValues('location_confidence'), ['unknown', 'low', 'medium', 'high', 'human_confirmed']);
  });

  test('location_source and location_confidence both default to unknown', () => {
    assert.match(sql, /location_source text not null default 'unknown'/);
    assert.match(sql, /location_confidence text not null default 'unknown'/);
  });

  test('provider_place_ids defaults to an empty jsonb object, not null', () => {
    assert.match(sql, /provider_place_ids jsonb not null default '\{\}'::jsonb/);
  });

  test('location_verified_at/by have no default — must stay null until an explicit verification', () => {
    assert.doesNotMatch(sql, /location_verified_at timestamptz.*default/);
    assert.doesNotMatch(sql, /location_verified_by text.*default/);
  });

  test('the lock trigger function is widened for all five new columns', () => {
    for (const col of ['location_source', 'location_confidence', 'location_verified_at', 'location_verified_by', 'provider_place_ids']) {
      assert.match(sql, new RegExp(`new\\.${col} is distinct from old\\.${col}`), `expected the trigger to guard ${col}`);
    }
  });

  test('the targeted backfill statement matches by id, not by any coordinate-based inference', () => {
    // Scoped to the actual UPDATE statement, not the whole file — the file's
    // own prose legitimately discusses (and explicitly rejects) inferring
    // from decimal precision; this checks the executable SQL doesn't do it.
    const backfillSection = sql.slice(sql.indexOf('update listings set'));
    assert.doesNotMatch(backfillSection, /round\(|length\(|substring\(|::text\s*~/);
    assert.match(backfillSection, /where listings\.id = known_imports\.id/);
  });

  test('the backfill sets medium confidence, never human_confirmed, for pipeline imports', () => {
    const backfillSection = sql.slice(sql.indexOf('update listings set'));
    assert.match(backfillSection, /location_confidence = 'medium'/);
    assert.doesNotMatch(backfillSection, /location_confidence = 'human_confirmed'/);
  });

  // -------------------------------------------------------------------
  // P1-2: INSERT-time protection for the five location columns, added
  // 2026-09-03 as a separate function/trigger from 0016's
  // lock_listing_admin_fields (see this migration's own comment for why
  // they can't be the same function — 0016 is a later-numbered,
  // already-committed migration that would otherwise clobber whatever
  // this file's own function replacement does to the same name).
  // -------------------------------------------------------------------

  test('a separate lock_listing_location_fields function exists, not merged into lock_listing_admin_fields', () => {
    assert.match(sql, /create or replace function public\.lock_listing_location_fields\(\)/);
  });

  test("the location-fields function's INSERT branch sets all five columns to their true defaults", () => {
    const fnSection = sql.slice(sql.indexOf('create or replace function public.lock_listing_location_fields'));
    const insertBranch = fnSection.slice(fnSection.indexOf("TG_OP = 'INSERT'"), fnSection.indexOf('else'));
    assert.match(insertBranch, /new\.location_source := 'unknown';/);
    assert.match(insertBranch, /new\.location_confidence := 'unknown';/);
    assert.match(insertBranch, /new\.location_verified_at := null;/);
    assert.match(insertBranch, /new\.location_verified_by := null;/);
    assert.match(insertBranch, /new\.provider_place_ids := '\{\}'::jsonb;/);
  });

  test("the location-fields function's UPDATE branch still guards all five columns (revert-to-old, not a default)", () => {
    const fnSection = sql.slice(sql.indexOf('create or replace function public.lock_listing_location_fields'));
    const updateBranch = fnSection.slice(fnSection.indexOf('else'), fnSection.indexOf('$$;'));
    for (const col of ['location_source', 'location_confidence', 'location_verified_at', 'location_verified_by', 'provider_place_ids']) {
      assert.match(updateBranch, new RegExp(`new\\.${col} is distinct from old\\.${col}`), `expected the UPDATE branch to guard ${col}`);
    }
  });

  test('the location-fields function is guarded by the same service_role exemption as every other lock', () => {
    const fnSection = sql.slice(
      sql.indexOf('create or replace function public.lock_listing_location_fields'),
      sql.indexOf('$$;', sql.indexOf('create or replace function public.lock_listing_location_fields'))
    );
    assert.match(fnSection, /auth\.role\(\) <> 'service_role'/);
  });

  test('a BEFORE INSERT OR UPDATE trigger wires the function up on listings', () => {
    assert.match(
      sql,
      /create trigger listings_lock_location_fields\s+before insert or update on public\.listings/
    );
  });

  test('exactly 7 known production place_ids are backfilled, matching the real state file', () => {
    const backfillSection = sql.slice(sql.indexOf('update listings set'));
    const ids = [...backfillSection.matchAll(/'([A-Za-z0-9_-]{20,})'\)/g)].map((m) => m[1]);
    assert.equal(ids.length, 7);
    // Matches tools/discovery/output/excel-import-state.json's
    // environments.production.entries exactly — not re-derived from that
    // file at test time (it's gitignored, so a fresh clone wouldn't have
    // it), just pinned here as the known-good expected set.
    assert.deepEqual(
      new Set(ids),
      new Set([
        'ChIJPVjT4aEXrjsR30M6v554zs4',
        'ChIJYzMFjmptrjsRnowgWZK-Nc8',
        'ChIJl7SNXBYTrjsRTnFEBO3TqGY',
        'ChIJIZ2NLvYXrjsRv1EmIJNh1c8',
        'ChIJTe_TEts_rjsRvIo8Nm9fL28',
        'ChIJbwqh4okWrjsRpoxhx52qq54',
        'ChIJwU6gtW49rjsRWLODyUkDOPc',
      ])
    );
  });
});

// ---------------------------------------------------------------------------
// computeLocationProvenanceOnMove — the admin auto-provenance-on-move logic.
// ---------------------------------------------------------------------------
describe('computeLocationProvenanceOnMove', () => {
  const NOW = '2026-09-03T12:00:00.000Z';

  test('editing name/price/note only — never touches location provenance', () => {
    const result = computeLocationProvenanceOnMove({ name: 'New Name', price_rupees: 50 }, 'admin@example.com', NOW);
    assert.deepEqual(result, {});
  });

  test('moving latitude alone auto-sets all four provenance fields', () => {
    const result = computeLocationProvenanceOnMove({ latitude: 12.9 }, 'admin@example.com', NOW);
    assert.deepEqual(result, {
      location_source: 'admin',
      location_confidence: 'human_confirmed',
      location_verified_at: NOW,
      location_verified_by: 'admin@example.com',
    });
  });

  test('moving longitude alone also triggers it (not just latitude)', () => {
    const result = computeLocationProvenanceOnMove({ longitude: 77.6 }, 'admin@example.com', NOW);
    assert.equal(result.location_source, 'admin');
  });

  test('an explicit location_source in the same payload is never overridden', () => {
    const result = computeLocationProvenanceOnMove(
      { latitude: 12.9, location_source: 'ola' },
      'admin@example.com',
      NOW
    );
    assert.equal(result.location_source, undefined, 'must not overwrite the caller-supplied value');
    assert.equal(result.location_confidence, 'human_confirmed', 'the other three still get defaulted');
  });

  test('all four fields explicit — nothing left for this function to add', () => {
    const result = computeLocationProvenanceOnMove(
      {
        latitude: 12.9,
        location_source: 'google',
        location_confidence: 'high',
        location_verified_at: '2020-01-01T00:00:00.000Z',
        location_verified_by: 'someone@example.com',
      },
      'admin@example.com',
      NOW
    );
    assert.deepEqual(result, {});
  });

  test('defaults to real time when no `now` is passed', () => {
    const before = Date.now();
    const result = computeLocationProvenanceOnMove({ latitude: 1 }, 'a@b.com');
    const after = Date.now();
    const t = new Date(result.location_verified_at).getTime();
    assert.ok(t >= before && t <= after);
  });
});

// ---------------------------------------------------------------------------
// isValidProviderPlaceIds
// ---------------------------------------------------------------------------
describe('isValidProviderPlaceIds', () => {
  test('an empty object is valid — "missing provider IDs" is the normal case', () => {
    assert.equal(isValidProviderPlaceIds({}), true);
  });

  test('a normal single-provider object is valid', () => {
    assert.equal(isValidProviderPlaceIds({ google: 'ChIJ123' }), true);
  });

  test('multiple providers on one listing is valid', () => {
    assert.equal(isValidProviderPlaceIds({ google: 'ChIJ123', ola: 'ola-abc' }), true);
  });

  test('rejects an array', () => {
    assert.equal(isValidProviderPlaceIds(['ChIJ123']), false);
  });

  test('rejects null', () => {
    assert.equal(isValidProviderPlaceIds(null), false);
  });

  test('rejects a non-string value (a caller trying to nest an object/number)', () => {
    assert.equal(isValidProviderPlaceIds({ google: 12345 }), false);
    assert.equal(isValidProviderPlaceIds({ google: { id: 'ChIJ123' } }), false);
  });

  test('rejects a bare string or number', () => {
    assert.equal(isValidProviderPlaceIds('ChIJ123'), false);
    assert.equal(isValidProviderPlaceIds(42), false);
  });
});

// ---------------------------------------------------------------------------
// extractGoogleCoordsFromUrl — paste-link source tagging, both platforms.
// ---------------------------------------------------------------------------
for (const [label, extractGoogleCoordsFromUrl] of [
  ['web', extractWeb],
  ['mobile', extractMobile],
]) {
  describe(`extractGoogleCoordsFromUrl (${label})`, () => {
    test('the @lat,lng pattern is tagged source: google', () => {
      const result = extractGoogleCoordsFromUrl('https://www.google.com/maps/place/CTR/@12.9716,77.5946,17z');
      assert.deepEqual(result, { latitude: 12.9716, longitude: 77.5946, source: 'google' });
    });

    test('the ?q=lat,lng pattern is tagged source: google', () => {
      const result = extractGoogleCoordsFromUrl('https://maps.google.com/maps?q=12.9716,77.5946');
      assert.deepEqual(result, { latitude: 12.9716, longitude: 77.5946, source: 'google' });
    });

    test('the !3d!4d pattern is tagged source: google', () => {
      const result = extractGoogleCoordsFromUrl('https://www.google.com/maps/place/x/data=!3d12.9716!4d77.5946');
      assert.deepEqual(result, { latitude: 12.9716, longitude: 77.5946, source: 'google' });
    });

    test('a URL with no embedded coordinate returns null, never a guess', () => {
      assert.equal(extractGoogleCoordsFromUrl('https://www.google.com/maps/place/CTR'), null);
    });

    // -----------------------------------------------------------------
    // Priority order — the "Vigneshwara Tiffens" production bug.
    //
    // A named-place URL can carry more than one coordinate pattern at once,
    // and they are not equally trustworthy: `@lat,lng,zoom` is only ever the
    // map's viewport center on load, while `!3d!4d` (and `?q=`) are tied to
    // the specific place/coordinate actually being shared. Checking `@`
    // first used to silently return the viewport point as the listing's
    // location whenever both were present — confirmed live against
    // maps.app.goo.gl/ek3KnmaGp6iHB5U79's real resolved URL below, where the
    // viewport (@12.9344627,77.547142, a Banashankari-area point ~20km
    // away) and the actual restaurant's precise coordinate (Whitefield)
    // both appear in the same string.
    // -----------------------------------------------------------------
    describe('coordinate-pattern priority', () => {
      test('!3d!4d wins over @ when a URL carries both (the Vigneshwara Tiffens bug)', () => {
        const url =
          'https://www.google.com/maps/place/Vigneshwara+Tiffens/@12.9344627,77.547142,12z/data=!4m7!3m6!1s0x3bae13000e915e79:0x726a2ab1893d5866!8m2!3d12.972322!4d77.7344565!15sChNWaWduZXNod2FyYSBUaWZmaW5z?entry=tts';
        const result = extractGoogleCoordsFromUrl(url);
        assert.deepEqual(result, { latitude: 12.972322, longitude: 77.7344565, source: 'google' });
      });

      test('?q= wins over @ when a URL carries both', () => {
        const url = 'https://www.google.com/maps/place/Somewhere/@12.9344627,77.547142,12z/data=?q=12.972322,77.7344565';
        const result = extractGoogleCoordsFromUrl(url);
        assert.deepEqual(result, { latitude: 12.972322, longitude: 77.7344565, source: 'google' });
      });

      test('an @-only URL (a raw dropped-pin share, no place-data blob) still resolves via @', () => {
        // Regression guard for the reorder itself: a URL with nothing more
        // specific than the viewport must still fall through to it, not
        // return null.
        const result = extractGoogleCoordsFromUrl('https://www.google.com/maps/@12.9716,77.5946,15z');
        assert.deepEqual(result, { latitude: 12.9716, longitude: 77.5946, source: 'google' });
      });

      test('the CID-only Nallurhalli share link still returns null, never a guess', () => {
        // The real resolved target of https://maps.app.goo.gl/hYaCqgvbvXLuN75j9?g_st=ac
        // (captured live) — carries only a Google Place ID (CID), no @, no
        // ?q=, no !3d!4d anywhere. There is genuinely nothing to extract
        // without a Places Details lookup, which this fix deliberately does
        // not add — null is the correct, honest outcome, not a bug.
        const url =
          'https://www.google.com/maps/place/Vigneshwara+Tiffens,+Nallurahalli+Main+Rd,+opp.+Carrymart+supermarket,+Nallurhalli,+Whitefield,+Bengaluru,+Karnataka+560066/data=!4m2!3m1!1s0x3bae13000e915e79:0x726a2ab1893d5866!18m1!1e1?utm_source=mstt_1&entry=gps';
        assert.equal(extractGoogleCoordsFromUrl(url), null);
      });
    });

    // -----------------------------------------------------------------
    // Directions links — a "/maps/dir/" URL's @lat,lng is only the route's
    // viewport, never the destination. Found during the paste-location
    // safety audit: silently returning that viewport risked saving a
    // restaurant at the wrong end of a route with no error shown.
    // -----------------------------------------------------------------
    describe('Directions URLs are refused, not guessed', () => {
      test('a directions URL with only a viewport @ coordinate returns null', () => {
        const url = 'https://www.google.com/maps/dir/Current+Location/Vigneshwara+Tiffens/@12.95,77.65,12z/data=!4m2!4m1!3e0';
        assert.equal(extractGoogleCoordsFromUrl(url), null);
      });

      test('a directions URL whose destination coordinate is embedded as !1d!2d (not !3d!4d) still returns null', () => {
        // This variant actually carries the real destination coordinate
        // (77.7344565, 12.972322, via Google's !1d<lng>!2d<lat> directions
        // encoding) alongside the misleading viewport @ — proof that this
        // guard refuses the whole URL rather than only avoiding @, since
        // parsing !1d!2d correctly for every directions variant isn't
        // reliable enough to trust as a coordinate source.
        const url =
          'https://www.google.com/maps/dir//Vigneshwara+Tiffens/@12.95,77.65,12z/data=!4m8!4m7!1m0!1m0!1m5!1m1!1s0x3bae13000e915e79!2m2!1d77.7344565!2d12.972322!3e0';
        assert.equal(extractGoogleCoordsFromUrl(url), null);
      });

      test('a directions URL is refused even if it also happens to carry a !3d!4d pair', () => {
        // Belt-and-suspenders: the /maps/dir/ check runs before any pattern
        // match, so it can never be a near-miss depending on what else the
        // URL contains.
        const url =
          'https://www.google.com/maps/dir/Origin/Vigneshwara+Tiffens/@12.95,77.65,12z/data=!4m2!3m1!1s0x3bae13000e915e79!3d12.972322!4d77.7344565';
        assert.equal(extractGoogleCoordsFromUrl(url), null);
      });

      test('a non-directions URL with the same coordinates is unaffected by the guard', () => {
        const url = 'https://www.google.com/maps/place/Vigneshwara+Tiffens/data=!3d12.972322!4d77.7344565';
        assert.deepEqual(extractGoogleCoordsFromUrl(url), { latitude: 12.972322, longitude: 77.7344565, source: 'google' });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// resolve-maps-link — static check that the OLA location-guess fallback is
// gone, and that normal redirect resolution is untouched.
//
// This Edge Function runs on Deno (Deno.serve, Deno.env.get) and can't be
// imported under plain Node — same reasoning as the 0015 migration check
// above, this reads the actual committed source file as text and asserts
// on its content, so it stays real evidence even without a Deno runtime.
// ---------------------------------------------------------------------------
describe('resolve-maps-link (static source check)', () => {
  const source = readFileSync(RESOLVE_MAPS_LINK_PATH, 'utf8');

  test('no longer imports the shared place-ranking module', () => {
    // That import existed solely to power the removed guess — its absence
    // is direct evidence the guessing code path, not just the OLA fetch
    // call inside it, is gone.
    assert.equal(source.includes('placeRanking'), false);
  });

  test('does not fetch api.olamaps.io', () => {
    assert.equal(source.includes('olamaps.io'), false);
  });

  test('normal redirect resolution is untouched: still follows the redirect and returns finalUrl', () => {
    assert.ok(source.includes('fetch(parsed.toString())'), 'expected the redirect-following fetch to still be present');
    assert.ok(source.includes('finalUrl: resolvedUrl.toString()'), 'expected the function to still return finalUrl');
  });

  test('the goo.gl / share.google allowlist is untouched', () => {
    assert.ok(source.includes("parsed.hostname === 'goo.gl'"));
    assert.ok(source.includes("parsed.hostname === 'share.google'"));
  });

  test('never returns a latitude/longitude pair (the removed guess shape)', () => {
    assert.equal(/latitude\s*:\s*match/.test(source), false);
    assert.equal(/longitude\s*:\s*match/.test(source), false);
  });
});

// ---------------------------------------------------------------------------
// Web and mobile stay behaviourally identical — run the same representative
// set of URLs through both and assert equal results, rather than relying
// only on the shared for-loop above running the same test bodies twice.
// ---------------------------------------------------------------------------
describe('extractGoogleCoordsFromUrl — web/mobile parity', () => {
  const urls = [
    'https://www.google.com/maps/place/Vigneshwara+Tiffens/@12.9344627,77.547142,12z/data=!4m7!3m6!1s0x3bae13000e915e79:0x726a2ab1893d5866!8m2!3d12.972322!4d77.7344565',
    'https://www.google.com/maps/@12.9716,77.5946,15z',
    'https://maps.google.com/maps?q=12.9716,77.5946',
    'https://www.google.com/maps/dir/Current+Location/Vigneshwara+Tiffens/@12.95,77.65,12z/data=!4m2!4m1!3e0',
    'https://www.google.com/maps/place/Vigneshwara+Tiffens,+Nallurahalli+Main+Rd/data=!4m2!3m1!1s0x3bae13000e915e79:0x726a2ab1893d5866!18m1!1e1',
    'not a url at all',
  ];

  for (const url of urls) {
    test(`web and mobile agree for: ${url.slice(0, 60)}`, () => {
      assert.deepEqual(extractWeb(url), extractMobile(url));
    });
  }
});
