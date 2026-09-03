-- Beggars Map: restrict the listing-photos bucket to real image types and a
-- sane size cap (remediation for CTO-audit finding C-6).
--
-- 0002_storage.sql created this bucket `public: true` with no
-- allowed_mime_types and no file_size_limit. The client sets `contentType`
-- from the uploaded file's own declared type, which is not a control — any
-- anonymous session could upload arbitrary content (confirmed by testing:
-- an SVG with an embedded <script> tag uploaded successfully before this
-- migration) under its own UID prefix, publicly served from the Supabase
-- storage origin, with no size limit.
--
-- Restricted to exactly the three formats both apps' own upload code
-- already produces (AddListingModal.tsx/AddListingScreen.tsx read from an
-- image picker and upload the file's own type, never transcoding — jpeg/png
-- from a camera or gallery, webp from some mobile pickers/screenshots) and
-- a 5MB cap, comfortably above what those pickers produce for a single
-- listing photo. Confirmed via direct testing against the local stack
-- before applying here: a legitimate JPEG upload still succeeds, an SVG
-- upload is now rejected (415 invalid_mime_type), and a 6MB file is now
-- rejected (413 EntityTooLarge).
update storage.buckets
set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'],
    file_size_limit = 5242880 -- 5 MiB
where id = 'listing-photos';
