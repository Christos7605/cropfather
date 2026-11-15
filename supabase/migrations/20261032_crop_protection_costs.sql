-- 20261102_crop_protection_costs.sql
-- Field Shift: nitrogen forms of fertilisers, plant protection per season, and the cost views.
--
--   fertilizer_products,      + n_nh4_pct, n_no3_pct, n_urea_pct: the forms of the total nitrogen
--   fertilizer_applications     (ammoniacal, nitrate, ureic), as printed on the bag. They are parts
--                               of n_pct, never more than it.
--   protection_products       reference list of plant protection products (herbicides,
--                               fungicides, insecticides...), readable by everyone, written with the
--                               service role.
--   protection_applications   per season: product, type, formulation, active substances copied at
--                               the time, what it was for, dose, price, method, date, and whether a
--                               contractor did the work (and the fee). Own rows only.
--   save_season(...)          now also takes the plant protection treatments (p_protections).
--   season_cost_lines (view)  every cost of every season, one row per item, per hectare.
--   season_finance (view)     one row per season: what was grown, when, and what it cost.
--   field_finance (view)      one row per field: the totals and averages over its seasons.
--
-- Run after 20261101_season_periods_fertilizers.sql and data/fertilizers/seed.sql.
-- Then run data/fertilizers/seed.sql again (it now fills the nitrogen forms) and
-- data/crop_protection/seed.sql.
-- Runs in one transaction. Idempotent: safe to run more than once.

begin;

-- ---------------------------------------------------------------------------
-- 1. Nitrogen forms of fertilisers
-- ---------------------------------------------------------------------------
-- Total N = ammoniacal (NH4) + nitrate (NO3) + ureic (urea) N. A bag shows the total and, below
-- it, the forms. Empty = not known. The forms may add up to slightly more than the total
-- (0.2 points) because labels round each figure.
alter table public.fertilizer_products     add column if not exists n_nh4_pct  numeric;
alter table public.fertilizer_products     add column if not exists n_no3_pct  numeric;
alter table public.fertilizer_products     add column if not exists n_urea_pct numeric;
alter table public.fertilizer_applications add column if not exists n_nh4_pct  numeric;
alter table public.fertilizer_applications add column if not exists n_no3_pct  numeric;
alter table public.fertilizer_applications add column if not exists n_urea_pct numeric;

do $$
declare
  t text;
begin
  foreach t in array array['fertilizer_products', 'fertilizer_applications'] loop
    if not exists (select 1 from pg_constraint where conname = t || '_n_forms_check') then
      execute format(
        'alter table public.%I add constraint %I check (
              (n_nh4_pct  is null or n_nh4_pct  between 0 and 100)
          and (n_no3_pct  is null or n_no3_pct  between 0 and 100)
          and (n_urea_pct is null or n_urea_pct between 0 and 100)
          and coalesce(n_nh4_pct, 0) + coalesce(n_no3_pct, 0) + coalesce(n_urea_pct, 0)
              <= coalesce(n_pct, 0) + 0.2
        )',
        t, t || '_n_forms_check'
      );
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Plant protection products (reference data)
-- ---------------------------------------------------------------------------
-- product_type      herbicide, fungicide, insecticide, acaricide, molluscicide (slugs and
--                   snails), nematicide, growth_regulator, other
-- formulation       international code printed after the name, e.g. EC in "Decis 2.5 EC"
--                   liquids: EC EW ME SC SE CS OD SL DC FS     solids: WG WP SG SP GR GB
-- unit              'l' for liquids, 'kg' for solids: doses and prices are per litre or per kg
-- active_substances as on the label, e.g. 'glyphosate 360 g/l'
-- authorisation_no  Greek authorisation number (αριθμός άδειας κυκλοφορίας), when known
-- Products are never deleted (seasons point to them): to retire one, set active = false.
create table if not exists public.protection_products (
  id                bigint generated always as identity primary key,
  name              text not null unique check (char_length(name) between 1 and 120),
  brand             text check (brand is null or char_length(brand) <= 120),
  product_type      text not null check (product_type in (
                      'herbicide', 'fungicide', 'insecticide', 'acaricide', 'molluscicide',
                      'nematicide', 'growth_regulator', 'other')),
  formulation       text check (formulation is null or formulation in (
                      'EC', 'EW', 'ME', 'SC', 'SE', 'CS', 'OD', 'SL', 'DC', 'FS',
                      'WG', 'WP', 'SG', 'SP', 'GR', 'GB', 'other')),
  unit              text not null check (unit in ('l', 'kg')),
  active_substances text check (active_substances is null or char_length(active_substances) <= 300),
  authorisation_no  text check (authorisation_no is null or char_length(authorisation_no) <= 40),
  active            boolean not null default true,
  source            text,
  created_at        timestamptz not null default now()
);

