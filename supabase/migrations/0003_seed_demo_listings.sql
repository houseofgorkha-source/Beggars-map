-- Beggars Map: demo seed data for look-and-feel testing.
-- Safe to delete later — these are clearly marked as seed content via the note field.

do $$
declare
  seed_user_id uuid := '00000000-0000-0000-0000-000000000001';
begin
  insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
  values (seed_user_id, 'authenticated', 'authenticated', 'seed@beggarsmap.local', '', now(), now(), now())
  on conflict (id) do nothing;

  insert into public.profiles (id, display_name)
  values (seed_user_id, 'Beggars Map Team')
  on conflict (id) do nothing;

  insert into public.listings (created_by, name, note, price_rupees, latitude, longitude, city)
  values
    (seed_user_id, 'Shivaji Military Hotel', 'Legendary mutton biryani, been around since 1978. Go early, it sells out.', 180, 12.9634, 77.5855, 'Bengaluru'),
    (seed_user_id, 'CTR (Central Tiffin Room)', 'The benne masala dosa. Malleswaram institution, expect a queue.', 70, 13.0068, 77.5730, 'Bengaluru'),
    (seed_user_id, 'Vidyarthi Bhavan', 'Iconic Basavanagudi dosa joint, packed on weekends.', 60, 12.9422, 77.5709, 'Bengaluru'),
    (seed_user_id, 'Thindi Beedi street stalls', 'Chaat and juice stalls near KR Market, cheap and fast.', 40, 12.9634, 77.5794, 'Bengaluru'),
    (seed_user_id, 'Cafe Nagarjuna Tiffin Room', 'No-frills filter coffee and idli near Gandhi Bazaar.', 35, 12.9457, 77.5738, 'Bengaluru')
  on conflict do nothing;
end $$;
