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
//
// listings/reviews/votes.created_by all reference profiles(id), not
// auth.users(id) directly — so every anonymous session also needs a matching
// profiles row, or any insert into those tables fails on the foreign key.
// The mobile app creates this row via auth.tsx's ensureProfile(); this is
// the web equivalent.
export function ensureAnonymousSession(): Promise<string | null> {
  if (!anonymousSessionPromise) {
    anonymousSessionPromise = (async () => {
      const { data } = await supabase.auth.getSession();
      let userId = data.session?.user.id ?? null;

      if (!userId) {
        const { data: signInData, error } = await supabase.auth.signInAnonymously();
        if (error) {
          console.error('Anonymous sign-in failed', error.message);
          return null;
        }
        userId = signInData.session?.user.id ?? null;
      }
      if (!userId) return null;

      const { data: profile } = await supabase.from('profiles').select('id').eq('id', userId).maybeSingle();
      if (!profile) {
        const { error: profileError } = await supabase
          .from('profiles')
          .insert({ id: userId, display_name: 'Anonymous contributor' });
        if (profileError) {
          console.error('Could not create profile for anonymous session', profileError.message);
          return null;
        }
      }

      return userId;
    })();
  }
  return anonymousSessionPromise;
}
