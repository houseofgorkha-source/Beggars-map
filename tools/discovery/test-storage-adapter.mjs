// Smoke test for the PRODUCTION storage adapter, run against the LOCAL
// Supabase stack.
//
// Why this exists: the production dry run exercises reads only, so it
// happily passed while `storage cp` was broken — the first real production
// import then aborted on its first photo with
// "LegacyStorageUnsupportedOperationError: Unsupported operation". A dry run
// cannot catch an upload bug; only an upload can.
//
// So this imports the REAL adapter from import-excel.mjs (not a copy of it)
// and points it at the local stack, uploads one genuine photo whose filename
// contains a space and parentheses — "unnamed (1).webp", the exact file that
// failed in production — checks it is listed and publicly fetchable with
// byte-identical content, then deletes it again.
//
// Touches storage only: it creates no listing rows, and it has no --linked
// code path. Usage: node tools/discovery/test-storage-adapter.mjs

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { productionStorageAdapter, storageList, supabaseSpawn, resolveSupabaseCli } from './import-excel.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// A deliberately obvious, throwaway prefix — nothing real is ever stored
// under it, so cleanup can never remove a genuine photo.
const TEST_PREFIX = '__storage_adapter_test__';
const SOURCE = join(HERE, 'photos', 'ChIJPVjT4aEXrjsR30M6v554zs4', 'unnamed (1).webp');

function localApiUrl() {
  const result = supabaseSpawn(['status', '-o', 'json']);
  const parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  const url = parsed.API_URL;
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`Refusing to run: "${url}" is not the local stack.`);
  }
  return url.replace(/\/$/, '');
}

function md5(buffer) {
  return createHash('md5').update(buffer).digest('hex');
}

let failures = 0;
function check(label, passed, detail = '') {
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!passed) failures += 1;
}

const apiUrl = localApiUrl();
// The production adapter, with only its target swapped to the local stack.
const storage = productionStorageAdapter('--local', apiUrl);

const filename = 'unnamed (1).webp';
const storagePath = `${TEST_PREFIX}/ChIJPVjT4aEXrjsR30M6v554zs4/${filename}`;
const photo = { filename, absolutePath: SOURCE, bytes: statSync(SOURCE).size };

console.log(`Adapter under test : productionStorageAdapter (target swapped to --local)`);
console.log(`Local API          : ${apiUrl}`);
console.log(`Source file        : ${SOURCE}`);
console.log(`Destination        : ss:///listing-photos/${storagePath}`);
console.log('');

console.log('1. pre-check: object must not already exist');
check('objectExists() is false before upload', (await storage.objectExists(storagePath)) === false);

console.log('2. upload through the real adapter');
const result = await storage.uploadPhoto(photo, storagePath);
check('uploadPhoto() returned without throwing', true, `${result.bytes} bytes, ${result.contentType}`);

console.log('3. the object is visible to the adapter and to a plain HTTP fetch');
check('objectExists() is true after upload', (await storage.objectExists(storagePath)) === true);
const listed = storageList(`ss:///listing-photos/${TEST_PREFIX}/ChIJPVjT4aEXrjsR30M6v554zs4/`, '--local');
check('filename survives the round trip with its space/parens intact', listed.includes(filename), JSON.stringify(listed));

const url = storage.publicUrlFor(storagePath);
const response = await fetch(url);
const downloaded = Buffer.from(await response.arrayBuffer());
check('public URL fetches successfully', response.status === 200, `HTTP ${response.status}`);
check('downloaded bytes match the source file', md5(downloaded) === md5(readFileSync(SOURCE)), md5(downloaded));

console.log('4. cleanup');
// `storage rm` reports {"deleted":[]} for a single object on this CLI
// version (measured), so cleanup goes through the local Storage REST API
// with the LOCAL stack's own service key — which never leaves this machine
// and is not the production one.
const status = JSON.parse(supabaseSpawn(['status', '-o', 'json']).stdout.slice(supabaseSpawn(['status', '-o', 'json']).stdout.indexOf('{')));
const encoded = storagePath.split('/').map(encodeURIComponent).join('/');
const removed = await fetch(`${apiUrl}/storage/v1/object/listing-photos/${encoded}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${status.SERVICE_ROLE_KEY}` },
});
check('delete request succeeded', removed.status === 200, `HTTP ${removed.status}`);
check('objectExists() is false again', (await storage.objectExists(storagePath)) === false);
check('public URL no longer serves the object', (await fetch(url)).status !== 200);

console.log('');
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
