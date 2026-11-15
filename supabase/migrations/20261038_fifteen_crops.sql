-- 20261038_fifteen_crops.sql
-- Field Shift: the six crops of the team's 15-crop list that the database did not have yet.
--
--   The 15 crops: data/crops/crops.csv (Cropfather_15_Crops_Model_Input.xlsx). Nine were already
--   in public.crops; this adds soybean, sorghum, peanut, sugar_beet, rapeseed, field_pea, and
--   fills for them what the season migrations filled for the older crops:
--
--   crops                      the rows themselves (id, names, family, type, n_fixer), and
--                              main_product / byproduct  (20261034_season_income.sql)
--                              sowing_month / harvest_month  (20261032_season_periods_fertilizers.sql)
--   crop_irrigation_baselines  water of a fully irrigated season and the usual method
--                              (20261036_season_irrigation.sql)
--
-- genus, yield and price come with the policy seed (data/policy/crops.csv), which updates only
-- its own columns. The two can run in either order: the seed upserts by id, and this file only
-- inserts missing rows and fills empty values.
--
-- Run after 20261037_soil_observations.sql. Runs in one transaction. Idempotent: safe to run
-- more than once (rows are only inserted when missing, values only filled where still empty,
-- so your edits are kept).

begin;

-- ---------------------------------------------------------------------------
-- 1. The crops
-- ---------------------------------------------------------------------------
insert into public.crops (id, name_en, name_el, family, type, n_fixer) values
  ('soybean',    'Soybean',            'Σόγια',                'Fabaceae',      'legume',     true),
  ('sorghum',    'Sorghum (grain)',    'Σόργο (καρπός)',       'Poaceae',       'cereal',     false),
  ('peanut',     'Peanut',             'Αραχίδα',              'Fabaceae',      'legume',     true),
  ('sugar_beet', 'Sugar beet',         'Ζαχαρότευτλα',         'Amaranthaceae', 'industrial', false),
  ('rapeseed',   'Rapeseed',           'Ελαιοκράμβη',          'Brassicaceae',  'oilseed',    false),
  ('field_pea',  'Field pea (forage)', 'Μπιζέλι κτηνοτροφικό', 'Fabaceae',      'legume',     true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. What is harvested and sold
-- ---------------------------------------------------------------------------
-- Same rules as 20261034: straw only where it is commonly baled and sold (field pea, like
-- vetch). Sugar beet roots have no value of their own in the list, so 'other'.
update public.crops c
set main_product = v.main_product, byproduct = v.byproduct
from (values
  ('soybean',    'grain', null),
  ('sorghum',    'grain', null),
  ('peanut',     'grain', null),
  ('sugar_beet', 'other', null),
  ('rapeseed',   'seed',  null),
  ('field_pea',  'grain', 'straw')
) as v(id, main_product, byproduct)
where c.id = v.id and c.main_product is null;

-- ---------------------------------------------------------------------------
-- 3. Usual calendar (month 1-12), to suggest dates
-- ---------------------------------------------------------------------------
-- Indicative for Greek lowland and coastal fields, like the values in 20261032.
-- Summer crops sown in spring; rapeseed and field pea sown in autumn.
update public.crops c
set sowing_month = v.sow, harvest_month = v.harvest
from (values
  ('soybean',     5,  9),
  ('sorghum',     5,  9),
  ('peanut',      5,  9),
  ('sugar_beet',  3,  9),
  ('rapeseed',   10,  6),
  ('field_pea',  11,  5)
) as v(id, sow, harvest)
where c.id = v.id and c.sowing_month is null and c.harvest_month is null;

-- ---------------------------------------------------------------------------
-- 4. Irrigation baselines
-- ---------------------------------------------------------------------------
-- Starting values, like those of 20261036: water applied in a fully irrigated season (mm).
-- Summer crops between sunflower (250) and maize (600); autumn-sown crops like vetch (60).
insert into public.crop_irrigation_baselines (crop_id, full_mm, typical_method, source)
select v.crop_id, v.full_mm, v.method, 'Starting value; calibrate with your data'
from (values
  ('soybean',    450, 'sprinkler'),
  ('sorghum',    300, 'sprinkler'),
  ('peanut',     450, 'sprinkler'),
  ('sugar_beet', 550, 'sprinkler'),
  ('rapeseed',    60, 'sprinkler'),
  ('field_pea',   60, 'sprinkler')
) as v(crop_id, full_mm, method)
where exists (select 1 from public.crops c where c.id = v.crop_id)
on conflict (crop_id) do nothing;

commit;

-- ---------------------------------------------------------------------------
-- Verification (run manually, after this file and the policy seed):
--   -- the 15 crops with everything the finance views need (expect 15 rows; yield / price
--   -- empty where data/policy/README.md says no source was found)
--   select c.id, c.genus, c.main_product, c.sowing_month, c.harvest_month,
--          b.full_mm, c.yield_kg_ha, c.price_eur_kg, c.price_kind
--   from public.crops c
--   join public.crop_group_members m on m.crop_id = c.id and m.group_id = 'crop_shift'
--   left join public.crop_irrigation_baselines b on b.crop_id = c.id
--   order by c.id;
-- ---------------------------------------------------------------------------
