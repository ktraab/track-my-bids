-- Bid document import (schema 3): learned label phrases sync as a new table (extract_labels), and bids
-- gain E-Rate columns (erate, erate_470_number, erate_funding_year, erate_category) plus a new milestone
-- type 'allowable_contract'; quote_lines gains unit_cost (a line's own cost). Bid/milestone/quote-line columns
-- live inside sync_rows.data (JSON) and apply_changes has no per-column allowlist, so they need no DDL
-- here; only the table allowlist, the duplicate-phrase rule and the schema version change.
-- Bumps sync_schema_version() to 3 so app versions that predate extract_labels pause sync
-- ("server needs an update") instead of failing on unknown rows.
-- Deploy this BEFORE releasing the app version with SCHEMA_VERSION = 3.

alter table public.sync_rows drop constraint sync_rows_tbl_check;
alter table public.sync_rows add constraint sync_rows_tbl_check check (tbl in (
  'bids', 'contacts', 'extract_labels', 'milestones', 'checklist_items', 'bid_contacts',
  'vendor_quotes', 'quote_lines', 'vendor_line_prices'));

-- One row per learned phrase (deleted rows included, matching the app's UNIQUE (field, phrase)).
create unique index if not exists sync_extract_labels_phrase on public.sync_rows ((data ->> 'field'), (data ->> 'phrase'))
  where tbl = 'extract_labels';

create or replace function public.sync_schema_version() returns integer
language sql immutable set search_path = '' as $$ select 3 $$;

-- changes: [{tbl, id, values: {col: value}, times: {col: iso}}]
-- returns: [{tbl, id, status: accepted|incomplete|rejected|remapped, reason?, to?, row?: {tbl, id, data, seq}}]
-- accepted carries `row` (the merged row) when at least one incoming field lost last-writer-wins: nothing new
-- is pulled for a losing field, so the sender needs the winner here to converge. It also carries `row` on an
-- insert whose values the server changed (a defaulted owner_id), for the same reason.
--
-- Same as 20261119000000_quotes.sql's apply_changes, plus:
--  * extract_labels is an accepted table.
--  * A new extract_labels row whose (field, phrase) the server already holds (live or deleted) is
--    remapped to the existing row, like a duplicate contact email: the team keeps one row per phrase.
create or replace function public.apply_changes(changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  my_role text;
  ch jsonb;
  t text;
  rid text;
  vals jsonb;
  times jsonb;
  cur public.sync_rows%rowtype;
  dup public.sync_rows%rowtype;
  merged jsonb;
  merged_times jsonb;
  f text;
  incoming text;
  lost boolean;
  defaulted boolean;
  new_seq bigint;
  result jsonb := '[]'::jsonb;
begin
  select role into my_role from public.profiles where id = me and active;
  if my_role is null or my_role not in ('member', 'admin') then
    raise exception 'not_approved';
  end if;
  -- One writer at a time: sequence order == commit order, so pull cursors never skip a row.
  perform pg_advisory_xact_lock(4243);

  for ch in select value from jsonb_array_elements(changes) loop
    t := ch ->> 'tbl';
    rid := ch ->> 'id';
    vals := coalesce(ch -> 'values', '{}'::jsonb);
    times := coalesce(ch -> 'times', '{}'::jsonb);

    if jsonb_typeof(vals) <> 'object' or jsonb_typeof(times) <> 'object'
       or t is null or rid is null or t not in ('bids', 'contacts', 'extract_labels', 'milestones', 'checklist_items', 'bid_contacts', 'vendor_quotes', 'quote_lines', 'vendor_line_prices') then
      result := result || jsonb_build_array(jsonb_build_object('tbl', t, 'id', rid, 'status', 'rejected', 'reason', 'bad_change', 'row', null));
      continue;
    end if;

    select * into cur from public.sync_rows where tbl = t and id = rid for update;

    if not found then
      if not (vals ? 'created_at') then
        result := result || jsonb_build_array(jsonb_build_object('tbl', t, 'id', rid, 'status', 'incomplete'));
        continue;
      end if;
      dup := null;
      if t = 'contacts' and vals ->> 'email' is not null and vals ->> 'deleted_at' is null then
        select * into dup from public.sync_rows
          where tbl = 'contacts' and lower(data ->> 'email') = lower(vals ->> 'email') and data ->> 'deleted_at' is null;
      elsif t = 'bid_contacts' then
        select * into dup from public.sync_rows
          where tbl = 'bid_contacts' and data ->> 'bid_id' = vals ->> 'bid_id'
            and data ->> 'contact_id' = vals ->> 'contact_id' and data ->> 'role' = vals ->> 'role';
      elsif t = 'extract_labels' then
        select * into dup from public.sync_rows
          where tbl = 'extract_labels' and data ->> 'field' = vals ->> 'field' and data ->> 'phrase' = vals ->> 'phrase';
      end if;
      if dup.id is not null then
        result := result || jsonb_build_array(jsonb_build_object('tbl', t, 'id', rid, 'status', 'remapped', 'to', dup.id,
          'row', jsonb_build_object('tbl', dup.tbl, 'id', dup.id, 'data', dup.data, 'seq', dup.server_seq)));
        continue;
      end if;
      -- Formal bids default to the pusher; quotes (kind = 'rfq') may stay unassigned.
      defaulted := false;
      if t = 'bids' and vals ->> 'owner_id' is null and coalesce(vals ->> 'kind', 'bid') <> 'rfq' then
        vals := vals || jsonb_build_object('owner_id', me::text);
        defaulted := true;
      end if;
      new_seq := nextval('public.sync_seq');
      insert into public.sync_rows (tbl, id, data, field_times, server_seq, updated_by)
        values (t, rid, vals, times, new_seq, me);
      if defaulted then
        -- The stored row differs from what was sent: hand it back so the sender converges.
        result := result || jsonb_build_array(jsonb_build_object('tbl', t, 'id', rid, 'status', 'accepted',
          'row', jsonb_build_object('tbl', t, 'id', rid, 'data', vals, 'seq', new_seq)));
      else
        result := result || jsonb_build_array(jsonb_build_object('tbl', t, 'id', rid, 'status', 'accepted'));
      end if;
      continue;
    end if;

    -- Deleting/restoring or reassigning an OWNED bid: owner or admin only. Unowned rows (unassigned
    -- quotes) can be claimed, reassigned, deleted or restored by any member.
    if t = 'bids' and my_role <> 'admin'
       and cur.data ->> 'owner_id' is not null and cur.data ->> 'owner_id' <> me::text then
      if (vals ? 'deleted_at' and ((vals ->> 'deleted_at') is null) <> ((cur.data ->> 'deleted_at') is null))
         or (vals ? 'owner_id' and (vals ->> 'owner_id') is distinct from (cur.data ->> 'owner_id')) then
        result := result || jsonb_build_array(jsonb_build_object('tbl', t, 'id', rid, 'status', 'rejected', 'reason', 'not_owner',
          'row', jsonb_build_object('tbl', cur.tbl, 'id', cur.id, 'data', cur.data, 'seq', cur.server_seq)));
        continue;
      end if;
    end if;

    merged := cur.data;
    merged_times := cur.field_times;
    lost := false;
    for f in select jsonb_object_keys(vals) loop
      incoming := coalesce(times ->> f, '');
      -- Byte-order compare (collate "C") so the winner matches the client's JS string comparison.
      if (merged_times ->> f) is null or incoming collate "C" >= (merged_times ->> f) collate "C" then
        merged := merged || jsonb_build_object(f, vals -> f);
        merged_times := merged_times || jsonb_build_object(f, incoming);
      else
        lost := true;
      end if;
    end loop;

    begin
      new_seq := cur.server_seq;
      if merged <> cur.data then
        new_seq := nextval('public.sync_seq');
        update public.sync_rows set data = merged, field_times = merged_times, server_seq = new_seq, updated_by = me
          where tbl = t and id = rid;
      elsif merged_times <> cur.field_times then
        update public.sync_rows set field_times = merged_times where tbl = t and id = rid;
      end if;
      if lost then
        result := result || jsonb_build_array(jsonb_build_object('tbl', t, 'id', rid, 'status', 'accepted',
          'row', jsonb_build_object('tbl', t, 'id', rid, 'data', merged, 'seq', new_seq)));
      else
        result := result || jsonb_build_array(jsonb_build_object('tbl', t, 'id', rid, 'status', 'accepted'));
      end if;
    exception when unique_violation then
      result := result || jsonb_build_array(jsonb_build_object('tbl', t, 'id', rid, 'status', 'rejected', 'reason', 'conflict',
        'row', jsonb_build_object('tbl', cur.tbl, 'id', cur.id, 'data', cur.data, 'seq', cur.server_seq)));
    end;
  end loop;

  return result;
end $$;
