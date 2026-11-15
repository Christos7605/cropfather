-- 20261050_crop_cost_approaches.sql
-- Field Shift: values that approach the costs of each of the 15 crops, as ranges (min-max).
--
--   crop_cost_approaches        seed, one row per crop:
--     seed_price_min/max_eur_kg     price of sowing seed, EUR per kg
--     seeding_rate_min/max_kg_ha    kg of seed sown per hectare
--   crop_fertilizer_approaches  fertiliser, one row per crop:
--     fertilizer_price_min/max_eur_kg  price of fertiliser product, EUR per kg
--     fertilizer_rate_min/max_kg_ha    kg of fertiliser PRODUCT per hectare in a season
--                                      (basal + top dressing)
--   crop_protection_approaches  plant protection, one row per crop:
--     protection_cost_min/max_eur_ha   cost of plant protection products per hectare in a
--                                      season, EUR/ha
--
--   Each value has a *_scope column next to it:
--     greece   a Greek source (farm press, guides, shops, regulation)
--     global   no Greek source was found, so the value is from abroad (US extension budgets
--              and guides, Canada, UK, Ireland), converted to EUR and metric units
--
--   Sources, conversions and how sure each number is: docs/crop-cost-approaches.md. More cost
--   columns or tables will be added here.
--
--   Reference values only, never used in place of a farmer's own costs (seed_applications,
--   fertilizer_applications and the other season lines).
--
-- Run after 20261049_price_ranges_irrigation_baselines.sql. The tables only reference
-- public.crops, which 20261038 already filled. Runs in one transaction.
-- Idempotent: the rows are set to the values below every time it runs.

begin;

-- ---------------------------------------------------------------------------
-- 1. Seed
-- ---------------------------------------------------------------------------
create table if not exists public.crop_cost_approaches (
  crop_id                text primary key references public.crops (id) on delete cascade,
  seed_price_min_eur_kg  numeric,
  seed_price_max_eur_kg  numeric,
  seed_price_scope       text,
  seeding_rate_min_kg_ha numeric,
  seeding_rate_max_kg_ha numeric,
  seeding_rate_scope     text
);

-- added after the first version of this file: kept for databases that already have the table
alter table public.crop_cost_approaches add column if not exists seed_price_scope   text;
alter table public.crop_cost_approaches add column if not exists seeding_rate_scope text;

-- a range is given whole or not at all, min <= max, and has a scope exactly when it exists
alter table public.crop_cost_approaches drop constraint if exists crop_cost_approaches_seed_price_check;
alter table public.crop_cost_approaches add constraint crop_cost_approaches_seed_price_check check (
  (seed_price_min_eur_kg is null) = (seed_price_max_eur_kg is null)
  and (seed_price_min_eur_kg is null) = (seed_price_scope is null)
  and (seed_price_min_eur_kg is null
       or (seed_price_min_eur_kg > 0 and seed_price_min_eur_kg <= seed_price_max_eur_kg))
  and (seed_price_scope is null or seed_price_scope in ('greece', 'global')));

alter table public.crop_cost_approaches drop constraint if exists crop_cost_approaches_seeding_rate_check;
alter table public.crop_cost_approaches add constraint crop_cost_approaches_seeding_rate_check check (
  (seeding_rate_min_kg_ha is null) = (seeding_rate_max_kg_ha is null)
  and (seeding_rate_min_kg_ha is null) = (seeding_rate_scope is null)
  and (seeding_rate_min_kg_ha is null
       or (seeding_rate_min_kg_ha > 0 and seeding_rate_min_kg_ha <= seeding_rate_max_kg_ha))
  and (seeding_rate_scope is null or seeding_rate_scope in ('greece', 'global')));

alter table public.crop_cost_approaches enable row level security;
drop policy if exists "crop_cost_approaches_read" on public.crop_cost_approaches;
create policy "crop_cost_approaches_read" on public.crop_cost_approaches for select using (true);

insert into public.crop_cost_approaches (
  crop_id, seed_price_min_eur_kg, seed_price_max_eur_kg, seed_price_scope,
  seeding_rate_min_kg_ha, seeding_rate_max_kg_ha, seeding_rate_scope)
