-- 20261105_season_seeds.sql
-- Field Shift: the seed of each season (Σπορά), as a cost like fertilisers and plant protection.
--
--   seed_varieties            reference list of varieties per crop (name, breeder), readable by
--                               everyone, written with the service role. Filled from
--                               data/seed_varieties/seed_varieties.csv.
--   seed_applications         per season (one or more: a mixture such as vetch-oat, or a
--                               re-sowing): variety (listed or typed, or unknown), the crop the
--                               seed belongs to, origin (certified, bought uncertified, own seed),
--                               rate, price, sowing method, date, who did the work. Own rows only.
--   save_season(...)          + p_seeds (7th argument); null leaves the seed as it is.
--   season_cost_lines (view)  + category 'seed' (rate x price); the sowing contractor's fee joins
--                               contract_work. Columns unchanged.
--   season_finance (view)     seed cost is part of total_cost_eur_ha and so of the margin;
--                               contractor_count includes sowing; appended at the end: seed_eur_ha,
--                               seed_kg_ha, seed_count, certified_seed. Existing columns unchanged.
--   field_finance (view)      appended: avg_seed_eur_ha.
--
-- certified_seed matters for aid: coupled support asks for certified seed (constraint
-- 'certified_seed' in the policy data).
--
-- Run after the season income migration (20261104_season_income.sql). Runs in one transaction.
-- Idempotent: safe to run more than once. Do not re-run older migrations after it (their view
-- definitions have fewer columns).

begin;

-- ---------------------------------------------------------------------------
-- 1. Seed varieties (reference data)
-- ---------------------------------------------------------------------------
-- A variety belongs to one crop; the same name may exist for two crops. Varieties are never
-- deleted (seasons point to them): to retire one, set active = false.
create table if not exists public.seed_varieties (
  id         bigint generated always as identity primary key,
  crop_id    text not null references public.crops (id) on delete restrict,
  name       text not null check (char_length(name) between 1 and 120),
  breeder    text check (breeder is null or char_length(breeder) <= 120),
  active     boolean not null default true,
  source     text,
  created_at timestamptz not null default now(),
  constraint seed_varieties_crop_name_key unique (crop_id, name)
);

create index if not exists seed_varieties_crop_idx on public.seed_varieties (crop_id);

alter table public.seed_varieties enable row level security;
drop policy if exists "seed_varieties_read" on public.seed_varieties;
create policy "seed_varieties_read" on public.seed_varieties for select using (true);

-- ---------------------------------------------------------------------------
-- 2. Seed of a season
-- ---------------------------------------------------------------------------
-- crop_id            the crop this seed is (for a mixture: vetch or oat); the season's crop by default
-- variety_name       copied from the list for a listed variety; empty = variety not known
-- origin             certified   bought, with the official certification label
--                    uncertified bought without it
--                    own         kept from an earlier harvest (its price: what it would have sold at)
-- rate_kg_ha         kg of seed per hectare (the app asks per stremma)
-- method             drill (seed drill), precision (precision / pneumatic planter),
--                    broadcast (spread, then covered), other
create table if not exists public.seed_applications (
  id                bigint generated always as identity primary key,
  season_id         bigint not null references public.crop_history (id) on delete cascade,
  variety_id        bigint references public.seed_varieties (id) on delete set null,
  crop_id           text references public.crops (id) on delete restrict,
  variety_name      text check (variety_name is null or char_length(variety_name) between 1 and 120),
  origin            text check (origin in ('certified', 'uncertified', 'own')),
  rate_kg_ha        numeric check (rate_kg_ha > 0 and rate_kg_ha <= 600),
  price_eur_kg      numeric check (price_eur_kg >= 0 and price_eur_kg <= 100),
  method            text check (method in ('drill', 'precision', 'broadcast', 'other')),
  sown_on           date,
  contractor        boolean not null default false,
  contractor_eur_ha numeric check (contractor_eur_ha >= 0 and contractor_eur_ha <= 1000),
  position          smallint not null default 0,
  created_at        timestamptz not null default now(),
  constraint seed_applications_fee_check check (contractor or contractor_eur_ha is null)
);

create index if not exists seed_applications_season_idx on public.seed_applications (season_id);
create index if not exists seed_applications_variety_idx on public.seed_applications (variety_id);

