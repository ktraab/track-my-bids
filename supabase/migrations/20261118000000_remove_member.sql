-- Admin-only: hand a member's bids (trash included) to the calling admin, then delete their account.
-- Additive: no existing table or function changes, so sync_schema_version() stays 1.
create function public.remove_member(target uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  -- Same text format the app's triggers write, so last-writer-wins compares like with like.
  now_iso text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  r record;
begin
  -- Membership lock first (as set_member), then the writer lock (as apply_changes), so
  -- sync_seq order still equals commit order. Nothing takes these two in the other order.
  perform pg_advisory_xact_lock(4244);
  if not exists (select 1 from public.profiles where id = me and active and role = 'admin') then
    raise exception 'not_admin';
  end if;
  if target = me then raise exception 'cannot_remove_self'; end if;
  if not exists (select 1 from public.profiles where id = target) then raise exception 'not_found'; end if;
  perform pg_advisory_xact_lock(4243);

  for r in select id, field_times from public.sync_rows
           where tbl = 'bids' and data ->> 'owner_id' = target::text for update loop
    update public.sync_rows
      set data = data || jsonb_build_object('owner_id', me::text),
          field_times = field_times || jsonb_build_object('owner_id',
            greatest(now_iso collate "C", coalesce(r.field_times ->> 'owner_id', '') collate "C")),
          server_seq = nextval('public.sync_seq'),
          updated_by = me
      where tbl = 'bids' and id = r.id;
  end loop;

  -- Cascades to public.profiles; sync_rows.updated_by is set null.
  delete from auth.users where id = target;
end $$;

revoke execute on function public.remove_member(uuid) from public, anon;
grant execute on function public.remove_member(uuid) to authenticated;
