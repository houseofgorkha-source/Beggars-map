-- Beggars Map: enforce the ₹100 price cap (Geoji Map parity decision, 2026-08-25).
-- Any pre-existing listing over ₹100 must be resolved before this will apply cleanly.

alter table listings drop constraint listings_price_rupees_check;
alter table listings add constraint listings_price_rupees_check check (price_rupees > 0 and price_rupees <= 100);