select v.crop_id, v.p_min, v.p_max, v.p_scope, v.r_min, v.r_max, v.r_scope
from (values
  ('cotton',      7.5::numeric, 10.0::numeric, 'greece', 30::numeric, 40::numeric, 'greece'),
  ('maize',       10,    15,    'greece', 28,   33,   'greece'),
  ('rice',        2.0,   3.5,   'greece', 200,  200,  'greece'),
  ('soybean',     2.7,   3.2,   'global', 60,   80,   'greece'),
  ('sunflower',   22,    30,    'greece', 3.5,  5,    'greece'),
  ('sorghum',     2.3,   8.1,   'global', 5.6,  9.0,  'global'),
  ('peanut',      1.8,   2.0,   'greece', 90,   120,  'greece'),
  ('sugar_beet',  83,    83,    'global', 3.4,  3.8,  'global'),
  ('alfalfa',     8,     10,    'greece', 13,   22,   'global'),
  ('wheat_durum', 0.80,  1.00,  'greece', 180,  220,  'greece'),
  ('barley',      0.70,  1.00,  'greece', 180,  200,  'greece'),
  ('wheat_soft',  0.80,  1.00,  'greece', 180,  220,  'greece'),
  ('rapeseed',    16,    27,    'greece', 3,    5,    'greece'),
  ('vetch',       1.60,  1.60,  'greece', 180,  180,  'greece'),
  ('field_pea',   1.88,  2.00,  'greece', 150,  180,  'greece')
) as v(crop_id, p_min, p_max, p_scope, r_min, r_max, r_scope)
where exists (select 1 from public.crops c where c.id = v.crop_id)
on conflict (crop_id) do update set
  seed_price_min_eur_kg  = excluded.seed_price_min_eur_kg,
  seed_price_max_eur_kg  = excluded.seed_price_max_eur_kg,
  seed_price_scope       = excluded.seed_price_scope,
  seeding_rate_min_kg_ha = excluded.seeding_rate_min_kg_ha,
  seeding_rate_max_kg_ha = excluded.seeding_rate_max_kg_ha,
  seeding_rate_scope     = excluded.seeding_rate_scope;

-- ---------------------------------------------------------------------------
-- 2. Fertiliser
-- ---------------------------------------------------------------------------
-- Rates are worked out from nutrient doses (kg N, P2O5, K2O) with one fixed mix: 20-20-0 for the
-- phosphorus (its nitrogen counts), 0-0-50 for the potassium, ammonium nitrate 34.5 (urea 46 for
-- rice) for the rest of the nitrogen; triple superphosphate 0-46-0 for legumes, which need no N.
create table if not exists public.crop_fertilizer_approaches (
  crop_id                     text primary key references public.crops (id) on delete cascade,
  fertilizer_price_min_eur_kg numeric,
  fertilizer_price_max_eur_kg numeric,
  fertilizer_price_scope      text,
  fertilizer_rate_min_kg_ha   numeric,
  fertilizer_rate_max_kg_ha   numeric,
  fertilizer_rate_scope       text,

  constraint crop_fertilizer_approaches_price_check check (
    (fertilizer_price_min_eur_kg is null) = (fertilizer_price_max_eur_kg is null)
    and (fertilizer_price_min_eur_kg is null) = (fertilizer_price_scope is null)
    and (fertilizer_price_min_eur_kg is null
         or (fertilizer_price_min_eur_kg > 0
             and fertilizer_price_min_eur_kg <= fertilizer_price_max_eur_kg))
    and (fertilizer_price_scope is null or fertilizer_price_scope in ('greece', 'global'))),
  constraint crop_fertilizer_approaches_rate_check check (
    (fertilizer_rate_min_kg_ha is null) = (fertilizer_rate_max_kg_ha is null)
    and (fertilizer_rate_min_kg_ha is null) = (fertilizer_rate_scope is null)
    and (fertilizer_rate_min_kg_ha is null
         or (fertilizer_rate_min_kg_ha > 0
             and fertilizer_rate_min_kg_ha <= fertilizer_rate_max_kg_ha))
    and (fertilizer_rate_scope is null or fertilizer_rate_scope in ('greece', 'global')))
);

alter table public.crop_fertilizer_approaches enable row level security;
drop policy if exists "crop_fertilizer_approaches_read" on public.crop_fertilizer_approaches;
create policy "crop_fertilizer_approaches_read" on public.crop_fertilizer_approaches
  for select using (true);

-- Price: 0.55 EUR/kg, the Greek market average of 2025, to 0.98 EUR/kg, the average of
-- May 2026; the same for every crop, since no source gives a price per crop.
insert into public.crop_fertilizer_approaches (
  crop_id, fertilizer_price_min_eur_kg, fertilizer_price_max_eur_kg, fertilizer_price_scope,
  fertilizer_rate_min_kg_ha, fertilizer_rate_max_kg_ha, fertilizer_rate_scope)
select v.crop_id, 0.55, 0.98, 'greece', v.r_min, v.r_max, v.r_scope
from (values
  ('cotton',       590::numeric,  960::numeric, 'greece'),
  ('maize',        790, 1280, 'greece'),
  ('rice',         510,  690, 'greece'),
  ('soybean',      130,  410, 'greece'),
  ('sunflower',    260,  610, 'greece'),
  ('sorghum',      360,  890, 'global'),
  ('peanut',       190,  470, 'global'),
  ('sugar_beet',   630,  870, 'greece'),
  ('alfalfa',      450,  600, 'greece'),
  ('wheat_durum',  320,  710, 'greece'),
  ('barley',       320,  710, 'greece'),
  ('wheat_soft',   320,  710, 'greece'),
  ('rapeseed',     370,  600, 'greece'),
  ('vetch',        130,  220, 'greece'),
  ('field_pea',     40,  110, 'global')
) as v(crop_id, r_min, r_max, r_scope)
where exists (select 1 from public.crops c where c.id = v.crop_id)
on conflict (crop_id) do update set
  fertilizer_price_min_eur_kg = excluded.fertilizer_price_min_eur_kg,
  fertilizer_price_max_eur_kg = excluded.fertilizer_price_max_eur_kg,
  fertilizer_price_scope      = excluded.fertilizer_price_scope,
  fertilizer_rate_min_kg_ha   = excluded.fertilizer_rate_min_kg_ha,
  fertilizer_rate_max_kg_ha   = excluded.fertilizer_rate_max_kg_ha,
  fertilizer_rate_scope       = excluded.fertilizer_rate_scope;

