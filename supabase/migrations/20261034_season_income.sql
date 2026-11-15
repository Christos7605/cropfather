-- 20261104_season_income.sql
-- Field Shift: what a season earned, and the margin over its recorded costs.
--
--   crops                     + main_product: what is harvested and sold (grain, seed cotton,
--                               paddy rice, seed, hay; none for fallow)
--                             + byproduct: 'straw' for the crops whose straw is commonly baled
--                               and sold; the app asks for straw only for these
--   yield_outcome_factors     how the farmer's own word on the harvest (failed, poor, normal,
--                               good) scales the regional yield when no figure is given.
--                               Reference data, editable with the service role.
--   season_income             per season (1:1): main product harvested (kg/ha), moisture, sale
--                               price; straw the same; aid tied to this crop; other income. Or
--                               "prefer not to say" (disclosed = false, every figure empty).
--   save_season(...)          + p_income (6th argument); null leaves the income as it is.
--   season_finance (view)     + income columns at the end: revenue (per ha, stremma, field), where
--                               it comes from (revenue_basis), margin over recorded costs,
--                               profitable. Existing columns unchanged.
--   field_finance (view)      + revenue and margin totals and averages, profitable and loss
--                               seasons. Existing columns unchanged.
--
-- How revenue is worked out, per hectare (same rules in the app, web/src/lib/seasons.ts):
--   main product   quantity x price. A figure the farmer did not give is estimated:
--                    quantity = crops.yield_kg_ha x yield factor of the season's yield_outcome
--                    price    = crops.price_eur_kg
--                  (crops.yield_kg_ha / price_eur_kg: the regional reference of the policy data,
--                  coastal zone averages; missing for some crops, then nothing can be estimated)
--   straw          quantity x price, only when the farmer gives both
--   aid, other     as given by the farmer, else 0
--   revenue        main + straw + aid + other
--   margin         revenue - total_cost_eur_ha (fertilisers, plant protection, contract work: the
--                  costs recorded so far, not every cost of the season)
-- revenue_basis    reported                main quantity and price given by the farmer
--                  partly_estimated        one of the two given, the other estimated
--                  estimated_from_outcome  both estimated, yield scaled by "how did the harvest go"
--                  estimated_baseline      both estimated, plain regional average (no answer)
--                  no_reference            an estimate was needed but the crop has no reference
--                                          data: revenue and margin stay empty
--                  no_harvest              fallow: main product 0 (aid and other income count)
--                  ongoing                 still in the field: no revenue yet
--
-- Run after 20261103_fertilizer_contractor.sql. Runs in one transaction. Idempotent: safe to
-- run more than once (crop values and factors are only filled where still empty / missing).

begin;

-- ---------------------------------------------------------------------------
-- 1. What each crop produces
-- ---------------------------------------------------------------------------
alter table public.crops add column if not exists main_product text;
alter table public.crops add column if not exists byproduct    text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crops_products_check') then
    alter table public.crops add constraint crops_products_check check (
          (main_product is null or main_product in ('grain', 'seed_cotton', 'paddy', 'seed', 'hay', 'none', 'other'))
      and (byproduct is null or byproduct in ('straw'))
    );
  end if;
end $$;

-- Straw: cereals and the grain legumes whose straw is baled for feed. Not maize, rice, cotton,
-- sunflower (their residues are rarely sold), nor hay crops (the hay is the main product).
update public.crops c
set main_product = v.main_product, byproduct = v.byproduct
from (values
  ('wheat_durum', 'grain',       'straw'),
  ('wheat_soft',  'grain',       'straw'),
  ('barley',      'grain',       'straw'),
  ('oat',         'grain',       'straw'),
  ('maize',       'grain',       null),
  ('rice',        'paddy',       null),
  ('cotton',      'seed_cotton', null),
  ('sunflower',   'seed',        null),
  ('vetch',       'grain',       'straw'),
  ('lentil',      'grain',       'straw'),
  ('chickpea',    'grain',       'straw'),
  ('faba_bean',   'grain',       null),
  ('vetch_oat',   'hay',         null),
  ('alfalfa',     'hay',         null),
  ('fallow',      'none',        null),
  ('other',       'other',       null)
) as v(id, main_product, byproduct)
where c.id = v.id and c.main_product is null;

-- ---------------------------------------------------------------------------
-- 2. Yield factors (reference data)
-- ---------------------------------------------------------------------------
-- Starting values: a "normal" year is the regional average; good and poor years move it by
-- roughly the year-to-year spread of Greek arable yields; a failed crop keeps a fifth of it.
-- They are assumptions to calibrate, not measurements: change them here, never in the app.
create table if not exists public.yield_outcome_factors (
  outcome     text primary key check (outcome in ('failed', 'poor', 'normal', 'good', 'unknown')),
  factor      numeric not null check (factor >= 0 and factor <= 2),
  description text
);

insert into public.yield_outcome_factors (outcome, factor, description) values
  ('failed',  0.2, 'Crop failed: about a fifth of a normal harvest'),
  ('poor',    0.7, 'Poor year: about 30% below the regional average'),
  ('normal',  1.0, 'Normal year: the regional average'),
  ('good',    1.2, 'Good year: about 20% above the regional average'),
  ('unknown', 1.0, 'Not answered or "I don''t know": the regional average')
on conflict (outcome) do nothing;

alter table public.yield_outcome_factors enable row level security;
drop policy if exists "yield_outcome_factors_read" on public.yield_outcome_factors;
create policy "yield_outcome_factors_read" on public.yield_outcome_factors for select using (true);

