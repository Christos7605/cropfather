-- 20261101_season_periods_fertilizers.sql
-- Field Shift: crop seasons as date periods, and the fertilisers used in each season.
--
--   crop_history              + sown_on, harvested_on: the season is the period the crop was in the
--                               field (harvested_on empty: still in the field). Periods of the same
--                               field can never overlap (exclusion constraint). season_year stays,
--                               kept in step by the trigger (year of harvest, else year of sowing),
--                               so everything that reads it keeps working. Several seasons per year
--                               are now possible (e.g. barley, then summer maize).
--   crops                     + sowing_month, harvest_month: the usual calendar of each crop, used
--                               to suggest dates.
--   fertilizer_products       reference list of fertilisers and their analysis (N-P2O5-K2O, SO3,
--                               CaO, MgO), readable by everyone, written with the service role.
--   fertilizer_applications   per season: product, analysis copied at the time, rate, price,
--                               method, date. Own rows only, through the season's field.
--   save_season(...)          saves a season and its fertilisers in one transaction.
--
-- Run after 20261031_policy_schema.sql (and its seed). Idempotent: safe to run more than once.
-- Existing seasons keep their year and get no dates; the app asks the farmer to add them.

begin;

-- btree_gist lets one exclusion constraint compare a uuid (=) and a date range (&&)
create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Season periods on crop_history
-- ---------------------------------------------------------------------------
alter table public.crop_history add column if not exists sown_on      date;
alter table public.crop_history add column if not exists harvested_on date;

do $$
begin
  -- Sowing first, harvest strictly after it, at most 6 years (perennials such as alfalfa)
  if not exists (select 1 from pg_constraint where conname = 'crop_history_period_check') then
    alter table public.crop_history add constraint crop_history_period_check check (
      (sown_on is null and harvested_on is null)
      or (
        sown_on is not null
        and sown_on >= date '1990-01-01'
        and (harvested_on is null or (harvested_on > sown_on and harvested_on - sown_on <= 2200))
      )
    );
  end if;

  -- No two periods of the same field may overlap. The harvest day is excluded ('[)'), so a crop
  -- can be sown on the day the previous one was harvested. An open season (no harvest yet)
  -- reaches to infinity: nothing can start after it until it gets a harvest date.
  -- Seasons without dates (recorded before this migration) are left out.
  if not exists (select 1 from pg_constraint where conname = 'crop_history_no_overlap') then
    alter table public.crop_history add constraint crop_history_no_overlap
      exclude using gist (field_id with =, daterange(sown_on, harvested_on, '[)') with &&)
      where (sown_on is not null);
  end if;

  -- One crop per field and year no longer holds (double cropping): periods replace it
  if exists (select 1 from pg_constraint where conname = 'crop_history_field_year_key') then
    alter table public.crop_history drop constraint crop_history_field_year_key;
  end if;
end $$;

create index if not exists crop_history_field_sown_idx on public.crop_history (field_id, sown_on);

-- season_year follows the dates: year of harvest, or of sowing while the crop is still in the field
create or replace function public.crop_history_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
  end if;
  new.notes := nullif(btrim(new.notes), '');
  if new.sown_on is not null then
    new.season_year := extract(year from coalesce(new.harvested_on, new.sown_on))::int;
  end if;
  return new;
end;
$$;

revoke execute on function public.crop_history_touch() from public, anon, authenticated;
-- (the trigger crop_history_touch from 20261030_questionnaire_levels.sql already calls this function)

-- ---------------------------------------------------------------------------
-- 2. Usual calendar of each crop (month 1-12), to suggest dates
-- ---------------------------------------------------------------------------
-- Indicative for Greek lowland and coastal fields; varies with variety, area and sowing date.
-- Only filled where empty, so values changed by hand are kept on a rerun. Not in crops.csv:
-- the policy seed updates only its own columns, so it leaves these alone.
alter table public.crops add column if not exists sowing_month  smallint;
alter table public.crops add column if not exists harvest_month smallint;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crops_months_check') then
    alter table public.crops add constraint crops_months_check check (
      (sowing_month is null or sowing_month between 1 and 12)
      and (harvest_month is null or harvest_month between 1 and 12)
    );
  end if;
end $$;

update public.crops c
set sowing_month = v.sow, harvest_month = v.harvest
from (values
  ('wheat_durum', 11, 6),
  ('wheat_soft',  10, 6),
  ('barley',      11, 6),
  ('oat',         11, 6),
  ('maize',        4, 9),
  ('cotton',       4, 10),
  ('rice',         5, 10),
  ('sunflower',    4, 9),
  ('vetch',       11, 6),
  ('faba_bean',   11, 6),
  ('lentil',      12, 6),
  ('chickpea',     2, 7),
  ('vetch_oat',   11, 5)
) as v(id, sow, harvest)
where c.id = v.id and c.sowing_month is null and c.harvest_month is null;
-- alfalfa (perennial, several cuts a year), fallow and other: no usual calendar

