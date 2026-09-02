// The ONLY sanctioned way to run a full local Supabase DB reset. Never
// touches the hosted project (no --linked/--project-ref anywhere here).
//
// Sequence: warn -> confirm -> backup -> `supabase db reset --local` ->
// (temporary 0007/0011 workaround, see below) -> restore -> summary.
// If the backup step fails, nothing destructive runs at all.
//
// Usage: npm run db:reset:safe            (interactive — must type RESET)
//        npm run db:reset:safe -- --yes   (skips the prompt, e.g. for scripted/agent use
//                                           after a human has already confirmed elsewhere)

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { backupLocalDb } from './backup-local-db.mjs';
import { restoreLocalDb } from './restore-local-db.mjs';

const REPO_ROOT = process.cwd();

function assertRepoRoot() {
  if (!existsSync(join(REPO_ROOT, 'supabase', 'config.toml'))) {
    throw new Error(`Run this from the repo root (expected supabase/config.toml under ${REPO_ROOT}).`);
  }
}

async function confirm() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type RESET to permanently wipe the LOCAL Supabase DB (backed up first): ');
  rl.close();
  return answer.trim() === 'RESET';
}

// TEMPORARY: migration 0011 recreates two policies that 0007 already
// creates, so a from-scratch replay of every migration fails on 0011.
// Production never ran 0007 so this never showed up there. Per the
// 2026-08-30 audit, 0007/0011 are being left untouched as a separate
// follow-up — this block works around the conflict at the DB level
// (applying 0011's non-conflicting statements directly, then marking it
// applied) without editing either migration file. Delete this whole
// function once 0011 is made replay-safe.
function applyKnown0011Workaround(container) {
  console.log('[db:reset:safe] Applying temporary 0007/0011 workaround (see comment in this file)...');
  const sql = `
alter table listings add constraint listings_latitude_range_check check (latitude between -90 and 90);
alter table listings add constraint listings_longitude_range_check check (longitude between -180 and 180);
alter table listings add constraint listings_name_length_check check (char_length(name) <= 120);
-- LOCAL-ONLY variant of 0011's photo_url bucket check. Production's own
-- constraint (already applied directly to the hosted project) hard-codes
-- that project's storage host, which is correct there and is NOT changed by
-- anything in this file — this script has no --linked/--project-ref path.
-- Replaying that exact definition into the local stack, though, makes every
-- locally-uploaded photo unstorable: a local photo_url is
-- http://127.0.0.1:54321/storage/... and can never match the hosted host,
-- so the insert fails on a constraint that exists purely to keep production
-- photos in production's own bucket. Same constraint name, same intent
-- (photo_url must point at THIS environment's listing-photos bucket),
-- widened only by the two local hosts the Supabase CLI serves storage on.
alter table listings add constraint listings_photo_url_bucket_check check (
  photo_url is null
  or photo_url like 'https://nvingzluboafxzxgxxwc.supabase.co/storage/v1/object/public/listing-photos/%'
  or photo_url like 'http://127.0.0.1:54321/storage/v1/object/public/listing-photos/%'
  or photo_url like 'http://localhost:54321/storage/v1/object/public/listing-photos/%'
);
create or replace function public.lock_listing_is_hidden()
returns trigger language plpgsql as $$
begin
  if new.is_hidden is distinct from old.is_hidden and auth.role() <> 'service_role' then
    new.is_hidden := old.is_hidden;
  end if;
  return new;
end;
$$;
create trigger listings_lock_is_hidden before update on public.listings for each row execute function public.lock_listing_is_hidden();
`.trim();

  const applyResult = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres'], {
    input: sql,
    encoding: 'utf8',
    shell: true,
  });
  if (applyResult.status !== 0 || /ERROR:/.test(applyResult.stdout + applyResult.stderr)) {
    throw new Error(`[db:reset:safe] 0011 workaround failed:\n${applyResult.stdout}\n${applyResult.stderr}`);
  }

  const repairResult = spawnSync('npx', ['supabase', 'migration', 'repair', '--local', '--status', 'applied', '0011'], {
    stdio: 'inherit',
    shell: true,
  });
  if (repairResult.status !== 0) {
    throw new Error('[db:reset:safe] "supabase migration repair" failed.');
  }
}

async function main() {
  assertRepoRoot();

  const autoYes = process.argv.includes('--yes') || process.argv.includes('-y');

  console.log('==================================================================');
  console.log('This will PERMANENTLY WIPE the LOCAL Supabase Docker database and');
  console.log('recreate it from supabase/migrations/*.sql. Everything not produced');
  console.log('by a migration (developer-created listings, test users, reports,');
  console.log('etc.) will be backed up first and restored afterward automatically.');
  console.log('This never touches the hosted/production Supabase project.');
  console.log('==================================================================');

  if (!autoYes) {
    const ok = await confirm();
    if (!ok) {
      console.log('[db:reset:safe] Aborted — confirmation not given.');
      process.exit(1);
    }
  } else {
    console.log('[db:reset:safe] --yes passed, skipping interactive confirmation.');
  }

  const backup = backupLocalDb(); // throws (and stops everything) if the backup isn't good

  console.log('[db:reset:safe] Backup verified. Running `supabase db reset --local`...');
  const resetResult = spawnSync('npx', ['supabase', 'db', 'reset', '--local'], { stdio: 'inherit', shell: true });
  if (resetResult.status !== 0) {
    throw new Error(`[db:reset:safe] "supabase db reset --local" failed (exit ${resetResult.status}). Your backup is safe at ${backup.path}.`);
  }

  // Re-discover the container after reset (name/id is stable, but this
  // keeps restore-local-db.mjs as the single source of truth for discovery).
  const containerResult = spawnSync('docker', ['ps', '--filter', 'name=supabase_db_', '--format', '{{.Names}}'], {
    encoding: 'utf8',
    shell: true,
  });
  const container = containerResult.stdout.split('\n').map((s) => s.trim()).filter(Boolean)[0];
  if (!container) throw new Error('[db:reset:safe] Could not find the local DB container after reset.');

  applyKnown0011Workaround(container);

  console.log('[db:reset:safe] Restoring backup...');
  const restore = restoreLocalDb(backup.path);

  console.log('[db:reset:safe] Verifying migration tracking...');
  spawnSync('npx', ['supabase', 'migration', 'list', '--local'], { stdio: 'inherit', shell: true });

  console.log('==================================================================');
  console.log(`[db:reset:safe] Done. Backup: ${backup.path}`);
  console.log(`[db:reset:safe] Listings after restore: ${restore.liveCount}`);
  console.log('==================================================================');
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
