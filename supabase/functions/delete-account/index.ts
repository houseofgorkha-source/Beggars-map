// Deletes the calling user's own Supabase Auth account.
//
// This can't be done from the mobile/web client directly — deleting an
// auth.users row requires the Admin API, which requires the service-role
// key. That key must never reach client code, so this runs server-side as
// an Edge Function instead: it verifies the caller's own JWT first (so a
// user can only ever delete *themselves*), then uses a service-role client
// — created only inside this function, never shipped to any app bundle —
// to perform the actual deletion.
//
// profiles/listings/reviews/votes all reference auth.users(id) with
// `on delete cascade` (0001_init.sql), so deleting the auth user removes
// all of that content automatically. Reports the user filed against other
// listings are NOT owned by them in a way that cascades (reports.reported_by
// also cascades, so those go too).
//
// Deploy with:
//   npx supabase functions deploy delete-account --project-ref nvingzluboafxzxgxxwc
// Requires the project's default SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// secrets, which Supabase provisions automatically for Edge Functions.

import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Missing Authorization header' }), { status: 401 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // Client scoped to the caller's own JWT — used only to find out who they
  // are, never to perform the deletion itself.
  const callerClient = createClient(supabaseUrl, serviceRoleKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const {
    data: { user },
    error: userError,
  } = await callerClient.auth.getUser();

  if (userError || !user) {
    return new Response(JSON.stringify({ error: 'Could not verify caller identity' }), { status: 401 });
  }

  // Separate admin client for the actual privileged operation.
  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const { error: deleteError } = await adminClient.auth.admin.deleteUser(user.id);

  if (deleteError) {
    return new Response(JSON.stringify({ error: deleteError.message }), { status: 500 });
  }

  // The account itself is gone at this point — everything below is best-effort
  // cleanup of storage.objects, which Postgres cascades never touch. Listings
  // are already deleted (cascade from profiles), so there's no live row that
  // could point at a photo we remove here; a failure here doesn't unwind the
  // deletion above and isn't reported as one — it's a storage-cost concern,
  // not a correctness one, so account deletion still succeeds either way.
  // uploadPhoto() (mobile + web) always writes under `${userId}/...`, so this
  // prefix is exactly and only this user's own files.
  let storageCleanupError: string | null = null;
  try {
    const { data: files, error: listError } = await adminClient.storage
      .from('listing-photos')
      .list(user.id, { limit: 1000 });

    if (listError) {
      storageCleanupError = listError.message;
    } else if (files && files.length > 0) {
      const paths = files.map((f) => `${user.id}/${f.name}`);
      const { error: removeError } = await adminClient.storage.from('listing-photos').remove(paths);
      if (removeError) storageCleanupError = removeError.message;
    }
  } catch (e) {
    storageCleanupError = e instanceof Error ? e.message : 'Unknown storage cleanup error';
  }

  return new Response(
    JSON.stringify({ success: true, storageCleanupError }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
});
