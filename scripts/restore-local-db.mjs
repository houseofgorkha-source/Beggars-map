// Restores a data-only dump (from backup-local-db.mjs) into the LOCAL
// Supabase Docker stack. Never touches the hosted project — this script
// only ever talks to a Docker container it discovers on this machine.
//
// This always clears the 5 fresh seed listings (owned by the fixed seed
// user id from 0003_seed_demo_listings.sql) before replaying the dump —
// it's meant to run right after a reset (or onto a DB you're fine
// re-seeding), not as a generic point-in-time restore. Restoring onto a
// DB that already has real (non-fresh-reseed) data alongside the dump's
// own copies would just duplicate rows.
//
// Usage: npm run db:restore -- [path-to-dump.sql]   (defaults to the newest file in supabase/backups/)
// Programmatic: import { restoreLocalDb } from './restore-local-db.mjs'

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
const BACKUPS_DIR = join(REPO_ROOT, 'supabase', 'backups');
const SEED_USER_ID = '00000000-0000-0000-0000-000000000001'; // fixed id from 0003_seed_demo_listings.sql

function assertRepoRoot() {
  if (!existsSync(join(REPO_ROOT, 'supabase', 'config.toml'))) {
    throw new Error(`Run this from the repo root (expected supabase/config.toml under ${REPO_ROOT}).`);
  }
}

function readProjectId() {
  const configPath = join(REPO_ROOT, 'supabase', 'config.toml');
  const content = readFileSync(configPath, 'utf8');
  const match = content.match(/^project_id\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error(`Could not find project_id in ${configPath}.`);
  return match[1];
}

// Discovers the local DB container by the project id label the Supabase
// CLI itself attaches — never assumes a fixed container name.
function findDbContainer(projectId) {
  const result = spawnSync(
    'docker',
    ['ps', '--filter', `label=com.supabase.cli.project=${projectId}`, '--filter', 'name=supabase_db_', '--format', '{{.Names}}'],
    { encoding: 'utf8', shell: true }
  );
  if (result.status !== 0) {
    throw new Error(`[db:restore] "docker ps" failed: ${result.stderr || result.stdout}`);
  }
  const names = result.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) {
    throw new Error(
      `[db:restore] No running local DB container found for project "${projectId}". ` +
        `Is "supabase start" running? (checked: docker ps --filter label=com.supabase.cli.project=${projectId} --filter name=supabase_db_)`
    );
  }
  if (names.length > 1) {
    throw new Error(`[db:restore] Found multiple matching containers (${names.join(', ')}) — refusing to guess which one.`);
  }
  return names[0];
}

function resolveBackupPath(explicitPath) {
  if (explicitPath) {
    if (!existsSync(explicitPath)) throw new Error(`[db:restore] Backup file not found: ${explicitPath}`);
    return explicitPath;
  }
  if (!existsSync(BACKUPS_DIR)) {
    throw new Error(`[db:restore] No backup path given and ${BACKUPS_DIR} doesn't exist yet. Run "npm run db:backup" first.`);
  }
  const files = readdirSync(BACKUPS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => join(BACKUPS_DIR, f))
    .sort(); // timestamped filenames sort chronologically
  if (files.length === 0) {
    throw new Error(`[db:restore] No .sql backups found in ${BACKUPS_DIR}. Run "npm run db:backup" first.`);
  }
  return files[files.length - 1];
}

function verifyBackupFile(path) {
  const size = statSync(path).size;
  if (size < 50) throw new Error(`[db:restore] Backup file ${path} is suspiciously small (${size} bytes). Refusing to restore.`);
  const content = readFileSync(path, 'utf8');
  if (!content.includes('INSERT INTO "public"."listings"')) {
    throw new Error(`[db:restore] Backup file ${path} has no listings data. Refusing to restore.`);
  }
  return content;
}

export function restoreLocalDb(explicitPath) {
  assertRepoRoot();
  const projectId = readProjectId();
  const container = findDbContainer(projectId);
  const path = resolveBackupPath(explicitPath);
  const content = verifyBackupFile(path);

  console.log(`[db:restore] Restoring ${path} into container "${container}"...`);

  console.log('[db:restore] Clearing the current seed-owned listings before replay (avoids duplicating the 5 seed rows)...');
  // The -c value must be quoted as one token — see the comment in
  // backup-local-db.mjs about shell:true not escaping array args on Windows.
  const clearSql = `delete from listings where created_by = '${SEED_USER_ID}';`;
  const clearResult = spawnSync(
    'docker',
    ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-c', JSON.stringify(clearSql)],
    { encoding: 'utf8', shell: true }
  );
  if (clearResult.status !== 0) {
    throw new Error(`[db:restore] Failed to clear fresh seed listings: ${clearResult.stderr || clearResult.stdout}`);
  }

  const restoreResult = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres'], {
    input: content,
    encoding: 'utf8',
    shell: true,
  });

  // psql (without -v ON_ERROR_STOP=1) continues past row-level errors, so
  // exit code alone doesn't tell us whether anything went wrong — always
  // surface every ERROR line rather than trusting a clean exit code.
  const errorLines = (restoreResult.stdout + restoreResult.stderr).split('\n').filter((l) => l.includes('ERROR:'));
  const unexpectedErrors = errorLines.filter((l) => !(l.includes('duplicate key') && l.includes(SEED_USER_ID)) && !l.includes('already exists'));

  if (restoreResult.status !== 0 && errorLines.length === 0) {
    throw new Error(`[db:restore] psql exited ${restoreResult.status} with no ERROR lines captured — treating as a failure:\n${restoreResult.stderr}`);
  }

  if (errorLines.length > 0) {
    console.warn(`[db:restore] ${errorLines.length} statement error(s) during replay:`);
    for (const line of errorLines) console.warn('  ' + line.trim());
  }
  if (unexpectedErrors.length > 0) {
    throw new Error(
      `[db:restore] ${unexpectedErrors.length} UNEXPECTED error(s) during restore (see above) — ` +
        `expected only harmless duplicate-key/already-exists errors on the fixed seed user row. Refusing to declare success.`
    );
  }

  // Final sanity check: prove something actually landed rather than
  // trusting "no unexpected errors" alone.
  const countResult = spawnSync('npx', ['supabase', 'db', 'query', '--local', JSON.stringify('select count(*) from listings;')], {
    encoding: 'utf8',
    shell: true,
  });
  let liveCount = null;
  if (countResult.status === 0) {
    const match = countResult.stdout.match(/"count"\s*:\s*"?(\d+)/);
    if (match) liveCount = Number(match[1]);
  }
  if (liveCount === null) {
    throw new Error('[db:restore] Could not verify post-restore listings count — treating as a failure.');
  }
  console.log(`[db:restore] OK — listings table now has ${liveCount} row(s) after restore.`);

  return { path, container, liveCount, errorLines };
}

const isMain = import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`;
if (isMain) {
  try {
    restoreLocalDb(process.argv[2]);
  } catch (err) {
    console.error(err.message ?? err);
    process.exit(1);
  }
}
