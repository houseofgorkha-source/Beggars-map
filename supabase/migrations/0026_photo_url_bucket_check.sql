-- Beggars Map: restrict listing_photos.photo_url / listing_review_photos.photo_url
-- to this project's own public listing-photos storage bucket (security
-- remediation S3, 2026-09-15).
--
-- listings.photo_url has carried this exact constraint since 0011
-- (listings_photo_url_bucket_check). listing_photos (0009) and
-- listing_review_photos (0022) never got the equivalent -- their INSERT
-- policies only check ROW ownership (the caller owns the listing/review),
-- never the URL's actual target. A caller who owns a listing/review could
-- insert a photo row pointing at an arbitrary external URL (a tracking
-- pixel, offensive content) with no upload required at all, bypassing the
-- storage bucket's own mime/size restrictions (0018) entirely since they
-- never come into play.
--
-- Read-only production check before writing this file: 268 existing
-- listing_photos rows, 0 would violate this pattern; listing_review_photos
-- has 0 rows. Safe as a plain (non-NOT VALID) constraint -- no existing row
-- is at risk of being invalidated by this migration.

alter table listing_photos add constraint listing_photos_photo_url_bucket_check
  check (photo_url like 'https://nvingzluboafxzxgxxwc.supabase.co/storage/v1/object/public/listing-photos/%');

alter table listing_review_photos add constraint listing_review_photos_photo_url_bucket_check
  check (photo_url like 'https://nvingzluboafxzxgxxwc.supabase.co/storage/v1/object/public/listing-photos/%');
