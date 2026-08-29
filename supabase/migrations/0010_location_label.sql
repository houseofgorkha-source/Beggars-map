-- Beggars Map: human-readable location descriptor for a listing (e.g. "100
-- Feet Road, Indiranagar" or, when street-level data isn't available,
-- "Indiranagar, Bengaluru"). Resolved client-side at submission time from
-- OLA's reverse-geocode endpoint (the same provider/key already used for
-- forward place search — see web/src/lib/olaPlaces.ts) and stored once,
-- since a listing's coordinates never change after creation. Purely
-- additive and nullable: latitude/longitude remain the authoritative
-- location, this is a display-only convenience that's simply absent when
-- geocoding can't resolve anything useful for a spot — never fabricated.

alter table listings add column location_label text;