-- ---------------------------------------------------------------------------
-- 3. Fertiliser products (reference data)
-- ---------------------------------------------------------------------------
-- Analysis as printed on the bag: N - P2O5 - K2O, plus SO3, CaO, MgO, in % by weight.
-- brand: manufacturer or trade name (empty for common products such as urea).
create table if not exists public.fertilizer_products (
  id         bigint generated always as identity primary key,
  name       text not null unique check (char_length(name) between 1 and 120),
  brand      text,
  form       text not null default 'granular' check (form in ('granular', 'liquid', 'soluble', 'other')),
  n_pct      numeric check (n_pct    between 0 and 100),
  p2o5_pct   numeric check (p2o5_pct between 0 and 100),
  k2o_pct    numeric check (k2o_pct  between 0 and 100),
  so3_pct    numeric check (so3_pct  between 0 and 100),
  cao_pct    numeric check (cao_pct  between 0 and 100),
  mgo_pct    numeric check (mgo_pct  between 0 and 100),
  micro      text,
  active     boolean not null default true,
  source     text,
  created_at timestamptz not null default now()
);

alter table public.fertilizer_products enable row level security;
drop policy if exists "fertilizer_products_read" on public.fertilizer_products;
create policy "fertilizer_products_read" on public.fertilizer_products for select using (true);