alter table public.protection_products enable row level security;
drop policy if exists "protection_products_read" on public.protection_products;
create policy "protection_products_read" on public.protection_products for select using (true);

-- ---------------------------------------------------------------------------
-- 3. Plant protection treatments of a season
-- ---------------------------------------------------------------------------
-- Product details are copied from the product when saved, like the fertiliser analysis, so a
-- later change to the list does not rewrite the farmer's history. Products not in the list:
-- product_id empty, the farmer types the name and chooses the type and formulation.
-- target              what the treatment was for (weeds, a disease, a pest), as the farmer says it
-- dose_per_ha         litres or kg of product per hectare (the app asks ml or g per stremma)
-- price_eur_unit      € per litre or per kg of product
-- contractor          true when a contractor or hired worker did the work
-- contractor_eur_ha   what that work cost per hectare (only with contractor)
create table if not exists public.protection_applications (
  id                bigint generated always as identity primary key,
  season_id         bigint not null references public.crop_history (id) on delete cascade,
  product_id        bigint references public.protection_products (id) on delete set null,
  product_name      text not null check (char_length(product_name) between 1 and 120),
  product_type      text not null check (product_type in (
                      'herbicide', 'fungicide', 'insecticide', 'acaricide', 'molluscicide',
                      'nematicide', 'growth_regulator', 'other')),
  formulation       text check (formulation is null or formulation in (
                      'EC', 'EW', 'ME', 'SC', 'SE', 'CS', 'OD', 'SL', 'DC', 'FS',
                      'WG', 'WP', 'SG', 'SP', 'GR', 'GB', 'other')),
  unit              text not null check (unit in ('l', 'kg')),
  active_substances text check (active_substances is null or char_length(active_substances) <= 300),
  target            text check (target is null or char_length(target) <= 120),
  dose_per_ha       numeric check (dose_per_ha > 0 and dose_per_ha <= 200),
  price_eur_unit    numeric check (price_eur_unit >= 0 and price_eur_unit <= 2000),
  method            text check (method in ('sprayer', 'knapsack', 'spreader', 'seed', 'other')),
  applied_on        date,
  contractor        boolean not null default false,
  contractor_eur_ha numeric check (contractor_eur_ha >= 0 and contractor_eur_ha <= 1000),
  position          smallint not null default 0,
  created_at        timestamptz not null default now(),
  constraint protection_applications_fee_check check (contractor or contractor_eur_ha is null)
);

create index if not exists protection_applications_season_idx on public.protection_applications (season_id);
create index if not exists protection_applications_product_idx on public.protection_applications (product_id);

alter table public.protection_applications enable row level security;
drop policy if exists "protection_applications_own" on public.protection_applications;
create policy "protection_applications_own" on public.protection_applications
  for all to authenticated
  using (exists (
    select 1 from public.crop_history h
    join public.fields f on f.id = h.field_id
    where h.id = protection_applications.season_id and f.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.crop_history h
    join public.fields f on f.id = h.field_id
    where h.id = protection_applications.season_id and f.user_id = (select auth.uid())
  ));
revoke all on public.protection_applications from anon;

