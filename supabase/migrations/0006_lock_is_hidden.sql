-- Beggars Map: prevent listing owners from undoing moderation.
--
-- "owners can update their own listings" (0001_init.sql) has no column
-- restriction, so an owner's own authenticated update call could freely
-- flip is_hidden back to false after a moderator hid it via the dashboard
-- (RLS only checked row ownership, not which columns changed). Plain RLS
-- can't express "this column is only writable by X" on its own — a
-- BEFORE UPDATE trigger is the standard way to lock a single column.
--
-- Any change to is_hidden made by a non-service_role caller is silently
-- reverted to its previous value; the rest of the row (name, price, note,
-- photo, etc.) still updates normally. Only requests made with the
-- service_role key (i.e. an admin acting outside RLS) can actually change
-- is_hidden going forward.

create or replace function public.lock_listing_is_hidden()
returns trigger
language plpgsql
as $$
begin
  if new.is_hidden is distinct from old.is_hidden and auth.role() <> 'service_role' then
    new.is_hidden := old.is_hidden;
  end if;
  return new;
end;
$$;

create trigger listings_lock_is_hidden
  before update on public.listings
  for each row
  execute function public.lock_listing_is_hidden();
