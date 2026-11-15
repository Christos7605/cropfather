-- 0004_map_module.sql
-- Field Shift: everything the field map needs.
--
--   1. New field columns: perimeter, centroid, timestamps, terrain slots
--   2. Geometry rules with translatable error codes (FS001-FS011)
--   3. No overlapping fields (own fields and other farmers' fields)
--   4. Field limit with a translatable error code
--   5. my_fields view: fields as GeoJSON for the frontend
--   6. RPCs: field_preview, create_field, update_field_geometry, neighbour_fields
--   7. field_profiles: cache for the per-field NASA/soil profile (filled later by the API)
--   8. Small integrity fixes on crop_history and recommendation_runs
--
-- Run after 0003. Idempotent: safe to run more than once.
--
-- Error codes raised (the frontend translates them via errors.<code>):
--   FS001 not a valid polygon (crosses itself)     FS007 too many corners (> 500)
--   FS002 smaller than 0.01 ha                     FS008 shape could not be read
--   FS003 larger than 10,000 ha                    FS009 coordinates out of range
--   FS004 field limit reached                      FS010 polygon has holes
--   FS005 overlaps one of your own fields          FS011 name empty or longer than 80
--   FS006 overlaps a field registered by another farmer

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
alter table public.fields add column if not exists perimeter_m     numeric;
alter table public.fields add column if not exists centroid        geometry(Point, 4326);
alter table public.fields add column if not exists elevation_m     numeric;   -- NASADEM, filled by the pipeline/API
alter table public.fields add column if not exists slope_deg       numeric;   -- NASADEM, filled by the pipeline/API
alter table public.fields add column if not exists updated_at      timestamptz not null default now();
alter table public.fields add column if not exists geom_updated_at timestamptz not null default now();

update public.fields set name = btrim(name) where name <> btrim(name);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fields_name_check') then
    alter table public.fields
      add constraint fields_name_check check (char_length(btrim(name)) between 1 and 80);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crop_history_season_year_check') then
    alter table public.crop_history
      add constraint crop_history_season_year_check check (season_year between 1950 and 2100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crop_history_source_check') then
    alter table public.crop_history
      add constraint crop_history_source_check
      check (source in ('farmer', 'worldcereal', 'cdl', 'ndvi'));
  end if;
end $$;

alter table public.fields alter column irrigation set not null;

create index if not exists fields_user_created_idx on public.fields (user_id, created_at);
create index if not exists fields_centroid_idx on public.fields using gist (centroid);

-- ---------------------------------------------------------------------------
-- 2. Geometry rules
-- ---------------------------------------------------------------------------
-- Returns the error code for a candidate boundary, or null when it is acceptable.
create or replace function public.field_geometry_error(g geometry)
returns text
language plpgsql
immutable
set search_path = public, extensions, pg_temp
as $$
declare
  v_area_ha numeric;
begin
  if g is null or geometrytype(g) <> 'POLYGON' or st_srid(g) <> 4326 or st_isempty(g) then
    return 'FS008';
  end if;
  if st_xmin(g) < -180 or st_xmax(g) > 180 or st_ymin(g) < -90 or st_ymax(g) > 90 then
    return 'FS009';
  end if;
  if st_numinteriorrings(g) > 0 then
    return 'FS010';
  end if;
  if st_npoints(g) > 501 then   -- 500 corners plus the closing point
    return 'FS007';
  end if;
  if not st_isvalid(g) then
    return 'FS001';
  end if;
  v_area_ha := st_area(g::geography) / 10000;
  if v_area_ha < 0.01 then
    return 'FS002';
  end if;
  if v_area_ha > 10000 then
    return 'FS003';
  end if;
  return null;
end;
$$;

-- Validates, normalises and derives area, perimeter, centroid and grid cell.
create or replace function public.set_field_derived()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_code text;
begin
  new.name := btrim(new.name);
  if new.name is null or char_length(new.name) not between 1 and 80 then
    raise exception 'Field name must be 1-80 characters' using errcode = 'FS011';
  end if;

  if tg_op = 'INSERT' or new.geom is distinct from old.geom then
    -- Drop duplicate consecutive corners and use GeoJSON ring order (counter-clockwise)
    new.geom := st_forcepolygonccw(st_removerepeatedpoints(new.geom));

    v_code := public.field_geometry_error(new.geom);
    if v_code is not null then
      raise exception 'Invalid field boundary (%)', v_code using errcode = v_code;
    end if;

    new.area_ha := round((st_area(new.geom::geography) / 10000)::numeric, 2);
    new.perimeter_m := round(st_perimeter(new.geom::geography)::numeric, 1);
    new.centroid := st_pointonsurface(new.geom);
    new.geom_updated_at := now();

    new.cell_id := null;
    if to_regclass('public.grid_cells') is not null then
      select g.id into new.cell_id
      from public.grid_cells g
      where st_intersects(g.geom, new.centroid)
      limit 1;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists fields_derive on public.fields;
create trigger fields_derive
  before insert or update on public.fields
  for each row execute function public.set_field_derived();

-- ---------------------------------------------------------------------------
-- 3. Overlap rules
-- ---------------------------------------------------------------------------
-- A field may not overlap the caller's other fields, or fields of registered
-- (non-guest) farmers. Guest fields never block anyone: guests are temporary,
-- so an abandoned guest session cannot lock land forever.
-- Shared edges are fine; only overlaps larger than 1 m² count (drawing tolerance).

-- Union of the shapes that block g for this owner, or null when nothing blocks it.
create or replace function public.field_blockers(
  g geometry,
  p_owner uuid,
  p_exclude uuid,
  p_own boolean
)
returns geometry
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select st_union(f.geom)
  from public.fields f
  where f.geom && g
    and st_intersects(f.geom, g)
    and f.id is distinct from p_exclude
    and (
      (p_own and f.user_id = p_owner)
      or (
        not p_own
        and f.user_id <> p_owner
        and exists (
          select 1 from auth.users u
          where u.id = f.user_id and coalesce(u.is_anonymous, false) = false
        )
      )
    )
$$;

revoke execute on function public.field_blockers(geometry, uuid, uuid, boolean) from public, anon, authenticated;

create or replace function public.enforce_field_no_overlap()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_block geometry;
begin
  if tg_op = 'UPDATE' and new.geom is not distinct from old.geom then
    return new;
  end if;

  -- Serialise boundary writes so two farmers cannot claim the same land at the same moment
  perform pg_advisory_xact_lock(hashtext('fieldshift.fields.geom'));

  v_block := public.field_blockers(new.geom, new.user_id, new.id, true);
  if v_block is not null and st_area(st_intersection(new.geom, v_block)::geography) > 1 then
    raise exception 'Field overlaps one of your own fields' using errcode = 'FS005';
  end if;

  v_block := public.field_blockers(new.geom, new.user_id, new.id, false);
  if v_block is not null and st_area(st_intersection(new.geom, v_block)::geography) > 1 then
    raise exception 'Field overlaps land registered by another farmer' using errcode = 'FS006';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_field_no_overlap() from public, anon, authenticated;

drop trigger if exists fields_no_overlap on public.fields;
create trigger fields_no_overlap      -- runs after fields_derive and fields_limit (alphabetical)
  before insert or update of geom on public.fields
  for each row execute function public.enforce_field_no_overlap();

-- ---------------------------------------------------------------------------
-- 4. Field limit (same rule as 0002, now with a translatable code)
-- ---------------------------------------------------------------------------
create or replace function public.field_limit_for(p_user uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case when coalesce(
    (select u.is_anonymous from auth.users u where u.id = p_user), false
  ) then 3 else 25 end
$$;

revoke execute on function public.field_limit_for(uuid) from public, anon;
grant execute on function public.field_limit_for(uuid) to authenticated;

create or replace function public.enforce_field_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_max   integer;
begin
  perform pg_advisory_xact_lock(hashtext('fieldshift.limit.' || new.user_id::text));
  v_max := public.field_limit_for(new.user_id);
  select count(*) into v_count from public.fields f where f.user_id = new.user_id;
  if v_count >= v_max then
    raise exception 'Field limit reached (% fields for this account type)', v_max
      using errcode = 'FS004';
  end if;
  return new;
end;
$$;

revoke execute on function public.enforce_field_limit() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. my_fields: the caller's fields with GeoJSON (RLS applies: security_invoker)
-- ---------------------------------------------------------------------------
drop view if exists public.my_fields cascade;
create view public.my_fields
with (security_invoker = true)
as
select
  f.id,
  f.name,
  f.irrigation,
  f.area_ha::float8     as area_ha,
  f.perimeter_m::float8 as perimeter_m,
  f.cell_id,
  f.elevation_m::float8 as elevation_m,
  f.slope_deg::float8   as slope_deg,
  f.created_at,
  f.updated_at,
  f.geom_updated_at,
  st_x(f.centroid)      as centroid_lon,
  st_y(f.centroid)      as centroid_lat,
  st_asgeojson(f.geom, 7)::jsonb as geometry,
  (select count(*) from public.crop_history h where h.field_id = f.id)::int as history_count
from public.fields f;

revoke all on public.my_fields from anon;
grant select on public.my_fields to authenticated;

-- ---------------------------------------------------------------------------
-- 6. RPCs used by the map
-- ---------------------------------------------------------------------------
create or replace function public.geom_from_input(p_geometry jsonb)
returns geometry
language plpgsql
immutable
set search_path = public, extensions, pg_temp
as $$
begin
  return st_setsrid(st_geomfromgeojson(p_geometry::text), 4326);
exception when others then
  return null;
end;
$$;

-- Checks a drawn boundary before saving. Returns area, perimeter, any error code,
-- and, when the shape overlaps other fields, the boundary with the overlap removed.
-- Never writes anything.
create or replace function public.field_preview(p_geometry jsonb, p_exclude_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  g         geometry;
  v_code    text;
  v_block   geometry;
  v_own     geometry;
  v_other   geometry;
  v_overlap float8 := 0;
  v_own_m2  float8 := 0;
  v_other_m2 float8 := 0;
  v_rest    geometry;
  v_parts   int := 1;
  v_largest geometry;
  v_status  text := 'ok';
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  g := public.geom_from_input(p_geometry);
  if g is not null and geometrytype(g) = 'POLYGON' then
    g := st_forcepolygonccw(st_removerepeatedpoints(g));
  end if;

  v_code := public.field_geometry_error(g);
  if v_code is not null and v_code not in ('FS002', 'FS003') then
    return jsonb_build_object('status', 'invalid', 'code', v_code);
  end if;

  v_own   := public.field_blockers(g, v_uid, p_exclude_id, true);
  v_other := public.field_blockers(g, v_uid, p_exclude_id, false);
  v_block := case
    when v_own is null then v_other
    when v_other is null then v_own
    else st_union(v_own, v_other)
  end;

  if v_block is not null then
    v_overlap := st_area(st_intersection(g, v_block)::geography);
  end if;
  if v_own is not null then
    v_own_m2 := st_area(st_intersection(g, v_own)::geography);
  end if;
  if v_other is not null then
    v_other_m2 := st_area(st_intersection(g, v_other)::geography);
  end if;

  if v_overlap > 1 then
    v_rest := st_collectionextract(st_difference(g, v_block), 3);
    v_parts := st_numgeometries(v_rest);

    if v_rest is null or st_isempty(v_rest) then
      return jsonb_build_object(
        'status', 'invalid',
        'code', case when v_other_m2 > 1 then 'FS006' else 'FS005' end,
        'overlap_m2', round(v_overlap::numeric, 1)
      );
    end if;

    select d.geom into v_largest
    from st_dump(v_rest) d
    order by st_area(d.geom::geography) desc
    limit 1;

    if st_numinteriorrings(v_largest) > 0 then
      -- The other field sits entirely inside the drawn shape
      return jsonb_build_object('status', 'invalid', 'code', 'FS010',
                                'overlap_m2', round(v_overlap::numeric, 1));
    end if;

    g := v_largest;
    v_code := public.field_geometry_error(g);
    if v_code is not null and v_code not in ('FS002', 'FS003') then
      return jsonb_build_object('status', 'invalid', 'code', v_code);
    end if;
    v_status := 'trimmed';
  end if;

  return jsonb_build_object(
    'status', case when v_code is not null then 'invalid' else v_status end,
    'code', v_code,
    'area_ha', round((st_area(g::geography) / 10000)::numeric, 2),
    'perimeter_m', round(st_perimeter(g::geography)::numeric, 1),
    'overlap_m2', round(v_overlap::numeric, 1),
    'overlap_own_m2', round(v_own_m2::numeric, 1),
    'overlap_other_m2', round(v_other_m2::numeric, 1),
    'parts', v_parts,
    'geometry', case when v_status = 'trimmed' then st_asgeojson(g, 7)::jsonb end
  );
end;
$$;

revoke execute on function public.field_preview(jsonb, uuid) from public, anon;
grant execute on function public.field_preview(jsonb, uuid) to authenticated;

-- Creates a field for the caller. Runs with the caller's rights, so RLS and all
-- triggers (validation, limit, overlap) apply.
create or replace function public.create_field(
  p_name text,
  p_geometry jsonb,
  p_irrigation text default 'rainfed'
)
returns setof public.my_fields
language plpgsql
security invoker
set search_path = public, extensions, pg_temp
as $$
declare
  g    geometry := public.geom_from_input(p_geometry);
  v_id uuid;
begin
  if g is null or geometrytype(g) <> 'POLYGON' then
    raise exception 'Shape could not be read' using errcode = 'FS008';
  end if;
  insert into public.fields (name, geom, irrigation)
  values (p_name, g, coalesce(p_irrigation, 'rainfed'))
  returning id into v_id;
  return query select * from public.my_fields where id = v_id;
end;
$$;

revoke execute on function public.create_field(text, jsonb, text) from public, anon;
grant execute on function public.create_field(text, jsonb, text) to authenticated;

create or replace function public.update_field_geometry(p_id uuid, p_geometry jsonb)
returns setof public.my_fields
language plpgsql
security invoker
set search_path = public, extensions, pg_temp
as $$
declare
  g geometry := public.geom_from_input(p_geometry);
begin
  if g is null or geometrytype(g) <> 'POLYGON' then
    raise exception 'Shape could not be read' using errcode = 'FS008';
  end if;
  update public.fields set geom = g where id = p_id;
  if not found then
    raise exception 'Field not found' using errcode = '42501';
  end if;
  return query select * from public.my_fields where id = p_id;
end;
$$;

revoke execute on function public.update_field_geometry(uuid, jsonb) from public, anon;
grant execute on function public.update_field_geometry(uuid, jsonb) to authenticated;

-- Outlines of land already registered by other (non-guest) farmers inside the
-- visible map area. Returns shapes only: no ids, names, owners or any other column.
-- Limited to small areas (about 1° x 1°) and 3,000 shapes per call.
create or replace function public.neighbour_fields(
  p_west float8, p_south float8, p_east float8, p_north float8
)
returns table (geometry jsonb)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select st_asgeojson(f.geom, 7)::jsonb
  from public.fields f
  join auth.users u on u.id = f.user_id
  where auth.uid() is not null
    and f.user_id <> auth.uid()
    and coalesce(u.is_anonymous, false) = false
    and p_east > p_west and p_north > p_south
    and (p_east - p_west) <= 1.2 and (p_north - p_south) <= 1.2
    and f.geom && st_makeenvelope(p_west, p_south, p_east, p_north, 4326)
  limit 3000
$$;

revoke execute on function public.neighbour_fields(float8, float8, float8, float8) from public, anon;
grant execute on function public.neighbour_fields(float8, float8, float8, float8) to authenticated;

revoke execute on function public.field_geometry_error(geometry) from public, anon;
revoke execute on function public.geom_from_input(jsonb) from public, anon;

-- ---------------------------------------------------------------------------
-- 7. field_profiles: cached NASA/soil/terrain profile per field (written by the API)
--    A profile is stale when computed_at < fields.geom_updated_at.
-- ---------------------------------------------------------------------------
create table if not exists public.field_profiles (
  field_id      uuid primary key references public.fields (id) on delete cascade,
  data          jsonb not null,
  model_version text,
  computed_at   timestamptz not null default now()
);

alter table public.field_profiles enable row level security;
drop policy if exists "field_profiles_read_own" on public.field_profiles;
create policy "field_profiles_read_own" on public.field_profiles
  for select using (exists (
    select 1 from public.fields f
    where f.id = field_profiles.field_id and f.user_id = (select auth.uid())
  ));
-- No insert/update/delete policies: only the service role (FastAPI) writes here.

-- ---------------------------------------------------------------------------
-- 8. recommendation_runs: a run may only reference the caller's own field
-- ---------------------------------------------------------------------------
drop policy if exists "recommendation_runs_own" on public.recommendation_runs;
create policy "recommendation_runs_own" on public.recommendation_runs
  for all
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and (
      field_id is null
      or exists (select 1 from public.fields f
                 where f.id = field_id and f.user_id = (select auth.uid()))
    )
  );

-- ---------------------------------------------------------------------------
-- Verification (run manually):
--   select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'fields' order by ordinal_position;
--   select tgname from pg_trigger where tgrelid = 'public.fields'::regclass and not tgisinternal;
--     -> fields_derive, fields_limit, fields_no_overlap
-- ---------------------------------------------------------------------------