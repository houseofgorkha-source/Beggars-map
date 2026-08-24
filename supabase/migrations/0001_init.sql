-- Beggars Map: initial schema
-- Run this in the Supabase SQL editor (or via `supabase db push`) on a fresh project.

create extension if not exists "pgcrypto";

-- profiles: one row per authenticated user, mirrors auth.users
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now()
);

-- listings: cheap-eat spots, no price cap, sorted cheapest-first by the app
create table listings (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references profiles (id) on delete cascade,
  name text not null,
  note text,
  price_rupees integer not null check (price_rupees > 0),
  photo_url text,
  latitude double precision not null,
  longitude double precision not null,
  city text not null default 'Bengaluru',
  is_hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create index listings_city_price_idx on listings (city, price_rupees) where not is_hidden;
create index listings_location_idx on listings (latitude, longitude) where not is_hidden;

-- reviews: comment + worth-it verdict on a listing
create table reviews (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings (id) on delete cascade,
  created_by uuid not null references profiles (id) on delete cascade,
  comment text,
  worth_it boolean not null,
  created_at timestamptz not null default now(),
  unique (listing_id, created_by)
);

-- votes: one upvote per user per listing, used for cheapest-first + quality ranking
create table votes (
  listing_id uuid not null references listings (id) on delete cascade,
  created_by uuid not null references profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (listing_id, created_by)
);

-- reports: required by app stores for any UGC surface
create table reports (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings (id) on delete cascade,
  reported_by uuid not null references profiles (id) on delete cascade,
  reason text not null,
  created_at timestamptz not null default now()
);

-- Row Level Security: browsing is public, writes require auth and ownership
alter table profiles enable row level security;
alter table listings enable row level security;
alter table reviews enable row level security;
alter table votes enable row level security;
alter table reports enable row level security;

create policy "profiles are publicly readable" on profiles for select using (true);
create policy "users manage their own profile" on profiles for all using (auth.uid() = id) with check (auth.uid() = id);

create policy "listings are publicly readable" on listings for select using (not is_hidden);
create policy "authenticated users can create listings" on listings for insert with check (auth.uid() = created_by);
create policy "owners can update their own listings" on listings for update using (auth.uid() = created_by);

create policy "reviews are publicly readable" on reviews for select using (true);
create policy "authenticated users can create reviews" on reviews for insert with check (auth.uid() = created_by);
create policy "owners can update their own reviews" on reviews for update using (auth.uid() = created_by);

create policy "votes are publicly readable" on votes for select using (true);
create policy "authenticated users can vote" on votes for insert with check (auth.uid() = created_by);
create policy "owners can remove their own vote" on votes for delete using (auth.uid() = created_by);

create policy "authenticated users can file reports" on reports for insert with check (auth.uid() = reported_by);

-- leaderboard: contribution counts per user, used by the Leaderboard + Profile screens
create view leaderboard as
select
  p.id as user_id,
  p.display_name,
  count(distinct l.id) as listing_count,
  count(distinct r.id) as review_count,
  count(distinct l.id) + count(distinct r.id) as score
from profiles p
left join listings l on l.created_by = p.id and not l.is_hidden
left join reviews r on r.created_by = p.id
group by p.id, p.display_name
order by score desc;
