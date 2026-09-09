-- Beggars Map: widen admin_audit_log's action/target_type lists to cover
-- the new correction-approval and review-moderation actions the
-- admin-corrections Edge Function (a later phase) will write. Postgres has
-- no "add value to check constraint" — drop and recreate with the longer
-- list, same mechanism 0014 already used for mark_reviewed/mark_unreviewed.
--
-- This does not touch any existing row — admin_audit_log is append-only/
-- immutable (0013's prevent_admin_audit_log_mutation trigger blocks UPDATE/
-- DELETE even for service_role), and a constraint widening only affects
-- rows inserted after this migration runs.
alter table admin_audit_log drop constraint admin_audit_log_action_check;
alter table admin_audit_log add constraint admin_audit_log_action_check
  check (action in (
    'create', 'import', 'edit', 'hide', 'unhide', 'archive', 'unarchive',
    'resolve_report', 'mark_reviewed', 'mark_unreviewed',
    'approve_correction', 'reject_correction', 'delete_review'
  ));

alter table admin_audit_log drop constraint admin_audit_log_target_type_check;
alter table admin_audit_log add constraint admin_audit_log_target_type_check
  check (target_type in ('listing', 'report', 'listing_correction', 'listing_review'));
