-- 0005_cadastre_source.sql
-- Field Shift: remember where each field boundary came from.
--
--   boundary_source  'drawn'            traced by the farmer
--                    'cadastre'         copied unchanged from a Hellenic Cadastre parcel
--                    'cadastre_edited'  started from a Cadastre parcel, then adjusted
--   kaek             the Cadastre parcel code (ΚΑΕΚ) the boundary started from, if any
--
-- Run after 0004. Idempotent: safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
alter table public.fields add column if not exists boundary_source text not null default 'drawn';
alter table public.fields add column if not exists kaek text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fields_boundary_source_check') then
    alter table public.fields
      add constraint fields_boundary_source_check
      check (boundary_source in ('drawn', 'cadastre', 'cadastre_edited'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fields_kaek_check') then
    alter table public.fields
      add constraint fields_kaek_check
      check (kaek is null or kaek ~ '^[0-9A-Za-z/_-]{1,20}$');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Moving the corners of a Cadastre boundary marks it as adjusted
-- ---------------------------------------------------------------------------
create or replace function public.mark_cadastre_edited()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if new.geom is distinct from old.geom and old.boundary_source = 'cadastre' then
    new.boundary_source := 'cadastre_edited';
  end if;
  return new;
end;
$$;

revoke execute on function public.mark_cadastre_edited() from public, anon, authenticated;

drop trigger if exists fields_cadastre_edited on public.fields;
create trigger fields_cadastre_edited            -- runs after fields_derive (alphabetical)
  before update of geom on public.fields
  for each row execute function public.mark_cadastre_edited();

-- ---------------------------------------------------------------------------
-- 3. my_fields: append the two columns (keeps all existing columns in place)
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
  f.kaek
from public.fields f;

revoke all on public.my_fields from anon;
grant select on public.my_fields to authenticated;

-- ---------------------------------------------------------------------------
-- 4. create_field: optional source and ΚΑΕΚ
--    The 3-argument version is dropped so the API never has two to choose between.
-- ---------------------------------------------------------------------------
drop function if exists public.create_field(text, jsonb, text);

create or replace function public.create_field(
  p_name text,
  p_geometry jsonb,
  p_irrigation text default 'rainfed',
  p_source text default 'drawn',
  p_kaek text default null
)
returns setof public.my_fields
language plpgsql
security invoker
set search_path = public, extensions, pg_temp
as $$
declare
  g      geometry := public.geom_from_input(p_geometry);
  v_id   uuid;
  v_src  text := coalesce(p_source, 'drawn');
  v_kaek text := nullif(btrim(coalesce(p_kaek, '')), '');
begin
  if g is null or geometrytype(g) <> 'POLYGON' then
    raise exception 'Shape could not be read' using errcode = 'FS008';
  end if;
  if v_src = 'drawn' then
    v_kaek := null;          -- a hand-drawn field has no parcel code
  end if;
  insert into public.fields (name, geom, irrigation, boundary_source, kaek)
  values (p_name, g, coalesce(p_irrigation, 'rainfed'), v_src, v_kaek)
  returning id into v_id;
  return query select * from public.my_fields where id = v_id;
end;
$$;

revoke execute on function public.create_field(text, jsonb, text, text, text) from public, anon;
grant execute on function public.create_field(text, jsonb, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Verification (run manually):
--   select boundary_source, count(*) from public.fields group by 1;
--   select proname, pg_get_function_identity_arguments(oid)
--   from pg_proc where proname = 'create_field';
--     -> exactly one row: p_name text, p_geometry jsonb, p_irrigation text, p_source text, p_kaek text
-- ---------------------------------------------------------------------------