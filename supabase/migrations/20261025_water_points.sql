-- 0006_water_points.sql
-- Field Shift: public water points (wells, boreholes, springs...) and the field's water source.
--
--   water_points   the National Register of Water Abstraction Points (ΕΜΣΥ), open data from
--                  data.gov.gr, loaded once from water_points.csv. Read-only for the app.
--   fields         + water_point_id   the point that waters the field (chosen by the farmer)
--                  + well_depth_m     borehole depth in metres, as stated by the farmer
--   my_fields      + the linked point's code, status, kind and position
--   water_points_in_view(...)  points inside the visible map area, for the map layer
--
-- Run after 0005. Idempotent: safe to run more than once.
-- Then import water_points.csv into public.water_points (see the guide).

-- ---------------------------------------------------------------------------
-- 1. Water points (reference data)
-- ---------------------------------------------------------------------------
create table if not exists public.water_points (
  id             bigint primary key,              -- OBJECTID in the register export
  code           text not null unique,            -- ΚΩΔΙΚΟΣ ΕΜΣΥ (13 digits)
  status         text not null default 'unknown'  -- ΚΑΘΕΣΤΩΣ ΧΡΗΣΗΣ
                 check (status in ('active', 'inactive', 'unknown')),
  kind           text not null default 'unknown'  -- ΕΙΔΟΣ ΣΥ
                 check (kind in ('borehole', 'well', 'spring', 'river', 'stream', 'lake',
                                 'coastal', 'transitional', 'other', 'unknown')),
  ownership      text not null default 'unknown'  -- ΙΔΙΟΚΤΗΣΙΑΚΟ ΚΑΘΕΣΤΩΣ
                 check (ownership in ('private', 'municipal', 'public', 'other', 'unknown')),
  region         text,                            -- ΠΕΡΙΦΕΡΕΙΑ
  regional_unit  text,                            -- ΠΕΡΙΦΕΡΕΙΑΚΗ ΕΝΟΤΗΤΑ
  municipality   text,                            -- ΔΗΜΟΣ (Καλλικράτης)
  municipal_unit text,                            -- ΔΗΜΟΤΙΚΗ ΕΝΟΤΗΤΑ
  community      text,                            -- ΚΟΙΝΟΤΗΤΑ
  water_district text,                            -- ΥΔΑΤΙΚΟ ΔΙΑΜΕΡΙΣΜΑ (01-14)
  river_basin    text,                            -- ΛΕΚΑΝΗ ΑΠΟΡΡΟΗΣ
  x_egsa87       numeric not null,                -- original coordinates (EPSG:2100)
  y_egsa87       numeric not null,
  lon            double precision not null check (lon between -180 and 180),
  lat            double precision not null check (lat between -90 and 90),
  geom           geometry(Point, 4326)
                 generated always as (st_setsrid(st_makepoint(lon, lat), 4326)) stored,
  source_date    date not null default date '2026-06-23'  -- date of the register export
);

create index if not exists water_points_geom_idx on public.water_points using gist (geom);

-- Reference data: readable by signed-in users (guests included), written only by the service role
alter table public.water_points enable row level security;
drop policy if exists "water_points_read" on public.water_points;
create policy "water_points_read" on public.water_points
  for select to authenticated using (true);
revoke insert, update, delete on public.water_points from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The field's water source
-- ---------------------------------------------------------------------------
alter table public.fields
  add column if not exists water_point_id bigint
  references public.water_points (id) on delete set null;
alter table public.fields add column if not exists well_depth_m numeric(6, 1);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fields_well_depth_check') then
    alter table public.fields
      add constraint fields_well_depth_check
      check (well_depth_m is null or (well_depth_m > 0 and well_depth_m <= 2000));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fields_well_depth_needs_point') then
    alter table public.fields
      add constraint fields_well_depth_needs_point
      check (well_depth_m is null or water_point_id is not null);
  end if;
end $$;

create index if not exists fields_water_point_idx on public.fields (water_point_id);

-- Removing the water point also clears its depth (needed by the check above when a
-- register update deletes a point: "on delete set null" runs first, then this)
create or replace function public.clear_depth_without_point()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.water_point_id is null then
    new.well_depth_m := null;
  end if;
  return new;
end;
$$;

revoke execute on function public.clear_depth_without_point() from public, anon, authenticated;

drop trigger if exists fields_clear_depth on public.fields;
create trigger fields_clear_depth
  before update of water_point_id on public.fields
  for each row execute function public.clear_depth_without_point();

-- ---------------------------------------------------------------------------
-- 3. my_fields: append the water source (existing columns keep their order)
-- ---------------------------------------------------------------------------
create or replace view public.my_fields
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
  (select count(*) from public.crop_history h where h.field_id = f.id)::int as history_count,
  f.boundary_source,
  f.kaek,
  f.water_point_id,
  f.well_depth_m::float8 as well_depth_m,
  w.code   as well_code,
  w.status as well_status,
  w.kind   as well_kind,
  w.lon    as well_lon,
  w.lat    as well_lat
from public.fields f
left join public.water_points w on w.id = f.water_point_id;

revoke all on public.my_fields from anon;
grant select on public.my_fields to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Water points in the visible map area
--    Limited to about 0.8° x 0.8° and 6,000 points per call (the map asks from zoom 12).
-- ---------------------------------------------------------------------------
create or replace function public.water_points_in_view(
  p_west float8, p_south float8, p_east float8, p_north float8
)
returns table (
  id bigint, code text, status text, kind text, ownership text,
  municipality text, community text, river_basin text,
  lon double precision, lat double precision
)
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  select w.id, w.code, w.status, w.kind, w.ownership,
         w.municipality, w.community, w.river_basin, w.lon, w.lat
  from public.water_points w
  where p_east > p_west and p_north > p_south
    and (p_east - p_west) <= 0.8 and (p_north - p_south) <= 0.8
    and w.geom && st_makeenvelope(p_west, p_south, p_east, p_north, 4326)
  limit 6000
$$;

revoke execute on function public.water_points_in_view(float8, float8, float8, float8) from public, anon;
grant execute on function public.water_points_in_view(float8, float8, float8, float8) to authenticated;

-- ---------------------------------------------------------------------------
-- Verification (run manually, after importing water_points.csv):
--   select count(*) from public.water_points;                       -- 154827
--   select status, count(*) from public.water_points group by 1;    -- active 115049, unknown 25949, inactive 13829
--   select count(*) from public.water_points where geom is null;    -- 0
-- ---------------------------------------------------------------------------