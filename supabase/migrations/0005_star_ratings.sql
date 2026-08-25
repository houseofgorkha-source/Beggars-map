-- Beggars Map: replace the worth-it/not-worth-it toggle with a 4-category
-- star rating system (food quality, hygiene, availability, maintenance).

alter table reviews drop column worth_it;

alter table reviews add column food_quality smallint not null default 5 check (food_quality between 1 and 5);
alter table reviews add column hygiene smallint not null default 5 check (hygiene between 1 and 5);
alter table reviews add column availability smallint not null default 5 check (availability between 1 and 5);
alter table reviews add column maintenance smallint not null default 5 check (maintenance between 1 and 5);

-- Drop the defaults now that existing rows (none yet, but future migrations
-- may run against real data) are backfilled — new inserts must always supply
-- explicit ratings from here on.
alter table reviews alter column food_quality drop default;
alter table reviews alter column hygiene drop default;
alter table reviews alter column availability drop default;
alter table reviews alter column maintenance drop default;

-- Per-listing aggregate rating, used by the Map/list screens on both apps.
create view listing_ratings as
select
  listing_id,
  round(avg((food_quality + hygiene + availability + maintenance) / 4.0)::numeric, 1) as avg_rating,
  count(*) as rating_count
from reviews
group by listing_id;
