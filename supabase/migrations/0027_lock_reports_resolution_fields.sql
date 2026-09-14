-- Beggars Map: lock reports.resolved_at / reports.resolved_by against
-- self-assignment (security remediation S7, 2026-09-15).
--
-- 0012 added resolved_at, 0013 added resolved_by, but neither column ever
-- got a lock trigger like listings' own admin-controlled fields have had
-- since 0006/0016. The public INSERT policy ("authenticated users can file
-- reports", 0001) has no column restriction beyond auth.uid() =
-- reported_by, so a direct REST call could submit a report that is already
-- pre-resolved with a forged resolved_by (including a real admin's email),
-- permanently excluding it from admin-reports' pending queue
-- (getPendingReportGroups filters resolved_at is null) without ever being
-- triaged.
--
-- Same shape as lock_listing_admin_fields() (0016), scoped to just these
-- two columns: forced null on INSERT, reverted to the prior value on
-- UPDATE, for any non-service_role caller. admin-reports' own resolve
-- action writes via its service-role client and is unaffected -- same
-- auth.role() <> 'service_role' guard used everywhere else in this schema.
--
-- Read-only production check before writing this file: 4 existing reports,
-- 3 already carry resolved_at/resolved_by -- consistent with genuine past
-- admin-reports resolutions (service-role writes), not evidence of the gap
-- having been exploited. This migration does not touch existing rows.

create or replace function public.lock_reports_resolution_fields()
returns trigger
language plpgsql
as $$
begin
  if auth.role() <> 'service_role' then
    if TG_OP = 'INSERT' then
      new.resolved_at := null;
      new.resolved_by := null;
    else
      if new.resolved_at is distinct from old.resolved_at then
        new.resolved_at := old.resolved_at;
      end if;
      if new.resolved_by is distinct from old.resolved_by then
        new.resolved_by := old.resolved_by;
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger reports_lock_resolution_fields
  before insert or update on public.reports
  for each row
  execute function public.lock_reports_resolution_fields();
