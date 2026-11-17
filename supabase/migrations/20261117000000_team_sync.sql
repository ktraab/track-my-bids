-- TrackMyBids team sync, schema version 1.
-- Every synced SQLite row lives in sync_rows as JSON. Writes go through apply_changes() only.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  role text not null default 'pending' check (role in ('pending', 'member', 'admin')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create sequence public.sync_seq;

create table public.sync_rows (
  tbl text not null check (tbl in ('bids', 'contacts', 'milestones', 'checklist_items', 'bid_contacts')),
  id text not null,
  data jsonb not null,
  field_times jsonb not null default '{}'::jsonb,
  server_seq bigint not null,
  updated_by uuid references auth.users (id) on delete set null,
  primary key (tbl, id)
);

create index sync_rows_seq on public.sync_rows (server_seq);
create unique index sync_contacts_email_live on public.sync_rows (lower(data ->> 'email'))
  where tbl = 'contacts' and data ->> 'email' is not null and data ->> 'deleted_at' is null;
create unique index sync_bid_contacts_slot on public.sync_rows ((data ->> 'bid_id'), (data ->> 'contact_id'), (data ->> 'role'))
  where tbl = 'bid_contacts';

-- New auth user → profile. The very first one becomes admin.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(4242);
  insert into public.profiles (id, email, display_name, role, active)
  values (
    new.id, new.email,
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), split_part(new.email, '@', 1)),
    case when exists (select 1 from public.profiles) then 'pending' else 'admin' end,
    true);
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.is_approved() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role in ('member', 'admin'));
$$;

create function public.sync_schema_version() returns integer
language sql immutable set search_path = '' as $$ select 1 $$;

create function public.set_member(target uuid, new_role text, new_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  -- One membership change at a time, so two admins can't demote each other into zero admins.
  perform pg_advisory_xact_lock(4244);
  if not exists (select 1 from public.profiles where id = auth.uid() and active and role = 'admin') then
    raise exception 'not_admin';
  end if;
  if new_role not in ('pending', 'member', 'admin') then raise exception 'bad_role'; end if;
  if target = auth.uid() and (new_role <> 'admin' or not new_active) then raise exception 'cannot_demote_self'; end if;
  if (new_role <> 'admin' or not new_active)
     and not exists (select 1 from public.profiles where id <> target and active and role = 'admin') then
    raise exception 'last_admin';
  end if;
  update public.profiles set role = new_role, active = new_active where id = target;
end $$;

-- changes: [{tbl, id, values: {col: value}, times: {col: iso}}]
-- returns: [{tbl, id, status: accepted|incomplete|rejected|remapped, reason?, to?, row?: {tbl, id, data, seq}}]
-- accepted carries `row` (the merged row) when at least one incoming field lost last-writer-wins: nothing new
-- is pulled for a losing field, so the sender needs the winner here to converge.
create function public.apply_changes(changes jsonb) returns jsonb
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
       or t is null or rid is null or t not in ('bids', 'contacts', 'milestones', 'checklist_items', 'bid_contacts') then
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
      end if;
      if dup.id is not null then
        result := result || jsonb_build_array(jsonb_build_object('tbl', t, 'id', rid, 'status', 'remapped', 'to', dup.id,
          'row', jsonb_build_object('tbl', dup.tbl, 'id', dup.id, 'data', dup.data, 'seq', dup.server_seq)));
        continue;
      end if;
      if t = 'bids' and vals ->> 'owner_id' is null then
        vals := vals || jsonb_build_object('owner_id', me::text);
      end if;
      insert into public.sync_rows (tbl, id, data, field_times, server_seq, updated_by)
        values (t, rid, vals, times, nextval('public.sync_seq'), me);
      result := result || jsonb_build_array(jsonb_build_object('tbl', t, 'id', rid, 'status', 'accepted'));
      continue;
    end if;

    -- Deleting/restoring or reassigning a bid: owner or admin only.
    if t = 'bids' and my_role <> 'admin' and coalesce(cur.data ->> 'owner_id', '') <> me::text then
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

-- Access: signed-in users read through RLS; all writes go through the functions above.
alter table public.profiles enable row level security;
alter table public.sync_rows enable row level security;

create policy profiles_read on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_approved()));
create policy sync_rows_read on public.sync_rows for select to authenticated
  using ((select public.is_approved()));

revoke all on public.profiles, public.sync_rows from anon, authenticated;
grant select on public.profiles, public.sync_rows to authenticated;
revoke all on sequence public.sync_seq from anon, authenticated;

revoke execute on function public.apply_changes(jsonb), public.set_member(uuid, text, boolean),
  public.is_approved(), public.sync_schema_version(), public.handle_new_user() from public, anon;
grant execute on function public.apply_changes(jsonb), public.set_member(uuid, text, boolean),
  public.is_approved(), public.sync_schema_version() to authenticated;
revoke execute on function public.handle_new_user() from authenticated;
