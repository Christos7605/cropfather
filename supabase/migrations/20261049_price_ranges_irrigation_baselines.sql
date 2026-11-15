-- 20261049_price_ranges_irrigation_baselines.sql
-- Field Shift: the price range of each crop, borrowed (proxy) prices, and the irrigation
-- baselines of the irrigation note.
--
--   crops                      + price_low_eur_kg, price_high_eur_kg: the range the price was
--                                observed in. price_eur_kg is its midpoint, the price every
--                                calculation uses (revenue = yield x price_eur_kg).
--                              + price_kind 'proxy': no Greek farm-gate price was found, so the
--                                price is a European or world price of the same product, flagged
--                                as borrowed. It gives revenue (unlike 'mock'), and is shown as
--                                approximate.
--   crop_irrigation_baselines  the values of Field_Shift_irrigation_water_energy.docx, section
--                              1.3: rice 2300, cotton 450, maize 440 mm; soybean, sorghum, peanut,
--                              rapeseed and field pea have no baseline ("not set"), so their water
--                              is never estimated: the farmer has to report it.
--
-- price_kind after this file:
--   market      Greek farm-gate price, observed (range low-high, midpoint in price_eur_kg)
--   proxy       European or world price of the same product, borrowed (see price_source)
--   indicative  estimate; the explanation must say it is approximate
--   mock        placeholder without a source: no revenue, gross or margin is built on it
--
-- Nothing else changes: crop_economics and crop_comparison() read price_eur_kg and price_kind as
-- before, so a proxy price gives revenue and reaches the model with price_kind = 'proxy'.
--
-- Run after 20261042_policy_read.sql. 20261043 through 20261048 are already applied and
-- this file does not change them. Run it before 20261050_crop_cost_approaches.sql.
-- 20261041 keeps price_kind 'proxy', so the two files can be re-run in either order.
-- Do not re-run 20261038_fifteen_crops.sql after this file: that insert would put the
-- soybean, sorghum, peanut, rapeseed and field_pea baselines back. Runs in one
-- transaction. Idempotent.

begin;

-- ---------------------------------------------------------------------------
-- 1. Price range and price_kind 'proxy'
-- ---------------------------------------------------------------------------
alter table public.crops add column if not exists price_low_eur_kg  numeric;
alter table public.crops add column if not exists price_high_eur_kg numeric;

alter table public.crops drop constraint if exists crops_price_check;
alter table public.crops
  add constraint crops_price_check
  check ((price_eur_kg is null or price_eur_kg > 0)
         and (price_eur_kg is null) = (price_kind is null)
         and (price_kind is null or price_kind in ('market', 'proxy', 'indicative', 'mock')));

-- The range is given whole or not at all, and the price in use lies inside it.
alter table public.crops drop constraint if exists crops_price_range_check;
alter table public.crops
  add constraint crops_price_range_check
  check ((price_low_eur_kg is null) = (price_high_eur_kg is null)
         and (price_low_eur_kg is null
              or (price_eur_kg is not null
                  and price_low_eur_kg > 0
                  and price_low_eur_kg <= price_eur_kg
                  and price_eur_kg <= price_high_eur_kg)));

-- ---------------------------------------------------------------------------
-- 2. Irrigation baselines of the irrigation note (section 1.3)
-- ---------------------------------------------------------------------------
-- Water applied in a fully irrigated season (mm = m³ per stremma) and the usual method.
-- These rows are set to the note's values even if they were edited by hand.
insert into public.crop_irrigation_baselines (crop_id, full_mm, typical_method, source)
select v.crop_id, v.full_mm, v.method, v.source
from (values
  ('rice',        2300, 'surface',   'Greek published value (irrigation note, section 1.3)'),
  ('alfalfa',      800, 'sprinkler', 'Starting value; calibrate with your data'),
  ('sugar_beet',   550, 'sprinkler', 'Greek published value (irrigation note, section 1.3)'),
  ('cotton',       450, 'drip',      'Greek published value (irrigation note, section 1.3)'),
  ('maize',        440, 'sprinkler', 'Greek published value (irrigation note, section 1.3)'),
  ('sunflower',    250, 'sprinkler', 'Starting value; calibrate with your data'),
  ('wheat_durum',   80, 'sprinkler', 'Starting value; calibrate with your data'),
  ('wheat_soft',    80, 'sprinkler', 'Starting value; calibrate with your data'),
  ('barley',        60, 'sprinkler', 'Starting value; calibrate with your data'),
  ('vetch',         60, 'sprinkler', 'Starting value; calibrate with your data')
) as v(crop_id, full_mm, method, source)
where exists (select 1 from public.crops c where c.id = v.crop_id)
on conflict (crop_id) do update set
  full_mm        = excluded.full_mm,
  typical_method = excluded.typical_method,
  source         = excluded.source;

-- "not set" in the note: no volume is estimated for these crops. With a reported volume the
-- pumping cost still needs the method from the farmer (there is no usual method to fall back on).
delete from public.crop_irrigation_baselines
where crop_id in ('soybean', 'sorghum', 'peanut', 'rapeseed', 'field_pea');

commit;

-- ---------------------------------------------------------------------------
-- Verification (run manually; the price rows after loading the new seed):
--   -- the range and the midpoint of the 15 crops (expect 14 rows with a range; vetch has none)
--   select c.id, c.price_low_eur_kg, c.price_high_eur_kg, c.price_eur_kg, c.price_kind,
--          round((c.price_low_eur_kg + c.price_high_eur_kg) / 2, 6) as midpoint
--   from public.crops c
--   join public.crop_group_members m on m.crop_id = c.id and m.group_id = 'crop_shift'
--   order by c.price_kind, c.id;
--
--   -- borrowed prices (expect soybean, sorghum, sugar_beet, wheat_soft, rapeseed, field_pea)
--   select id from public.crops where price_kind = 'proxy' order by id;
--
--   -- irrigation baselines (expect rice 2300, cotton 450, maize 440, and no row for soybean,
--   -- sorghum, peanut, rapeseed, field_pea)
--   select crop_id, full_mm, typical_method, source
--   from public.crop_irrigation_baselines order by full_mm desc;
-- ---------------------------------------------------------------------------
