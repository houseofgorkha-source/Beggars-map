import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env and fill in your Supabase project values.'
  );
}

// A separate client/session (own localStorage key) from the main app's
// anonymous-session client (web/src/lib/supabase.ts). This page needs a
// real signed-in identity (Google OAuth) to pass the admin-reports Edge
// Function's email check, and must never inherit or interact with the
// public site's anonymous session — using the same client instance here
// risked either reading back an existing anonymous session as if it were
// a real login, or Supabase's anonymous-to-permanent account linking
// kicking in on sign-in. Still just the public anon key, never
// service-role.
export const adminSupabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { storageKey: 'sb-admin-auth-token' },
});