alter table public.seed_applications enable row level security;
drop policy if exists "seed_applications_own" on public.seed_applications;
create policy "seed_applications_own" on public.seed_applications
  for all to authenticated
  using (exists (
    select 1 from public.crop_history h
    join public.fields f on f.id = h.field_id
    where h.id = seed_applications.season_id and f.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.crop_history h
    join public.fields f on f.id = h.field_id
    where h.id = seed_applications.season_id and f.user_id = (select auth.uid())
  ));
revoke all on public.seed_applications from anon;

-- ---------------------------------------------------------------------------
-- 3. save_season: + p_seeds
-- ---------------------------------------------------------------------------
-- p_seeds: [ { variety_id, crop_id, variety_name, origin, rate_kg_ha, price_eur_kg, method,
--              sown_on, contractor, contractor_eur_ha } ]
--   null (the default) leaves the seed as it is, so a browser with the previous version of the
--   app never deletes it. Everything else is exactly as in 20261104.
-- The 6-argument version is dropped so the API never has two to choose between.
drop function if exists public.save_season(uuid, jsonb, jsonb, bigint, jsonb, jsonb);

create or replace function public.save_season(
  p_field_id     uuid,
  p_season       jsonb,
  p_applications jsonb default '[]'::jsonb,
  p_id           bigint default null,
  p_protections  jsonb default null,
  p_income       jsonb default null,
  p_seeds        jsonb default null
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
    rate_kg_ha, price_eur_kg, method, applied_on, contractor, contractor_eur_ha, position
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
    coalesce((a.x ->> 'contractor')::boolean, false),
    case when coalesce((a.x ->> 'contractor')::boolean, false)
         then nullif(a.x ->> 'contractor_eur_ha', '')::numeric end,
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

  -- Income: one row per season, replaced as a whole, only when the caller sends it.
  -- Not disclosed: every figure is left empty, whatever the request holds.
  if p_income is not null then
    insert into public.season_income as si (
      season_id, disclosed,
      main_kg_ha, main_moisture_pct, main_price_eur_kg,
      straw_kg_ha, straw_moisture_pct, straw_price_eur_kg,
      subsidy_eur_ha, other_income_eur_ha
    )
    select
      v_id, d.disclosed,
      case when d.disclosed then nullif(p_income ->> 'main_kg_ha', '')::numeric end,
      case when d.disclosed then nullif(p_income ->> 'main_moisture_pct', '')::numeric end,
      case when d.disclosed then nullif(p_income ->> 'main_price_eur_kg', '')::numeric end,
      case when d.disclosed then nullif(p_income ->> 'straw_kg_ha', '')::numeric end,
      case when d.disclosed then nullif(p_income ->> 'straw_moisture_pct', '')::numeric end,
      case when d.disclosed then nullif(p_income ->> 'straw_price_eur_kg', '')::numeric end,
      case when d.disclosed then nullif(p_income ->> 'subsidy_eur_ha', '')::numeric end,
      case when d.disclosed then nullif(p_income ->> 'other_income_eur_ha', '')::numeric end
    from (select coalesce((p_income ->> 'disclosed')::boolean, true) as disclosed) d
    on conflict (season_id) do update set
      disclosed           = excluded.disclosed,
      main_kg_ha          = excluded.main_kg_ha,
      main_moisture_pct   = excluded.main_moisture_pct,
      main_price_eur_kg   = excluded.main_price_eur_kg,
      straw_kg_ha         = excluded.straw_kg_ha,
      straw_moisture_pct  = excluded.straw_moisture_pct,
      straw_price_eur_kg  = excluded.straw_price_eur_kg,
      subsidy_eur_ha      = excluded.subsidy_eur_ha,
      other_income_eur_ha = excluded.other_income_eur_ha,
      updated_at          = now();
  end if;

  -- Seed: replaced as a whole, only when the caller sends it
  if p_seeds is not null then
    delete from public.seed_applications where season_id = v_id;

    insert into public.seed_applications (
      season_id, variety_id, crop_id, variety_name, origin, rate_kg_ha, price_eur_kg, method,
      sown_on, contractor, contractor_eur_ha, position
    )
    select
      v_id,
      v.id,
      -- A listed variety: its crop and name come from the list, not from the request
      coalesce(v.crop_id, nullif(a.x ->> 'crop_id', ''), p_season ->> 'crop_id'),
      coalesce(v.name, left(nullif(btrim(a.x ->> 'variety_name'), ''), 120)),
      nullif(a.x ->> 'origin', ''),
      nullif(a.x ->> 'rate_kg_ha', '')::numeric,
      nullif(a.x ->> 'price_eur_kg', '')::numeric,
      nullif(a.x ->> 'method', ''),
      nullif(a.x ->> 'sown_on', '')::date,
      coalesce((a.x ->> 'contractor')::boolean, false),
      case when coalesce((a.x ->> 'contractor')::boolean, false)
           then nullif(a.x ->> 'contractor_eur_ha', '')::numeric end,
      (a.ord - 1)::smallint
    from jsonb_array_elements(p_seeds) with ordinality as a(x, ord)
    left join public.seed_varieties v on v.id = nullif(a.x ->> 'variety_id', '')::bigint;
  end if;

  return v_id;
end;
$$;

revoke execute on function public.save_season(uuid, jsonb, jsonb, bigint, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.save_season(uuid, jsonb, jsonb, bigint, jsonb, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. season_cost_lines: + seed and the sowing contractor (columns unchanged)
-- ---------------------------------------------------------------------------
create or replace view public.season_cost_lines
with (security_invoker = true)
as
select h.id as season_id, h.field_id, 'fertilizer'::text as category,
       a.id as line_id, a.product_name as item, a.applied_on,
       a.rate_kg_ha as quantity_ha, 'kg'::text as unit, a.price_eur_kg as unit_price_eur,
       round(a.rate_kg_ha * a.price_eur_kg, 2) as cost_eur_ha,
       'fertilizer_applications'::text as source_table
from public.fertilizer_applications a
join public.crop_history h on h.id = a.season_id
union all
select h.id, h.field_id, 'contract_work',
       a.id, a.product_name, a.applied_on,
       null, null, null,
       round(a.contractor_eur_ha, 2),
       'fertilizer_applications'
from public.fertilizer_applications a
join public.crop_history h on h.id = a.season_id
where a.contractor
union all
select h.id, h.field_id, 'crop_protection',
       p.id, p.product_name, p.applied_on,
       p.dose_per_ha, p.unit, p.price_eur_unit,
       round(p.dose_per_ha * p.price_eur_unit, 2),
       'protection_applications'
from public.protection_applications p
join public.crop_history h on h.id = p.season_id
union all
select h.id, h.field_id, 'contract_work',
       p.id, p.product_name, p.applied_on,
       null, null, null,
       round(p.contractor_eur_ha, 2),
       'protection_applications'
from public.protection_applications p
join public.crop_history h on h.id = p.season_id
where p.contractor
union all
select h.id, h.field_id, 'seed',
       s.id, coalesce(s.variety_name, s.crop_id), s.sown_on,
       s.rate_kg_ha, 'kg', s.price_eur_kg,
       round(s.rate_kg_ha * s.price_eur_kg, 2),
       'seed_applications'
from public.seed_applications s
join public.crop_history h on h.id = s.season_id
union all
select h.id, h.field_id, 'contract_work',
       s.id, coalesce(s.variety_name, s.crop_id), s.sown_on,
       null, null, null,
       round(s.contractor_eur_ha, 2),
       'seed_applications'
from public.seed_applications s
join public.crop_history h on h.id = s.season_id
where s.contractor;

-- ---------------------------------------------------------------------------
-- 5. season_finance: seed in the costs; seed columns appended (existing columns unchanged)
-- ---------------------------------------------------------------------------
create or replace view public.season_finance
with (security_invoker = true)
as
with costs as (
  select season_id,
         sum(cost_eur_ha) filter (where category = 'fertilizer')      as fertilizer_eur_ha,
         sum(cost_eur_ha) filter (where category = 'crop_protection') as crop_protection_eur_ha,
         sum(cost_eur_ha) filter (where category = 'contract_work')   as contract_work_eur_ha,
         sum(cost_eur_ha)                                             as total_cost_eur_ha,
         sum(cost_eur_ha) filter (where category = 'seed')            as seed_eur_ha,
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
         count(*)::int                              as fertilizer_count,
         (count(*) filter (where contractor))::int  as contractor_count
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
),
seeds as (
  select season_id,
         round(sum(rate_kg_ha), 2)                                          as seed_kg_ha,
         count(*)::int                                                      as seed_count,
         (count(*) filter (where contractor))::int                          as contractor_count,
         -- true: all certified; false: some uncertified or own seed; empty: not known
         case when bool_or(origin in ('uncertified', 'own')) then false
              when bool_and(origin = 'certified') then true end              as certified_seed
  from public.seed_applications
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
  coalesce(tr.contractor_count, 0) + coalesce(nu.contractor_count, 0) + coalesce(se.contractor_count, 0) as contractor_count,
  h.yield_outcome,
  h.irrigation                                               as irrigation_level,
  c.yield_kg_ha                                              as ref_yield_kg_ha,
  c.price_eur_kg                                             as ref_price_eur_kg,
  c.price_kind                                               as ref_price_kind,
  round(c.yield_kg_ha * c.price_eur_kg, 2)                   as ref_revenue_eur_ha,
  -- Income (columns added by 20261104)
  c.main_product,
  i.disclosed                                                as income_disclosed,
  i.main_kg_ha                                               as reported_main_kg_ha,
  i.main_price_eur_kg                                        as reported_main_price_eur_kg,
  i.main_moisture_pct,
  round(i.main_kg_ha * (100 - i.main_moisture_pct) / 100, 1) as main_dry_matter_kg_ha,
  i.straw_kg_ha,
  i.straw_price_eur_kg,
  i.straw_moisture_pct,
  round(i.straw_kg_ha * (100 - i.straw_moisture_pct) / 100, 1) as straw_dry_matter_kg_ha,
  yf.factor                                                  as yield_factor,
  b.basis                                                    as revenue_basis,
  round(q.main_kg, 2)                                        as main_kg_ha_used,
  q.main_price                                               as main_price_eur_kg_used,
  round(q.main_kg * q.main_price, 2)                         as main_revenue_eur_ha,
  q.straw_revenue                                            as straw_revenue_eur_ha,
  q.subsidy                                                  as subsidy_eur_ha,
  q.other                                                    as other_income_eur_ha,
  r.revenue                                                  as revenue_eur_ha,
  round(r.revenue / 10, 2)                                   as revenue_eur_stremma,
  round(r.revenue * f.area_ha, 2)                            as revenue_eur_field,
  r.margin                                                   as margin_eur_ha,
  round(r.margin / 10, 2)                                    as margin_eur_stremma,
  round(r.margin * f.area_ha, 2)                             as margin_eur_field,
  (r.margin > 0)                                             as profitable,
  -- Seed (columns added by 20261105)
  co.seed_eur_ha,
  se.seed_kg_ha,
  coalesce(se.seed_count, 0)                                 as seed_count,
  se.certified_seed
from public.crop_history h
join public.fields f      on f.id = h.field_id
left join public.crops c  on c.id = h.crop_id
left join costs co        on co.season_id = h.id
left join nutrients nu    on nu.season_id = h.id
left join treatments tr   on tr.season_id = h.id
left join seeds se        on se.season_id = h.id
left join public.season_income i         on i.season_id = h.id
left join public.yield_outcome_factors yf on yf.outcome = coalesce(h.yield_outcome, 'unknown')
-- Where the main product's figures come from (see section 4 above)
cross join lateral (
  select case
    when h.sown_on is not null and h.harvested_on is null then 'ongoing'
    when c.main_product = 'none' then 'no_harvest'
    when coalesce(i.disclosed, true) and i.main_kg_ha is not null and i.main_price_eur_kg is not null then 'reported'
    when coalesce(i.main_kg_ha, c.yield_kg_ha * yf.factor) is null
      or coalesce(i.main_price_eur_kg, c.price_eur_kg) is null then 'no_reference'
    when i.main_kg_ha is not null or i.main_price_eur_kg is not null then 'partly_estimated'
    when coalesce(h.yield_outcome, 'unknown') <> 'unknown' then 'estimated_from_outcome'
    else 'estimated_baseline'
  end as basis
) b
-- The figures used, per hectare
cross join lateral (
  select
    case when b.basis in ('ongoing', 'no_reference') then null
         when b.basis = 'no_harvest' then 0
         else coalesce(i.main_kg_ha, c.yield_kg_ha * yf.factor) end                       as main_kg,
    case when b.basis in ('ongoing', 'no_reference') then null
         when b.basis = 'no_harvest' then 0
         else coalesce(i.main_price_eur_kg, c.price_eur_kg) end                            as main_price,
    case when b.basis = 'ongoing' then null
         else round(coalesce(i.straw_kg_ha * i.straw_price_eur_kg, 0), 2) end              as straw_revenue,
    case when b.basis = 'ongoing' then null else coalesce(i.subsidy_eur_ha, 0) end         as subsidy,
    case when b.basis = 'ongoing' then null else coalesce(i.other_income_eur_ha, 0) end    as other
) q
-- Revenue and margin over the costs recorded in this season
cross join lateral (
  select rv.revenue, round(rv.revenue - coalesce(co.total_cost_eur_ha, 0), 2) as margin
  from (select round(q.main_kg * q.main_price + q.straw_revenue + q.subsidy + q.other, 2) as revenue) rv
) r;

-- ---------------------------------------------------------------------------
-- 6. field_finance: avg_seed_eur_ha appended (existing columns unchanged)
-- ---------------------------------------------------------------------------
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
         bool_and(cost_complete) filter (where cost_lines > 0)              as cost_complete,
         (count(*) filter (where revenue_eur_ha is not null))::int          as seasons_with_revenue,
         (count(*) filter (where revenue_basis = 'reported'))::int          as seasons_reported,
         round(sum(revenue_eur_field), 2)                                   as total_revenue_eur_field,
         round(sum(margin_eur_field), 2)                                    as total_margin_eur_field,
         round(avg(revenue_eur_ha), 2)                                      as avg_revenue_eur_ha,
         round(avg(margin_eur_ha), 2)                                       as avg_margin_eur_ha,
         round(avg(margin_eur_ha) / 10, 2)                                  as avg_margin_eur_stremma,
         (count(*) filter (where margin_eur_ha > 0))::int                   as profitable_seasons,
         (count(*) filter (where margin_eur_ha < 0))::int                   as loss_seasons,
         round(avg(seed_eur_ha), 2)                                         as avg_seed_eur_ha
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
  ls.total_cost_eur_ha         as last_cost_eur_ha,
  -- Income (columns added by 20261104)
  coalesce(pf.seasons_with_revenue, 0) as seasons_with_revenue,
  coalesce(pf.seasons_reported, 0)     as seasons_reported,
  pf.total_revenue_eur_field,
  pf.total_margin_eur_field,
  pf.avg_revenue_eur_ha,
  pf.avg_margin_eur_ha,
  pf.avg_margin_eur_stremma,
  coalesce(pf.profitable_seasons, 0)   as profitable_seasons,
  coalesce(pf.loss_seasons, 0)         as loss_seasons,
  ls.revenue_basis             as last_revenue_basis,
  ls.revenue_eur_ha            as last_revenue_eur_ha,
  ls.margin_eur_ha             as last_margin_eur_ha,
  -- Seed (column added by 20261105)
  pf.avg_seed_eur_ha
from public.fields f
left join per_field pf on pf.field_id = f.id
left join lateral (
  select s.season_id, s.crop_id, s.sown_on, s.harvested_on, s.total_cost_eur_ha,
         s.revenue_basis, s.revenue_eur_ha, s.margin_eur_ha
  from public.season_finance s
  where s.field_id = f.id
  order by coalesce(s.sown_on, make_date(s.season_year, 1, 1)) desc, s.season_id desc
  limit 1
) ls on true;

revoke all on public.season_cost_lines, public.season_finance, public.field_finance from public, anon;
grant select on public.season_cost_lines, public.season_finance, public.field_finance to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- Verification (run manually):
--   -- exactly one save_season, with 7 arguments
--   select pg_get_function_identity_arguments(oid) from pg_proc where proname = 'save_season';
--     -> p_field_id uuid, p_season jsonb, p_applications jsonb, p_id bigint, p_protections jsonb,
--        p_income jsonb, p_seeds jsonb
--
--   -- the new tables have RLS on (expect 2 rows, rowsecurity = true)
--   select tablename, rowsecurity from pg_tables
--   where schemaname = 'public' and tablename in ('seed_varieties', 'seed_applications');
--
--   -- after data/seed_varieties/seed.sql: varieties per crop
--   select crop_id, count(*) from public.seed_varieties group by 1 order by 1;
--
--   -- seed per season
--   select field_name, crop_id, sown_on, seed_kg_ha, seed_eur_ha, certified_seed,
--          total_cost_eur_stremma, margin_eur_stremma
--   from public.season_finance order by field_name, sown_on desc nulls last;
-- ---------------------------------------------------------------------------