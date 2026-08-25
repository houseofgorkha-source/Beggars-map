import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env and fill in your Supabase project values.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

let anonymousSessionPromise: Promise<string | null> | null = null;

// The web launch has no visible sign-in — every visitor gets a silent Supabase
// anonymous session so RLS's auth.uid() ownership checks still work. Requires
// "Anonymous sign-ins" enabled in Supabase Auth settings.
export function ensureAnonymousSession(): Promise<string | null> {
  if (!anonymousSessionPromise) {
    anonymousSessionPromise = (async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session) return data.session.user.id;

      const { data: signInData, error } = await supabase.auth.signInAnonymously();
      if (error) {
        console.error('Anonymous sign-in failed', error.message);
        return null;
      }
      return signInData.session?.user.id ?? null;
    })();
  }
  return anonymousSessionPromise;
}