-- ---------------------------------------------------------------------------
-- 3. Plant protection
-- ---------------------------------------------------------------------------
-- Cost of plant protection PRODUCTS per hectare in a season (herbicides, fungicides,
-- insecticides, seed treatment where the source counts it), EUR/ha; spraying work is not
-- included. Kept as a cost, not price x quantity: products differ too much in price per kg or
-- litre (a few EUR to hundreds) for an average price to mean anything.
-- Values from abroad are US extension budgets 2025-2026, converted with 1 USD = 0.88 EUR and
-- 1 acre = 0.4047 ha ($/acre x 2.1745 = EUR/ha). Vetch can go unsprayed, so its min is 0.
create table if not exists public.crop_protection_approaches (
  crop_id                    text primary key references public.crops (id) on delete cascade,
  protection_cost_min_eur_ha numeric,
  protection_cost_max_eur_ha numeric,
  protection_cost_scope      text,

  constraint crop_protection_approaches_cost_check check (
    (protection_cost_min_eur_ha is null) = (protection_cost_max_eur_ha is null)
    and (protection_cost_min_eur_ha is null) = (protection_cost_scope is null)
    and (protection_cost_min_eur_ha is null
         or (protection_cost_min_eur_ha >= 0
             and protection_cost_min_eur_ha <= protection_cost_max_eur_ha))
    and (protection_cost_scope is null or protection_cost_scope in ('greece', 'global')))
);

alter table public.crop_protection_approaches enable row level security;
drop policy if exists "crop_protection_approaches_read" on public.crop_protection_approaches;
create policy "crop_protection_approaches_read" on public.crop_protection_approaches
  for select using (true);

insert into public.crop_protection_approaches (
  crop_id, protection_cost_min_eur_ha, protection_cost_max_eur_ha, protection_cost_scope)
select v.crop_id, v.c_min, v.c_max, v.scope
from (values
  ('cotton',      200::numeric, 300::numeric, 'greece'),
  ('maize',        77,  82, 'global'),
  ('rice',        199, 361, 'global'),
  ('soybean',      86, 165, 'global'),
  ('sunflower',    73,  90, 'global'),
  ('sorghum',      77, 167, 'global'),
  ('peanut',       31, 141, 'global'),
  ('sugar_beet',  379, 379, 'global'),
  ('alfalfa',      73, 101, 'global'),
  ('wheat_durum',  50, 100, 'greece'),
  ('barley',       49,  90, 'global'),
  ('wheat_soft',   50, 100, 'greece'),
  ('rapeseed',     34,  73, 'global'),
  ('vetch',         0,  82, 'global'),
  ('field_pea',    82,  82, 'global')
) as v(crop_id, c_min, c_max, scope)
where exists (select 1 from public.crops c where c.id = v.crop_id)
on conflict (crop_id) do update set
  protection_cost_min_eur_ha = excluded.protection_cost_min_eur_ha,
  protection_cost_max_eur_ha = excluded.protection_cost_max_eur_ha,
  protection_cost_scope      = excluded.protection_cost_scope;

commit;

-- ---------------------------------------------------------------------------
-- Verification (run manually):
--   select crop_id, protection_cost_min_eur_ha, protection_cost_max_eur_ha, protection_cost_scope
--   from public.crop_protection_approaches order by crop_id;
--   -- expect 15 rows; greece for cotton, wheat_durum, wheat_soft, global for the rest
--
--   select s.crop_id,
--          s.seed_price_min_eur_kg, s.seed_price_max_eur_kg, s.seed_price_scope,
--          s.seeding_rate_min_kg_ha, s.seeding_rate_max_kg_ha, s.seeding_rate_scope,
--          f.fertilizer_price_min_eur_kg, f.fertilizer_price_max_eur_kg, f.fertilizer_price_scope,
--          f.fertilizer_rate_min_kg_ha, f.fertilizer_rate_max_kg_ha, f.fertilizer_rate_scope
--   from public.crop_cost_approaches s
--   join public.crop_fertilizer_approaches f using (crop_id)
--   order by s.crop_id;
--   -- expect 15 rows, every value filled
--
--   -- values from abroad
--   select crop_id, 'seed price' from public.crop_cost_approaches where seed_price_scope = 'global'
--   union all select crop_id, 'seeding rate' from public.crop_cost_approaches where seeding_rate_scope = 'global'
--   union all select crop_id, 'fertiliser rate' from public.crop_fertilizer_approaches where fertilizer_rate_scope = 'global';
--   -- expect soybean, sorghum, sugar_beet (seed price); sorghum, sugar_beet, alfalfa (seeding
--   -- rate); sorghum, peanut, field_pea (fertiliser rate)
-- ---------------------------------------------------------------------------
