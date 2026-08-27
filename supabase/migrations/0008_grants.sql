-- Beggars Map: explicit table grants for anon/authenticated.
--
-- Found while runtime-verifying RLS locally: this local Postgres instance's
-- default ACL for tables owned by the `postgres` role only grants
-- TRUNCATE/REFERENCES/TRIGGER to anon/authenticated in the public schema —
-- not SELECT/INSERT/UPDATE/DELETE (`select grantee, privilege_type from
-- information_schema.role_table_grants` showed this for every table in
-- 0001-0007, before this migration). Every request from the anon/service
-- keys was failing with "permission denied for table X" (Postgres error
-- 42501) before RLS policies were ever evaluated — RLS narrows an already-
-- granted privilege, it doesn't substitute for one.
--
-- GRANT is idempotent, so this is a no-op wherever privileges already exist
-- (e.g. if the hosted project's provisioning already set these up
-- differently than local's fresh `supabase start` did).
grant select, insert, update, delete on
  public.profiles,
  public.listings,
  public.reviews,
  public.votes,
  public.reports
to anon, authenticated;