-- ---------------------------------------------------------------------------
-- 4. save_season: the season, its fertilisers and its plant protection, in one transaction
-- ---------------------------------------------------------------------------
-- p_season, p_applications, p_id: as before (see 20261101); applications may now also carry
--   n_nh4_pct, n_no3_pct, n_urea_pct.
-- p_protections: [ { product_id, product_name, product_type, formulation, unit,
--                    active_substances, target, dose_per_ha, price_eur_unit, method,
--                    applied_on, contractor, contractor_eur_ha } ]
--   null (the default) leaves the season's treatments as they are, so a call without it, from
--   a browser that still has the previous version of the app, never deletes them.
-- The previous 4-argument version is dropped so the API never has two to choose between.
drop function if exists public.save_season(uuid, jsonb, jsonb, bigint);

create or replace function public.save_season(
  p_field_id     uuid,
  p_season       jsonb,
  p_applications jsonb default '[]'::jsonb,
  p_id           bigint default null,
  p_protections  jsonb default null
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

  -- Fertilisers: replaced as a whole
  delete from public.fertilizer_applications where season_id = v_id;

  insert into public.fertilizer_applications (
    season_id, product_id, product_name,
    n_pct, p2o5_pct, k2o_pct, so3_pct, cao_pct, mgo_pct,
    n_nh4_pct, n_no3_pct, n_urea_pct,
    rate_kg_ha, price_eur_kg, method, applied_on, position
  )
  select
    v_id,
    p.id,
    -- A listed product: its name and analysis come from the list, not from the request
    coalesce(p.name, left(btrim(a.x ->> 'product_name'), 120)),
    case when p.id is not null then p.n_pct      else nullif(a.x ->> 'n_pct', '')::numeric      end,
    case when p.id is not null then p.p2o5_pct   else nullif(a.x ->> 'p2o5_pct', '')::numeric   end,
    case when p.id is not null then p.k2o_pct    else nullif(a.x ->> 'k2o_pct', '')::numeric    end,
    case when p.id is not null then p.so3_pct    else nullif(a.x ->> 'so3_pct', '')::numeric    end,
    case when p.id is not null then p.cao_pct    else nullif(a.x ->> 'cao_pct', '')::numeric    end,
    case when p.id is not null then p.mgo_pct    else nullif(a.x ->> 'mgo_pct', '')::numeric    end,
    case when p.id is not null then p.n_nh4_pct  else nullif(a.x ->> 'n_nh4_pct', '')::numeric  end,
    case when p.id is not null then p.n_no3_pct  else nullif(a.x ->> 'n_no3_pct', '')::numeric  end,
    case when p.id is not null then p.n_urea_pct else nullif(a.x ->> 'n_urea_pct', '')::numeric end,
    nullif(a.x ->> 'rate_kg_ha', '')::numeric,
    nullif(a.x ->> 'price_eur_kg', '')::numeric,
    nullif(a.x ->> 'method', ''),
    nullif(a.x ->> 'applied_on', '')::date,
    (a.ord - 1)::smallint
  from jsonb_array_elements(coalesce(p_applications, '[]'::jsonb)) with ordinality as a(x, ord)
  left join public.fertilizer_products p on p.id = nullif(a.x ->> 'product_id', '')::bigint;

  -- Plant protection: replaced as a whole, only when the caller sends it
  if p_protections is not null then
    delete from public.protection_applications where season_id = v_id;

    insert into public.protection_applications (
      season_id, product_id, product_name, product_type, formulation, unit, active_substances,
      target, dose_per_ha, price_eur_unit, method, applied_on, contractor, contractor_eur_ha,
      position
    )
    select
      v_id,
      p.id,
      -- A listed product: its details come from the list, not from the request
      coalesce(p.name, left(btrim(a.x ->> 'product_name'), 120)),
      case when p.id is not null then p.product_type else nullif(a.x ->> 'product_type', '') end,
      case when p.id is not null then p.formulation  else nullif(a.x ->> 'formulation', '')  end,
      case when p.id is not null then p.unit         else nullif(a.x ->> 'unit', '')         end,
      case when p.id is not null then p.active_substances
           else left(nullif(btrim(a.x ->> 'active_substances'), ''), 300) end,
      left(nullif(btrim(a.x ->> 'target'), ''), 120),
      nullif(a.x ->> 'dose_per_ha', '')::numeric,
      nullif(a.x ->> 'price_eur_unit', '')::numeric,
      nullif(a.x ->> 'method', ''),
      nullif(a.x ->> 'applied_on', '')::date,
      coalesce((a.x ->> 'contractor')::boolean, false),
      case when coalesce((a.x ->> 'contractor')::boolean, false)
           then nullif(a.x ->> 'contractor_eur_ha', '')::numeric end,
      (a.ord - 1)::smallint
    from jsonb_array_elements(p_protections) with ordinality as a(x, ord)
    left join public.protection_products p on p.id = nullif(a.x ->> 'product_id', '')::bigint;
  end if;

  return v_id;
end;
$$;

revoke execute on function public.save_season(uuid, jsonb, jsonb, bigint, jsonb) from public, anon;
grant execute on function public.save_season(uuid, jsonb, jsonb, bigint, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Cost views
-- ---------------------------------------------------------------------------
-- All three read the tables with the rights of the caller (security_invoker), so a farmer sees
-- only their own fields; the service role (the model, the pipeline) sees everyone's.
-- Amounts are in € per hectare, like the subsidies in subsidy_details and the revenue in crops
-- (yield_kg_ha * price_eur_kg), so they add up directly. Per stremma = per hectare / 10.
-- A cost whose price the farmer did not give has cost_eur_ha empty and is counted as unpriced:
-- check cost_complete before trusting a total.
--
-- To add a new kind of cost later (seed, ploughing, harvest, irrigation energy, rent...):
--   1. store it in its own table, per season and per hectare, like the two above
--   2. add a "union all" branch to season_cost_lines with a new category
--   3. add a "<category>_eur_ha" column to season_finance (and field_finance) with a filter
-- total_cost_eur_ha and the counts already include every category.

-- One row per cost item of a season
--   category       fertilizer        a fertiliser: rate x price
--                  crop_protection   a plant protection product: dose x price
--                  contract_work     the fee of a contractor or hired worker
--   quantity_ha    amount per hectare, in unit (kg, l); empty for contract work
--   unit_price_eur € per unit
--   cost_eur_ha    € per hectare; empty when the price is not known
create or replace view public.season_cost_lines
with (security_invoker = true)
as
select h.id as season_id, h.field_id, 'fertilizer'::text as category,
       a.id as line_id, a.product_name as item, a.applied_on,
       a.rate_kg_ha as quantity_ha, 'kg'::text as unit, a.price_eur_kg as unit_price_eur,
       round(a.rate_kg_ha * a.price_eur_kg, 2) as cost_eur_ha
from public.fertilizer_applications a
join public.crop_history h on h.id = a.season_id
union all
select h.id, h.field_id, 'crop_protection',
       p.id, p.product_name, p.applied_on,
       p.dose_per_ha, p.unit, p.price_eur_unit,
       round(p.dose_per_ha * p.price_eur_unit, 2)
from public.protection_applications p
join public.crop_history h on h.id = p.season_id
union all
select h.id, h.field_id, 'contract_work',
       p.id, p.product_name, p.applied_on,
       null, null, null,
       round(p.contractor_eur_ha, 2)
from public.protection_applications p
join public.crop_history h on h.id = p.season_id
where p.contractor;

-- One row per season
--   ongoing                  sown, not harvested yet
--   *_eur_ha                 cost per hectare by category; empty when nothing of that category
--                            is recorded (or none of it has a price)
--   total_cost_eur_*         every priced cost of the season, per hectare, per stremma, and for
--                            the whole field (at the field's current area)
--   cost_lines, unpriced_lines, cost_complete
--                            cost_complete: at least one cost recorded and all of them priced
--   n_kg_ha ... mgo_kg_ha    nutrients applied with fertilisers, kg per hectare
--   herbicide_count ...      plant protection treatments by type
--   ref_*                    the crop's average yield and producer price for the coastal zone
--                            (crops table, from the policy data): a reference, not this field's
--                            harvest
create or replace view public.season_finance
with (security_invoker = true)
as
with costs as (
  select season_id,
         sum(cost_eur_ha) filter (where category = 'fertilizer')      as fertilizer_eur_ha,
         sum(cost_eur_ha) filter (where category = 'crop_protection') as crop_protection_eur_ha,
         sum(cost_eur_ha) filter (where category = 'contract_work')   as contract_work_eur_ha,
         sum(cost_eur_ha)                                             as total_cost_eur_ha,
         count(*)::int                                                as cost_lines,
         (count(*) filter (where cost_eur_ha is null))::int           as unpriced_lines
  from public.season_cost_lines
  group by season_id
),
nutrients as (
  select season_id,
         round(sum(rate_kg_ha * n_pct    / 100), 2) as n_kg_ha,
         round(sum(rate_kg_ha * p2o5_pct / 100), 2) as p2o5_kg_ha,
         round(sum(rate_kg_ha * k2o_pct  / 100), 2) as k2o_kg_ha,
         round(sum(rate_kg_ha * so3_pct  / 100), 2) as so3_kg_ha,
         round(sum(rate_kg_ha * cao_pct  / 100), 2) as cao_kg_ha,
         round(sum(rate_kg_ha * mgo_pct  / 100), 2) as mgo_kg_ha,
         count(*)::int                              as fertilizer_count
  from public.fertilizer_applications
  group by season_id
),
treatments as (
  select season_id,
         count(*)::int                                                      as protection_count,
         (count(*) filter (where product_type = 'herbicide'))::int          as herbicide_count,
         (count(*) filter (where product_type = 'fungicide'))::int          as fungicide_count,
         (count(*) filter (where product_type in ('insecticide', 'acaricide')))::int as insecticide_count,
         (count(*) filter (where contractor))::int                          as contractor_count
  from public.protection_applications
  group by season_id
)
select
  h.id                                   as season_id,
  h.field_id,
  f.name                                 as field_name,
  f.area_ha,
  h.crop_id,
  c.name_en                              as crop_name_en,
  c.name_el                              as crop_name_el,
  h.season_year,
  h.sown_on,
  h.harvested_on,
  (h.sown_on is not null and h.harvested_on is null)         as ongoing,
  (h.harvested_on - h.sown_on)                               as season_days,
  co.fertilizer_eur_ha,
  co.crop_protection_eur_ha,
  co.contract_work_eur_ha,
  co.total_cost_eur_ha,
  round(co.total_cost_eur_ha / 10, 2)                        as total_cost_eur_stremma,
  round(co.total_cost_eur_ha * f.area_ha, 2)                 as total_cost_eur_field,
  coalesce(co.cost_lines, 0)                                 as cost_lines,
  coalesce(co.unpriced_lines, 0)                             as unpriced_lines,
  (coalesce(co.cost_lines, 0) > 0 and coalesce(co.unpriced_lines, 0) = 0) as cost_complete,
  nu.n_kg_ha,
  nu.p2o5_kg_ha,
  nu.k2o_kg_ha,
  nu.so3_kg_ha,
  nu.cao_kg_ha,
  nu.mgo_kg_ha,
  coalesce(nu.fertilizer_count, 0)                           as fertilizer_count,
  coalesce(tr.protection_count, 0)                           as protection_count,
  coalesce(tr.herbicide_count, 0)                            as herbicide_count,
  coalesce(tr.fungicide_count, 0)                            as fungicide_count,
  coalesce(tr.insecticide_count, 0)                          as insecticide_count,
  coalesce(tr.contractor_count, 0)                           as contractor_count,
  h.yield_outcome,
  h.irrigation                                               as irrigation_level,
  c.yield_kg_ha                                              as ref_yield_kg_ha,
  c.price_eur_kg                                             as ref_price_eur_kg,
  c.price_kind                                               as ref_price_kind,
  round(c.yield_kg_ha * c.price_eur_kg, 2)                   as ref_revenue_eur_ha
from public.crop_history h
join public.fields f      on f.id = h.field_id
left join public.crops c  on c.id = h.crop_id
left join costs co        on co.season_id = h.id
left join nutrients nu    on nu.season_id = h.id
left join treatments tr   on tr.season_id = h.id;

-- One row per field, over all its seasons
--   seasons_with_costs       seasons that have at least one priced cost
--   total_cost_eur_field     every priced cost of every season, for the whole field
--   avg_*_eur_ha             average per season over the seasons with costs
--   last_*                   the most recent season (by sowing date, else year)
create or replace view public.field_finance
with (security_invoker = true)
as
with per_field as (
  select field_id,
         count(*)::int                                                      as seasons,
         (count(*) filter (where total_cost_eur_ha is not null))::int       as seasons_with_costs,
         min(sown_on)                                                       as first_sown_on,
         max(harvested_on)                                                  as last_harvested_on,
         round(sum(total_cost_eur_field), 2)                                as total_cost_eur_field,
         round(avg(total_cost_eur_ha), 2)                                   as avg_cost_eur_ha,
         round(avg(total_cost_eur_ha) / 10, 2)                              as avg_cost_eur_stremma,
         round(avg(fertilizer_eur_ha), 2)                                   as avg_fertilizer_eur_ha,
         round(avg(crop_protection_eur_ha), 2)                              as avg_crop_protection_eur_ha,
         round(avg(contract_work_eur_ha), 2)                                as avg_contract_work_eur_ha,
         sum(unpriced_lines)::int                                           as unpriced_lines,
         bool_and(cost_complete) filter (where cost_lines > 0)              as cost_complete
  from public.season_finance
  group by field_id
)
select
  f.id                         as field_id,
  f.name                       as field_name,
  f.area_ha,
  f.irrigation,
  coalesce(pf.seasons, 0)      as seasons,
  coalesce(pf.seasons_with_costs, 0) as seasons_with_costs,
  pf.first_sown_on,
  pf.last_harvested_on,
  pf.total_cost_eur_field,
  pf.avg_cost_eur_ha,
  pf.avg_cost_eur_stremma,
  pf.avg_fertilizer_eur_ha,
  pf.avg_crop_protection_eur_ha,
  pf.avg_contract_work_eur_ha,
  coalesce(pf.unpriced_lines, 0) as unpriced_lines,
  coalesce(pf.cost_complete, false) as cost_complete,
  ls.season_id                 as last_season_id,
  ls.crop_id                   as last_crop_id,
  ls.sown_on                   as last_sown_on,
  ls.harvested_on              as last_season_harvested_on,
  ls.total_cost_eur_ha         as last_cost_eur_ha
from public.fields f
left join per_field pf on pf.field_id = f.id
left join lateral (
  select s.season_id, s.crop_id, s.sown_on, s.harvested_on, s.total_cost_eur_ha
  from public.season_finance s
  where s.field_id = f.id
  order by coalesce(s.sown_on, make_date(s.season_year, 1, 1)) desc, s.season_id desc
  limit 1
) ls on true;

revoke all on public.season_cost_lines, public.season_finance, public.field_finance from public, anon;
grant select on public.season_cost_lines, public.season_finance, public.field_finance to authenticated;

commit;

-- The API (PostgREST) picks up the new function and views on its own; if it ever does not:
--   notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Verification (run manually):
--   -- exactly one save_season, with 5 arguments
--   select pg_get_function_identity_arguments(oid) from pg_proc where proname = 'save_season';
--     -> p_field_id uuid, p_season jsonb, p_applications jsonb, p_id bigint, p_protections jsonb
--
--   -- the new tables have RLS on (expect 2 rows, rowsecurity = true)
--   select tablename, rowsecurity from pg_tables
--   where schemaname = 'public' and tablename in ('protection_products', 'protection_applications');
--
--   -- after the two seeds: products in the lists
--   select count(*) from public.protection_products;                               -- at least 24
--   select name, n_pct, n_nh4_pct, n_no3_pct, n_urea_pct from public.fertilizer_products
--   where n_nh4_pct is not null or n_no3_pct is not null or n_urea_pct is not null order by name;
--
--   -- costs per season (in the SQL Editor you see every farmer's seasons)
--   select field_name, crop_id, sown_on, harvested_on, fertilizer_eur_ha, crop_protection_eur_ha,
--          contract_work_eur_ha, total_cost_eur_stremma, total_cost_eur_field, cost_complete
--   from public.season_finance order by field_name, sown_on desc nulls last;
--
--   -- totals per field
--   select field_name, seasons, seasons_with_costs, total_cost_eur_field, avg_cost_eur_stremma,
--          cost_complete from public.field_finance order by field_name;
-- ---------------------------------------------------------------------------