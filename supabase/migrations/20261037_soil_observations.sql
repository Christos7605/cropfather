-- 20261037_soil_observations.sql
-- Field Shift: soil salinity measurements reported by farmers (ground truth for the salinity model).
--
--   soil_observations   one row per measurement: the point, when and how deep it was sampled,
--                       the method, the value with its unit as the farmer gave it, a free-text
--                       observation, and the model's prediction for that point at the time it was
--                       reported. Own rows only.
--                       site_id groups repeated measurements of the same point: a new row gets
--                       a new site unless the app passes an existing site_id of the same farmer
--                       (e.g. after offering the nearest site within ~20 m). Rows are never
--                       overwritten, so the full history of a site stays available.
--   soil_observations_latest   (view) one row per site: its most recent measurement
--                       (latest sampled_at, then latest created_at). The label used for training.
--
-- History of a site:  select * from public.soil_observations where site_id = ... order by sampled_at;
--
-- How the rows are used (backend/experiments):
--   retraining   read soil_observations_latest rows with training_consent, convert value/unit/method to log(EC1:5, dS/m)
--                (the model target), extract the predictors at (lon, lat, sampled_at) and train.
--   evaluation   compare predicted_ec15_dsm with the measured value. The prediction is written by
--                the backend right after the row is inserted, by the model version then in use,
--                so it never saw this measurement: every row is an out-of-sample test.
--
-- Units: the value is stored exactly as reported; conversion happens in the training code, so it
-- can change without touching the data. Accepted units are those of electrical conductivity.
-- A visual observation (salt crust, leaf burn...) has no value: observation is required instead.
--
-- Run after 20261036_season_irrigation.sql. Idempotent: safe to run more than once.

create table if not exists public.soil_observations (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users on delete cascade,
  field_id           uuid references public.fields (id) on delete set null,
  site_id            uuid not null default gen_random_uuid(),   -- same point, repeated visits

  -- where: WGS84; the box around Greece also catches swapped lon/lat
  lon                double precision not null check (lon between 19 and 30),
  lat                double precision not null check (lat between 34 and 42),
  geom               geometry(Point, 4326)
                     generated always as (st_setsrid(st_makepoint(lon, lat), 4326)) stored,

  -- when and how deep
  sampled_at         date not null,
  depth_from_cm      smallint not null default 0,
  depth_to_cm        smallint not null default 20,   -- LUCAS topsoil is 0-20 cm

  -- what was measured
  method             text not null
                     check (method in (
                       'lab_ece',          -- laboratory, saturated paste extract (ECe)
                       'lab_ec15',         -- laboratory, 1:5 soil:water extract (EC1:5, as LUCAS)
                       'lab_ec12',         -- laboratory, 1:2 soil:water extract
                       'portable_meter',   -- field meter in the soil or in a suspension
                       'visual')),         -- no measurement, only what was seen
  value              numeric(10, 3),
  unit               text check (unit in ('dS/m', 'mS/cm', 'uS/cm', 'mS/m')),
  observation        text check (char_length(observation) <= 2000),
  attachment_path    text,                           -- lab report or photo, in Storage

  -- the farmer agrees that this measurement is used to train and test the model
  training_consent   boolean not null default false,

  -- written by the backend only (see the grants below)
  model_version      text,
  predicted_ec15_dsm numeric(10, 3),                 -- model median, EC1:5 in dS/m
  predicted_at       timestamptz,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint soil_observations_depth_check
    check (depth_from_cm >= 0 and depth_to_cm > depth_from_cm and depth_to_cm <= 300),
  constraint soil_observations_value_check
    check (
      (method = 'visual' and value is null and unit is null and observation is not null)
      or (method <> 'visual' and value is not null and value >= 0 and unit is not null)
    ),
  constraint soil_observations_prediction_check
    check ((predicted_ec15_dsm is null) = (model_version is null))
);

create index if not exists soil_observations_geom_idx  on public.soil_observations using gist (geom);
create index if not exists soil_observations_user_idx  on public.soil_observations (user_id);
create index if not exists soil_observations_field_idx on public.soil_observations (field_id);
create index if not exists soil_observations_site_idx
  on public.soil_observations (site_id, sampled_at desc, created_at desc);

-- A site belongs to one farmer: an existing site_id of another user is refused.
-- (security definer: RLS would hide the other user's rows from this check.)
create or replace function public.soil_observations_site_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.soil_observations o
             where o.site_id = new.site_id and o.user_id <> new.user_id) then
    raise exception 'site % belongs to another user', new.site_id using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.soil_observations_site_owner() from public, anon, authenticated;

drop trigger if exists soil_observations_site_owner on public.soil_observations;
create trigger soil_observations_site_owner
  before insert or update of site_id, user_id on public.soil_observations
  for each row execute function public.soil_observations_site_owner();

-- updated_at on every change
create or replace function public.soil_observations_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.soil_observations_touch() from public, anon, authenticated;

drop trigger if exists soil_observations_touch on public.soil_observations;
create trigger soil_observations_touch
  before update on public.soil_observations
  for each row execute function public.soil_observations_touch();

-- ---------------------------------------------------------------------------
-- Access: each farmer sees and edits only their own rows; a linked field must be theirs too.
-- The prediction columns are not granted to the app: only the service role (backend) writes them.
-- ---------------------------------------------------------------------------
alter table public.soil_observations enable row level security;

drop policy if exists "soil_observations_own" on public.soil_observations;
create policy "soil_observations_own" on public.soil_observations
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (
      field_id is null
      or exists (select 1 from public.fields f
                 where f.id = soil_observations.field_id and f.user_id = (select auth.uid()))
    )
  );

revoke all on public.soil_observations from anon, authenticated;
grant select, delete on public.soil_observations to authenticated;
grant insert (field_id, site_id, lon, lat, sampled_at, depth_from_cm, depth_to_cm, method, value,
              unit, observation, attachment_path, training_consent)
  on public.soil_observations to authenticated;
grant update (field_id, site_id, lon, lat, sampled_at, depth_from_cm, depth_to_cm, method, value,
              unit, observation, attachment_path, training_consent)
  on public.soil_observations to authenticated;

-- ---------------------------------------------------------------------------
-- Latest measurement of each site (the training label). security_invoker: the app sees
-- only its own sites through RLS; the backend (service role) sees all of them.
-- ---------------------------------------------------------------------------
create or replace view public.soil_observations_latest
with (security_invoker = true)
as
select distinct on (o.site_id) o.*
from public.soil_observations o
order by o.site_id, o.sampled_at desc, o.created_at desc;

revoke all on public.soil_observations_latest from public, anon;
grant select on public.soil_observations_latest to authenticated;

-- ---------------------------------------------------------------------------
-- Verification (run manually):
--   select count(*) from public.soil_observations;                          -- 0 on a new database
--   select relrowsecurity from pg_class where relname = 'soil_observations'; -- true
--   select count(*) = count(distinct site_id) from public.soil_observations_latest; -- true
-- ---------------------------------------------------------------------------
