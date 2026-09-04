import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY. Copy .env.example to .env and fill in your Supabase project values.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    flowType: 'pkce',
  },
});

// The exact columns anon/authenticated hold a Postgres column-level SELECT
// grant on for `listings` (see supabase/migrations/0017_public_data_boundary.sql,
// same grant web/src/lib/supabase.ts's copy of this constant documents) —
// admin/internal/provenance columns are deliberately excluded. `select('*')`
// is NOT equivalent: PostgreSQL requires table-level SELECT to use the `*`
// wildcard at all, so a public listings query must spell out this list (or a
// subset) instead — an unrestricted `*` query fails outright with
// "permission denied for table listings" under a column-level grant.
export const PUBLIC_LISTING_COLUMNS =
  'id,created_by,name,note,price_rupees,photo_url,latitude,longitude,city,created_at,location_label,dishes,rating';
