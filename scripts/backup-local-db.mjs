// Backs up the LOCAL Supabase Docker stack's data (never the hosted
// project — there is no --linked/--project-ref code path in this file at
// all). Writes a timestamped, data-only SQL dump to supabase/backups/ and
// verifies the file actually contains something real before declaring
// success. Never silently continues past a failed dump.
//
// Usage: npm run db:backup
// Programmatic: import { backupLocalDb } from './backup-local-db.mjs'

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
const BACKUPS_DIR = join(REPO_ROOT, 'supabase', 'backups');

function assertRepoRoot() {
  if (!existsSync(join(REPO_ROOT, 'supabase', 'config.toml'))) {
    throw new Error(
      `Run this from the repo root (expected supabase/config.toml under ${REPO_ROOT}). ` +
        `Use "npm run db:backup", don't call the script from another directory.`
    );
  }
}

function timestampedFilename() {
  // Sorts correctly by filename, and matches what restore-local-db.mjs's
  // "pick the newest" default expects.
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  return `local-${iso}.sql`;
}

export function backupLocalDb() {
  assertRepoRoot();
  mkdirSync(BACKUPS_DIR, { recursive: true });

  const path = join(BACKUPS_DIR, timestampedFilename());

  console.log(`[db:backup] Dumping local Supabase data (--local, --data-only) to ${path} ...`);
  const result = spawnSync('npx', ['supabase', 'db', 'dump', '--local', '--data-only', '-f', path], {
    stdio: 'inherit',
    shell: true,
  });

  if (result.status !== 0) {
    throw new Error(`[db:backup] supabase db dump failed (exit code ${result.status}). Refusing to continue.`);
  }

  // Verify: file exists, is non-trivially sized, and actually contains
  // listings data — a "successful" dump command with empty/garbage output
  // would otherwise look fine and silently give false confidence.
  if (!existsSync(path)) {
    throw new Error(`[db:backup] Dump command exited 0 but no file was written at ${path}.`);
  }
  const size = statSync(path).size;
  if (size < 50) {
    throw new Error(`[db:backup] Dump file at ${path} is suspiciously small (${size} bytes). Treating as a failure.`);
  }
  const content = readFileSync(path, 'utf8');
  const listingsInserts = (content.match(/INSERT INTO "public"\."listings"/g) ?? []).length;
  if (listingsInserts === 0) {
    throw new Error(
      `[db:backup] Dump file at ${path} contains no "public"."listings" INSERT statements. ` +
        `Either the local DB has no listings or the dump is broken — treating as a failure.`
    );
  }

  // Cross-check against the live DB's own count as a second, independent
  // signal (catches e.g. a dump silently taken against the wrong target).
  // The SQL argument must be individually quoted — spawnSync's shell:true
  // on Windows joins array args with plain spaces and does NOT escape
  // them, so an unquoted multi-word arg silently gets split into several
  // positional CLI args (verified: this really happens, not theoretical).
  const countResult = spawnSync('npx', ['supabase', 'db', 'query', '--local', JSON.stringify('select count(*) from listings;')], {
    encoding: 'utf8',
    shell: true,
  });
  let liveCount = null;
  if (countResult.status === 0) {
    const match = countResult.stdout.match(/"count"\s*:\s*"?(\d+)/);
    if (match) liveCount = Number(match[1]);
  } else {
    console.warn(`[db:backup] WARNING: could not cross-check the live listings count (exit ${countResult.status}): ${countResult.stderr || countResult.stdout}`);
  }

  console.log(`[db:backup] OK — ${path} (${size} bytes)`);
  console.log(`[db:backup] Listings INSERT statement(s) in dump file: ${listingsInserts}`);
  if (liveCount !== null) {
    console.log(`[db:backup] Listings rows in live local DB (authoritative count): ${liveCount}`);
  }

  return { path, size, listingsInserts, liveCount };
}

const isMain = import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`;
if (isMain) {
  try {
    backupLocalDb();
  } catch (err) {
    console.error(err.message ?? err);
    process.exit(1);
  }
}
