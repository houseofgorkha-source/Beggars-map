# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# Beggars Map

Crowdsourced map/directory of cheap eats in Bengaluru (India take on Korea's viral "Geojimap"). No price cap — listings sort cheapest-first, community upvotes surface quality. See full product plan and locked decisions in Claude's memory (`project-beggars-map`) — do not re-litigate scope choices made there without the user raising it.

## Stack
- Expo (React Native) + TypeScript, `blank-typescript` template
- Map: OLA Maps (India-tuned, 500K free loads/month)
- Backend: Supabase (free tier) — Postgres schema in `supabase/migrations/0001_init.sql` (profiles, listings, reviews, votes, reports, leaderboard view). Client at `src/lib/supabase.ts`, reads `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` from env (`.env`, gitignored — see `.env.example`). RLS is on: public read, writes require `auth.uid()` to match the row owner.
- Target: Google Play + Apple App Store, budget ~$140 total (Apple $99/yr, Google Play $25 one-time)

## Core MVP screens
1. Map view with search (default screen)
2. Add Listing — drop pin, name, price, photo, short note
3. Listing Detail — photos, reviews, worth-it votes
4. Leaderboard — top contributors
5. Profile — my contributions + rank only (no settings/bio)

## Conventions
- Browsing is open with no login; Google/phone-OTP sign-in required only to post a listing or vote
- Every listing needs a report/block affordance (required by both app stores for UGC)
- No submission gate on listings — keep friction near zero, quality comes from community upvotes
- `npm install` in this repo needs `--ignore-scripts` — a user-level `.npmrc` (`allow-scripts=@anthropic-ai/claude-code`) blocks project-scoped install scripts otherwise