-- ---------------------------------------------------------------------------
-- 4. Fertiliser applications of a season
-- ---------------------------------------------------------------------------
-- The analysis is copied from the product when saved, so a later change to the product list
-- does not rewrite the farmer's history. Products not in the list: product_id empty, the farmer
-- types the name and the analysis.
-- rate_kg_ha: kg per hectare (the app asks per stremma, 0.1 ha, and multiplies by 10).
create table if not exists public.fertilizer_applications (
  id           bigint generated always as identity primary key,
  season_id    bigint not null references public.crop_history (id) on delete cascade,
  product_id   bigint references public.fertilizer_products (id) on delete set null,
  product_name text not null check (char_length(product_name) between 1 and 120),
  n_pct        numeric check (n_pct    between 0 and 100),
  p2o5_pct     numeric check (p2o5_pct between 0 and 100),
  k2o_pct      numeric check (k2o_pct  between 0 and 100),
  so3_pct      numeric check (so3_pct  between 0 and 100),
  cao_pct      numeric check (cao_pct  between 0 and 100),
  mgo_pct      numeric check (mgo_pct  between 0 and 100),
  rate_kg_ha   numeric check (rate_kg_ha > 0 and rate_kg_ha <= 5000),
  price_eur_kg numeric check (price_eur_kg >= 0 and price_eur_kg <= 100),
  method       text check (method in ('basal', 'topdress', 'fertigation', 'foliar')),
  applied_on   date,
  position     smallint not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists fertilizer_applications_season_idx on public.fertilizer_applications (season_id);
create index if not exists fertilizer_applications_product_idx on public.fertilizer_applications (product_id);

alter table public.fertilizer_applications enable row level security;
drop policy if exists "fertilizer_applications_own" on public.fertilizer_applications;
create policy "fertilizer_applications_own" on public.fertilizer_applications
  for all to authenticated
  using (exists (
    select 1 from public.crop_history h
    join public.fields f on f.id = h.field_id
    where h.id = fertilizer_applications.season_id and f.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.crop_history h
    join public.fields f on f.id = h.field_id
    where h.id = fertilizer_applications.season_id and f.user_id = (select auth.uid())
  ));
revoke all on public.fertilizer_applications from anon;

-- ---------------------------------------------------------------------------
-- 5. save_season: one season and its fertilisers, in one transaction
-- ---------------------------------------------------------------------------
-- p_season: { crop_id, sown_on, harvested_on, tillage, residues, nitrogen, irrigation,
--             yield_outcome, notes }   (harvested_on null: still in the field)
-- p_applications: [ { product_id, product_name, n_pct, p2o5_pct, k2o_pct, so3_pct, cao_pct,
--                     mgo_pct, rate_kg_ha, price_eur_kg, method, applied_on } ]
-- p_id: the season to update, or null for a new one. Returns the season id.
-- Runs with the caller's rights (security invoker), so RLS decides what may be written.
-- Errors: 23P01 the period overlaps another season of the field; 22023 missing sowing date;
-- P0002 season not found; 23514 a value out of range.
create or replace function public.save_season(
  p_field_id     uuid,
  p_season       jsonb,
  p_applications jsonb default '[]'::jsonb,
  p_id           bigint default null
)
returns bigint
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_id bigint;
begin
  if nullif(p_season ->> 'sown_on', '') is null then
    raise exception 'The sowing date is required' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.crop_history (
      field_id, crop_id, sown_on, harvested_on,
      tillage, residues, nitrogen, irrigation, yield_outcome, notes, source
    )
    values (
      p_field_id,
      p_season ->> 'crop_id',
      (p_season ->> 'sown_on')::date,
      nullif(p_season ->> 'harvested_on', '')::date,
      nullif(p_season ->> 'tillage', ''),
      nullif(p_season ->> 'residues', ''),
      nullif(p_season ->> 'nitrogen', ''),
      nullif(p_season ->> 'irrigation', ''),
      nullif(p_season ->> 'yield_outcome', ''),
      left(nullif(btrim(p_season ->> 'notes'), ''), 500),
      'farmer'
    )
    returning id into v_id;
  else
    update public.crop_history set
      crop_id       = p_season ->> 'crop_id',
      sown_on       = (p_season ->> 'sown_on')::date,
      harvested_on  = nullif(p_season ->> 'harvested_on', '')::date,
      tillage       = nullif(p_season ->> 'tillage', ''),
      residues      = nullif(p_season ->> 'residues', ''),
      nitrogen      = nullif(p_season ->> 'nitrogen', ''),
      irrigation    = nullif(p_season ->> 'irrigation', ''),
      yield_outcome = nullif(p_season ->> 'yield_outcome', ''),
      notes         = left(nullif(btrim(p_season ->> 'notes'), ''), 500)
    where id = p_id and field_id = p_field_id
    returning id into v_id;
    if v_id is null then
      raise exception 'Season not found' using errcode = 'P0002';
    end if;
  end if;

  -- The fertilisers of the season are replaced as a whole
  delete from public.fertilizer_applications where season_id = v_id;

  insert into public.fertilizer_applications (
    season_id, product_id, product_name,
    n_pct, p2o5_pct, k2o_pct, so3_pct, cao_pct, mgo_pct,
    rate_kg_ha, price_eur_kg, method, applied_on, position
  )
  select
    v_id,
    p.id,
    -- A listed product: its name and analysis come from the list, not from the request
    coalesce(p.name, left(btrim(a.x ->> 'product_name'), 120)),
    case when p.id is not null then p.n_pct    else nullif(a.x ->> 'n_pct', '')::numeric    end,
    case when p.id is not null then p.p2o5_pct else nullif(a.x ->> 'p2o5_pct', '')::numeric end,
    case when p.id is not null then p.k2o_pct  else nullif(a.x ->> 'k2o_pct', '')::numeric  end,
    case when p.id is not null then p.so3_pct  else nullif(a.x ->> 'so3_pct', '')::numeric  end,
    case when p.id is not null then p.cao_pct  else nullif(a.x ->> 'cao_pct', '')::numeric  end,
    case when p.id is not null then p.mgo_pct  else nullif(a.x ->> 'mgo_pct', '')::numeric  end,
    nullif(a.x ->> 'rate_kg_ha', '')::numeric,
    nullif(a.x ->> 'price_eur_kg', '')::numeric,
    nullif(a.x ->> 'method', ''),
    nullif(a.x ->> 'applied_on', '')::date,
    (a.ord - 1)::smallint
  from jsonb_array_elements(coalesce(p_applications, '[]'::jsonb)) with ordinality as a(x, ord)
  left join public.fertilizer_products p on p.id = nullif(a.x ->> 'product_id', '')::bigint;

  return v_id;
end;
$$;

revoke execute on function public.save_season(uuid, jsonb, jsonb, bigint) from public, anon;
grant execute on function public.save_season(uuid, jsonb, jsonb, bigint) to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- Verification (run manually):
--   -- new columns and constraints
--   select conname from pg_constraint
--   where conname in ('crop_history_period_check', 'crop_history_no_overlap', 'crops_months_check');
--   -- expect 3 rows; crop_history_field_year_key must be gone:
--   select count(*) from pg_constraint where conname = 'crop_history_field_year_key';   -- 0
--
--   -- crops with a usual calendar (expect 13)
--   select id, sowing_month, harvest_month from public.crops where sowing_month is not null order by id;
--
--   -- seasons still without dates (recorded before this migration)
--   select h.id, f.name, h.season_year, h.crop_id from public.crop_history h
--   join public.fields f on f.id = h.field_id where h.sown_on is null;
-- ---------------------------------------------------------------------------