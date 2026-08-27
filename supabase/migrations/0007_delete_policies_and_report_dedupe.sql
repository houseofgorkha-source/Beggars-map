-- Beggars Map: H1 (owner self-delete for listings/reviews) + H6 (duplicate
-- report guard).
--
-- H1 decision: community content persists by default (moderation hides via
-- is_hidden, locked to service_role by 0006), but owners can remove their
-- own listings/reviews outright — matches typical UGC-app expectations and
-- keeps the account-deletion privacy promise honest even for a single
-- listing/review a user wants gone without deleting their whole account.
-- profiles/votes/reports are intentionally left without owner DELETE:
-- profiles only exist alongside an auth user (deleted via the delete-account
-- Edge Function, which cascades), votes already have owner DELETE from
-- 0001_init.sql, and reports have no user-facing "undo" concept.

create policy "owners can delete their own listings" on listings for delete using (auth.uid() = created_by);
create policy "owners can delete their own reviews" on reviews for delete using (auth.uid() = created_by);

-- H6: block a user from filing the exact same reason against the same
-- listing more than once. Different reasons (or the same reason on a
-- different listing) are unaffected, so a genuine follow-up report always
-- gets through.
alter table reports add constraint reports_no_duplicate_reason unique (listing_id, reported_by, reason);