-- ---------------------------------------------------------------------------
-- 3. Season income
-- ---------------------------------------------------------------------------
-- Per hectare (the app asks per stremma and multiplies by 10).
--   main_kg_ha           main product as harvested and sold (what was kept counts too)
--   main_moisture_pct    moisture at harvest, from the buyer's receipt; not used for money (the
--                        price already accounts for it), used for dry matter (main_dry_matter_kg_ha)
--   main_price_eur_kg    price received (for what was kept: the price it would have sold at)
--   straw_*              the same for straw
--   subsidy_eur_ha       aid tied to this crop (coupled support, eco-schemes for this crop...);
--                        not the basic payment, which is paid whatever is grown
--   other_income_eur_ha  e.g. stubble grazing, ΕΛΓΑ compensation
create table if not exists public.season_income (
  season_id           bigint primary key references public.crop_history (id) on delete cascade,
  disclosed           boolean not null default true,
  main_kg_ha          numeric check (main_kg_ha >= 0 and main_kg_ha <= 30000),
  main_moisture_pct   numeric check (main_moisture_pct >= 0 and main_moisture_pct <= 90),
  main_price_eur_kg   numeric check (main_price_eur_kg >= 0 and main_price_eur_kg <= 20),
  straw_kg_ha         numeric check (straw_kg_ha >= 0 and straw_kg_ha <= 15000),
  straw_moisture_pct  numeric check (straw_moisture_pct >= 0 and straw_moisture_pct <= 90),
  straw_price_eur_kg  numeric check (straw_price_eur_kg >= 0 and straw_price_eur_kg <= 2),
  subsidy_eur_ha      numeric check (subsidy_eur_ha >= 0 and subsidy_eur_ha <= 5000),
  other_income_eur_ha numeric check (other_income_eur_ha >= 0 and other_income_eur_ha <= 10000),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint season_income_undisclosed_check check (
    disclosed or num_nonnulls(main_kg_ha, main_moisture_pct, main_price_eur_kg, straw_kg_ha,
                              straw_moisture_pct, straw_price_eur_kg, subsidy_eur_ha,
                              other_income_eur_ha) = 0
  )
);

alter table public.season_income enable row level security;
drop policy if exists "season_income_own" on public.season_income;
create policy "season_income_own" on public.season_income
  for all to authenticated
  using (exists (
    select 1 from public.crop_history h
    join public.fields f on f.id = h.field_id
    where h.id = season_income.season_id and f.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.crop_history h
    join public.fields f on f.id = h.field_id
    where h.id = season_income.season_id and f.user_id = (select auth.uid())
  ));
revoke all on public.season_income from anon;

-- ---------------------------------------------------------------------------
-- 4. save_season: + p_income
-- ---------------------------------------------------------------------------
-- p_income: { disclosed, main_kg_ha, main_moisture_pct, main_price_eur_kg, straw_kg_ha,
--             straw_moisture_pct, straw_price_eur_kg, subsidy_eur_ha, other_income_eur_ha }
--   null (the default) leaves the income as it is, so a browser with the previous version of the
--   app never deletes it. Everything else is exactly as in 20261103.
-- The 5-argument version is dropped so the API never has two to choose between.
drop function if exists public.save_season(uuid, jsonb, jsonb, bigint, jsonb);

create or replace function public.save_season(
  p_field_id     uuid,
  p_season       jsonb,
  p_applications jsonb default '[]'::jsonb,
  p_id           bigint default null,
  p_protections  jsonb default null,
  p_income       jsonb default null
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

  return v_id;
end;
$$;

revoke execute on function public.save_season(uuid, jsonb, jsonb, bigint, jsonb, jsonb) from public, anon;
grant execute on function public.save_season(uuid, jsonb, jsonb, bigint, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. season_finance: income columns appended (existing columns unchanged)
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
  coalesce(tr.contractor_count, 0) + coalesce(nu.contractor_count, 0) as contractor_count,
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
  (r.margin > 0)                                             as profitable
from public.crop_history h
join public.fields f      on f.id = h.field_id
left join public.crops c  on c.id = h.crop_id
left join costs co        on co.season_id = h.id
left join nutrients nu    on nu.season_id = h.id
left join treatments tr   on tr.season_id = h.id
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
-- 6. field_finance: income columns appended (existing columns unchanged)
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
         (count(*) filter (where margin_eur_ha < 0))::int                   as loss_seasons
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
  ls.margin_eur_ha             as last_margin_eur_ha
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

revoke all on public.season_finance, public.field_finance from public, anon;
grant select on public.season_finance, public.field_finance to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- Verification (run manually):
--   -- exactly one save_season, with 6 arguments
--   select pg_get_function_identity_arguments(oid) from pg_proc where proname = 'save_season';
--     -> p_field_id uuid, p_season jsonb, p_applications jsonb, p_id bigint, p_protections jsonb, p_income jsonb
--
--   -- what each crop produces (expect 16 rows, none empty)
--   select id, main_product, byproduct, yield_kg_ha, price_eur_kg from public.crops order by id;
--
--   -- the factors (expect 5 rows)
--   select * from public.yield_outcome_factors order by factor;
--
--   -- income and margin per season
--   select field_name, crop_id, sown_on, harvested_on, revenue_basis, main_kg_ha_used,
--          main_price_eur_kg_used, revenue_eur_stremma, total_cost_eur_stremma,
--          margin_eur_stremma, margin_eur_field, profitable
--   from public.season_finance order by field_name, sown_on desc nulls last;
--
--   -- per field
--   select field_name, seasons_with_revenue, seasons_reported, total_revenue_eur_field,
--          total_cost_eur_field, total_margin_eur_field, profitable_seasons, loss_seasons
--   from public.field_finance order by field_name;
-- ---------------------------------------------------------------------------