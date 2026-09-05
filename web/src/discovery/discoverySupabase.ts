import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env and fill in your Supabase project values.'
  );
}

// A separate client/session (own localStorage key) from both the public
// app's anonymous-session client and the admin panel's own session — same
// reasoning as adminSupabase.ts: this page needs a real signed-in identity
// (Google OAuth) checked against DISCOVERY_EMAILS, and must never inherit or
// interact with either of the other two sessions. Still just the public
// anon key, never service-role — every privileged operation happens
// server-side in the discovery-workbench Edge Function.
export const discoverySupabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { storageKey: 'sb-discovery-auth-token' },
});
