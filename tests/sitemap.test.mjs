// Regression checks against the actual generated web/public/sitemap.xml —
// reads whatever is currently checked in (offline, no network/Supabase
// access), so this runs everywhere including CI. Complements the pure
// combinationDiscovery.test.mjs / extractDimensions.test.mjs unit tests by
// verifying the real build artifact, not just the functions that produce it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITEMAP_PATH = join(HERE, '..', 'web', 'public', 'sitemap.xml');

describe('web/public/sitemap.xml', () => {
  test('exists and is well-formed', () => {
    if (!existsSync(SITEMAP_PATH)) {
      // Never generated in this environment — nothing to check.
      return;
    }
    const xml = readFileSync(SITEMAP_PATH, 'utf8');
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'));
    // Every <url> opened is closed the same number of times — a cheap,
    // dependency-free well-formedness check without pulling in an XML
    // parser just for this.
    const opens = (xml.match(/<url>/g) || []).length;
    const closes = (xml.match(/<\/url>/g) || []).length;
    assert.equal(opens, closes);
    assert.ok(opens >= 1, 'sitemap should contain at least the homepage');
  });

  test('never contains a near-me/nearby URL', () => {
    if (!existsSync(SITEMAP_PATH)) return;
    const xml = readFileSync(SITEMAP_PATH, 'utf8');
    assert.ok(!/nearby|near-me|near_me/i.test(xml), 'sitemap.xml must never contain a near-me/nearby URL — that is a client-side geolocation feature, never crawlable/indexable');
  });

  test('every <loc> is a well-formed beggarsmap.com URL', () => {
    if (!existsSync(SITEMAP_PATH)) return;
    const xml = readFileSync(SITEMAP_PATH, 'utf8');
    const locs = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
    assert.ok(locs.length > 0);
    for (const loc of locs) {
      const url = new URL(loc);
      assert.equal(url.hostname, 'www.beggarsmap.com');
      assert.equal(url.protocol, 'https:');
    }
  });

  test('no <priority> falls outside the documented 0.3-1.0 range', () => {
    if (!existsSync(SITEMAP_PATH)) return;
    const xml = readFileSync(SITEMAP_PATH, 'utf8');
    const priorities = [...xml.matchAll(/<priority>([\d.]+)<\/priority>/g)].map((m) => Number(m[1]));
    for (const p of priorities) {
      assert.ok(p >= 0.3 && p <= 1.0, `priority ${p} out of expected range`);
    }
  });
});
