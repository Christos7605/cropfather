-- 20261106_season_irrigation.sql
-- Field Shift: the irrigation of each season (Άρδευση) and what it cost.
--
--   fields                    + pump_depth_m: how deep the pump hangs in the borehole (optional,
--                               asked once in the field's water card). well_depth_m stays the
--                               borehole depth as drilled.
--   irrigation_parameters     editable reference values: electricity and diesel prices, pump
--                               efficiencies, the pressure each method needs, irrigation levels.
--   crop_irrigation_baselines per crop: water applied in a fully irrigated season (mm) and the
--                               usual method. Starting values, editable.
--   season_irrigation         per season (1:1): water source, pump power, method, water used
--                               (m³, or pumping hours × pump flow), electricity bill or kWh (with
--                               the share of a meter that serves several fields), diesel litres and
--                               price, network (ΤΟΕΒ) fee, consumables. Own rows only.
--   save_season(...)          + p_irrigation (8th argument); null leaves the irrigation as it is.
--   season_irrigation_costs   (view) the calculation, one row per season: water, lift, head,
--                               energy, cost, and where each figure comes from.
--   season_cost_lines (view)  + category 'irrigation' (energy, network fee, consumables);
--                               + last column estimated (true for an estimated energy line).
--   season_finance (view)     irrigation cost is part of total_cost_eur_ha and the margin;
--                               appended: irrigation_eur_ha, irrigation_basis, source, power,
--                               method, water_m3_ha / _stremma, water_basis, lift, head, kWh,
--                               diesel litres, kg_per_m3, cost_estimated.
--   field_finance (view)      appended: avg_irrigation_eur_ha, total_water_m3_field, avg_water_m3_ha.
--
-- Units: everything per hectare in the database (the app shows per stremma = per ha / 10).
-- 1 mm of water over 1 ha = 10 m³; over 1 stremma = 1 m³.
--
-- How the cost is worked out, per hectare (same rules in the app, web/src/lib/irrigation.ts):
--   water (m³/ha)  as reported: water_m3, or pump_hours × pump_flow_m3h, divided by the field area;
--                  else estimated: crop baseline (mm) × level × 10, where level comes from the
--                  season's "Irrigation" answer (none 0, some 0.5, full 1) or, if not answered,
--                  from the field's water supply (rainfed none, limited some, full full).
--   lift (m)       borehole: pump depth if given, else the borehole depth (an upper bound: the
--                  pump and the water stand higher than the bottom); surface water: surface_lift_m;
--                  network: none (the network delivers under pressure).
--   head (m)       lift + the pressure the method needs at the pump (drip, sprinkler, reel, surface).
--   hydraulic energy (kWh/ha) = ρ·g·H·V / 3,600,000 = 9.81 / 3600 × head (m) × water (m³/ha)
--   electric pump  kWh = hydraulic / pump_efficiency_electric (wire to water); € = kWh × price.
--                  Reported instead: bill (€) × share, or kWh × share × price, divided by the area.
--   diesel pump    litres = hydraulic / (pump_efficiency_diesel × diesel_kwh_per_l); € = l × price.
--                  Reported instead: litres used on this field / area × price.
--   network        the fee per hectare as given (no estimate: fees differ between ΤΟΕΒ).
--   consumables    as given.
-- A cost that is needed but cannot be worked out (borehole without a depth, unknown source,
-- network without a fee) is a line with an empty cost: it counts in unpriced_lines and
-- cost_complete is false. Estimates are only made for harvested seasons.
--
-- Run after 20261105_season_seeds.sql. Runs in one transaction. Idempotent: safe to run more than
-- once (reference values are only inserted where missing, so your edits are kept). Do not re-run
-- older migrations after it (their view definitions have fewer columns).

begin;

-- ---------------------------------------------------------------------------
-- 1. Pump depth on the field
-- ---------------------------------------------------------------------------
alter table public.fields add column if not exists pump_depth_m numeric(6, 1);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fields_pump_depth_check') then
    alter table public.fields add constraint fields_pump_depth_check check (
      pump_depth_m is null
      or (pump_depth_m > 0 and pump_depth_m <= 2000
          and water_point_id is not null
          and (well_depth_m is null or pump_depth_m <= well_depth_m))
    );
  end if;
end $$;

-- Removing or changing the water point clears the pump depth too (it belonged to the old
-- borehole); a borehole depth changed below the pump clears the pump depth (the pump cannot hang
-- below the bottom), so the farmer enters it again.
create or replace function public.clear_depth_without_point()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.water_point_id is null then
    new.well_depth_m := null;
    new.pump_depth_m := null;
  elsif tg_op = 'UPDATE' and new.water_point_id is distinct from old.water_point_id
        and new.pump_depth_m is not distinct from old.pump_depth_m then
    new.pump_depth_m := null;
  end if;
  if new.pump_depth_m is not null and new.well_depth_m is not null and new.pump_depth_m > new.well_depth_m then
    new.pump_depth_m := null;
  end if;
  return new;
end;
$$;

revoke execute on function public.clear_depth_without_point() from public, anon, authenticated;

drop trigger if exists fields_clear_depth on public.fields;
create trigger fields_clear_depth
  before update of water_point_id, well_depth_m, pump_depth_m on public.fields
  for each row execute function public.clear_depth_without_point();

-- my_fields: append pump_depth_m (existing columns unchanged)
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
  w.lat    as well_lat,
  q.version        as survey_version,
  q.status         as survey_status,
  q.answered_count as survey_answered,
  q.question_count as survey_total,
  q.updated_at     as survey_updated_at,
  f.pump_depth_m::float8 as pump_depth_m
from public.fields f
left join public.water_points w on w.id = f.water_point_id
left join lateral (
  select r.version, r.status, r.answered_count, r.question_count, r.updated_at
  from public.questionnaire_responses r
  where r.field_id = f.id
  order by r.updated_at desc
  limit 1
) q on true;

revoke all on public.my_fields from anon;
grant select on public.my_fields to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Reference values (editable with an update in the SQL Editor)
-- ---------------------------------------------------------------------------
create table if not exists public.irrigation_parameters (
  key         text primary key check (key in (
                'electricity_eur_kwh', 'diesel_eur_l', 'pump_efficiency_electric',
                'pump_efficiency_diesel', 'diesel_kwh_per_l', 'head_drip_m', 'head_sprinkler_m',
                'head_reel_m', 'head_surface_m', 'surface_lift_m', 'level_some', 'level_full')),
  value       numeric not null check (value >= 0),
  unit        text not null,
  description text not null,
  source      text
);

insert into public.irrigation_parameters (key, value, unit, description, source) values
  ('electricity_eur_kwh', 0.11, '€/kWh', 'Price of agricultural electricity',
   'ΓΑΙΑ agricultural tariff (ΔΕΗ): 9.3–11 c/kWh in its first two years. Change it to your tariff.'),
  ('diesel_eur_l', 1.20, '€/l', 'Price of diesel for the pump, after the farmers'' excise refund',
   'Approximate; change it to the current price. A price given by the farmer always wins.'),
  ('pump_efficiency_electric', 0.50, 'ratio', 'Electric submersible pump with its motor: share of the electricity that lifts water (wire to water)',
   'Typical 0.45–0.60 for agricultural borehole pumps'),
  ('pump_efficiency_diesel', 0.65, 'ratio', 'Pump driven by a diesel engine or tractor: share of the shaft energy that lifts water',
   'Typical centrifugal pump efficiency'),
  ('diesel_kwh_per_l', 3.0, 'kWh/l', 'Shaft energy from one litre of diesel',
   'About 10 kWh in a litre × about 30% engine efficiency'),
  ('head_drip_m', 20, 'm', 'Pressure at the pump for drip (about 2 bar, with filters and pipes)', 'Typical design value'),
  ('head_sprinkler_m', 35, 'm', 'Pressure at the pump for sprinklers (about 3.5 bar)', 'Typical design value'),
  ('head_reel_m', 70, 'm', 'Pressure at the pump for a reel with a big gun (καρούλι, about 7 bar)', 'Typical design value'),
  ('head_surface_m', 5, 'm', 'Furrow or flood: water only needs to reach the field', 'Typical design value'),
  ('surface_lift_m', 5, 'm', 'Lift from a river, lake or channel to the pump', 'Typical value'),
  ('level_some', 0.5, 'ratio', 'Share of the full irrigation for "A few times" / limited supply', 'Assumption'),
  ('level_full', 1.0, 'ratio', 'Share of the full irrigation for "All season" / full supply', 'Assumption')
on conflict (key) do nothing;

alter table public.irrigation_parameters enable row level security;
drop policy if exists "irrigation_parameters_read" on public.irrigation_parameters;
create policy "irrigation_parameters_read" on public.irrigation_parameters for select using (true);

-- Water applied in a fully irrigated season, in mm (= m³ per stremma), lowland and coastal Greece,
-- and the usual method. Starting values to calibrate; crops usually grown rainfed get the water of
-- one or two supplementary irrigations.
create table if not exists public.crop_irrigation_baselines (
  crop_id        text primary key references public.crops (id) on delete cascade,
  full_mm        numeric not null check (full_mm >= 0 and full_mm <= 3000),
  typical_method text not null check (typical_method in ('drip', 'sprinkler', 'reel', 'surface')),
  source         text
);

insert into public.crop_irrigation_baselines (crop_id, full_mm, typical_method, source)
select v.crop_id, v.full_mm, v.method, 'Starting value; calibrate with your data'
from (values
  ('cotton',      500, 'drip'),
  ('maize',       600, 'sprinkler'),
  ('rice',       1500, 'surface'),
  ('sunflower',   250, 'sprinkler'),
  ('alfalfa',     800, 'sprinkler'),
  ('wheat_durum',  80, 'sprinkler'),
  ('wheat_soft',   80, 'sprinkler'),
  ('barley',       60, 'sprinkler'),
  ('oat',          60, 'sprinkler'),
  ('vetch',        60, 'sprinkler'),
  ('vetch_oat',    60, 'sprinkler'),
  ('chickpea',    100, 'sprinkler'),
  ('lentil',       60, 'sprinkler'),
  ('faba_bean',   100, 'sprinkler'),
  ('fallow',        0, 'sprinkler')
) as v(crop_id, full_mm, method)
where exists (select 1 from public.crops c where c.id = v.crop_id)
on conflict (crop_id) do nothing;
-- 'other' has no baseline: its water can only be reported

alter table public.crop_irrigation_baselines enable row level security;
drop policy if exists "crop_irrigation_baselines_read" on public.crop_irrigation_baselines;
create policy "crop_irrigation_baselines_read" on public.crop_irrigation_baselines for select using (true);

-- ---------------------------------------------------------------------------
-- 3. Irrigation of a season
-- ---------------------------------------------------------------------------
-- source             borehole (own borehole or dug well), surface (river, lake, channel, with own
--                    pump), network (collective network, ΤΟΕΒ / ΓΟΕΒ), none (not irrigated)
-- power              electric or diesel (a tractor-driven pump counts as diesel); borehole and
--                    surface only
-- method             drip, sprinkler, reel (καρούλι), surface (furrow or flood)
-- water_m3           water used on this field this season, m³ (water meter); or
-- pump_hours, pump_flow_m3h   pumping hours for this field × pump flow
-- electric_bill_eur  electricity bills of the season for the pump's meter (€), or
-- electric_kwh       their kWh; meter_share_pct: the share of that meter for this field
--                    (empty = 100: the meter serves only this field)
-- diesel_l           diesel used for this field's irrigation; diesel_price_eur_l its price
-- network_fee_eur_ha network fee, € per ha (the app asks per stremma)
-- consumables_eur_ha drip lines and other parts replaced this season, € per ha
create table if not exists public.season_irrigation (
  season_id          bigint primary key references public.crop_history (id) on delete cascade,
  source             text not null check (source in ('borehole', 'surface', 'network', 'none')),
  power              text check (power in ('electric', 'diesel')),
  method             text check (method in ('drip', 'sprinkler', 'reel', 'surface')),
  water_m3           numeric check (water_m3 >= 0 and water_m3 <= 10000000),
  pump_hours         numeric check (pump_hours >= 0 and pump_hours <= 5000),
  pump_flow_m3h      numeric check (pump_flow_m3h > 0 and pump_flow_m3h <= 2000),
  electric_bill_eur  numeric check (electric_bill_eur >= 0 and electric_bill_eur <= 1000000),
  electric_kwh       numeric check (electric_kwh >= 0 and electric_kwh <= 10000000),
  meter_share_pct    numeric check (meter_share_pct > 0 and meter_share_pct <= 100),
  diesel_l           numeric check (diesel_l >= 0 and diesel_l <= 1000000),
  diesel_price_eur_l numeric check (diesel_price_eur_l >= 0 and diesel_price_eur_l <= 5),
  network_fee_eur_ha numeric check (network_fee_eur_ha >= 0 and network_fee_eur_ha <= 5000),
  consumables_eur_ha numeric check (consumables_eur_ha >= 0 and consumables_eur_ha <= 5000),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint season_irrigation_power_source_check check ((power is not null) = (source in ('borehole', 'surface'))),
  constraint season_irrigation_none_check check (
    source <> 'none' or num_nonnulls(method, water_m3, pump_hours, pump_flow_m3h, electric_bill_eur,
                                     electric_kwh, meter_share_pct, diesel_l, diesel_price_eur_l,
                                     network_fee_eur_ha, consumables_eur_ha) = 0),
  constraint season_irrigation_electric_check check (
    power = 'electric' or num_nonnulls(electric_bill_eur, electric_kwh, meter_share_pct) = 0),
  constraint season_irrigation_diesel_check check (
    power = 'diesel' or num_nonnulls(diesel_l, diesel_price_eur_l) = 0),
  constraint season_irrigation_network_check check (source = 'network' or network_fee_eur_ha is null)
);

alter table public.season_irrigation enable row level security;
drop policy if exists "season_irrigation_own" on public.season_irrigation;
create policy "season_irrigation_own" on public.season_irrigation
  for all to authenticated
  using (exists (
    select 1 from public.crop_history h
    join public.fields f on f.id = h.field_id
    where h.id = season_irrigation.season_id and f.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.crop_history h
    join public.fields f on f.id = h.field_id
    where h.id = season_irrigation.season_id and f.user_id = (select auth.uid())
  ));
revoke all on public.season_irrigation from anon;

-- ---------------------------------------------------------------------------
-- 4. save_season: + p_irrigation
-- ---------------------------------------------------------------------------
-- p_irrigation: { source, power, method, water_m3, pump_hours, pump_flow_m3h, electric_bill_eur,
--                 electric_kwh, meter_share_pct, diesel_l, diesel_price_eur_l, network_fee_eur_ha,
--                 consumables_eur_ha }
--   null (the default) leaves the irrigation as it is, so a browser with the previous version of
--   the app never deletes it. Everything else is exactly as in 20261105.
-- The 7-argument version is dropped so the API never has two to choose between.
drop function if exists public.save_season(uuid, jsonb, jsonb, bigint, jsonb, jsonb, jsonb);

create or replace function public.save_season(
  p_field_id     uuid,
  p_season       jsonb,
  p_applications jsonb default '[]'::jsonb,
  p_id           bigint default null,
  p_protections  jsonb default null,
  p_income       jsonb default null,
  p_seeds        jsonb default null,
  p_irrigation   jsonb default null
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

  -- Irrigation: one row per season, replaced as a whole, only when the caller sends it.
  -- Figures that do not fit the water source are dropped (an electricity bill for a network
  -- field, diesel for an electric pump...), so the row always describes one consistent setup.
  if p_irrigation is not null then
    insert into public.season_irrigation as si (
      season_id, source, power, method, water_m3, pump_hours, pump_flow_m3h,
      electric_bill_eur, electric_kwh, meter_share_pct, diesel_l, diesel_price_eur_l,
      network_fee_eur_ha, consumables_eur_ha
    )
    select
      v_id, d.source, d.power,
      case when d.source <> 'none' then nullif(p_irrigation ->> 'method', '') end,
      case when d.source <> 'none' then nullif(p_irrigation ->> 'water_m3', '')::numeric end,
      case when d.source <> 'none' then nullif(p_irrigation ->> 'pump_hours', '')::numeric end,
      case when d.source <> 'none' then nullif(p_irrigation ->> 'pump_flow_m3h', '')::numeric end,
      case when d.power = 'electric' then nullif(p_irrigation ->> 'electric_bill_eur', '')::numeric end,
      case when d.power = 'electric' then nullif(p_irrigation ->> 'electric_kwh', '')::numeric end,
      case when d.power = 'electric' then nullif(p_irrigation ->> 'meter_share_pct', '')::numeric end,
      case when d.power = 'diesel' then nullif(p_irrigation ->> 'diesel_l', '')::numeric end,
      case when d.power = 'diesel' then nullif(p_irrigation ->> 'diesel_price_eur_l', '')::numeric end,
      case when d.source = 'network' then nullif(p_irrigation ->> 'network_fee_eur_ha', '')::numeric end,
      case when d.source <> 'none' then nullif(p_irrigation ->> 'consumables_eur_ha', '')::numeric end
    from (
      select s.source,
             case when s.source in ('borehole', 'surface')
                  then coalesce(nullif(p_irrigation ->> 'power', ''), 'electric') end as power
      from (select coalesce(nullif(p_irrigation ->> 'source', ''), 'none') as source) s
    ) d
    on conflict (season_id) do update set
      source             = excluded.source,
      power              = excluded.power,
      method             = excluded.method,
      water_m3           = excluded.water_m3,
      pump_hours         = excluded.pump_hours,
      pump_flow_m3h      = excluded.pump_flow_m3h,
      electric_bill_eur  = excluded.electric_bill_eur,
      electric_kwh       = excluded.electric_kwh,
      meter_share_pct    = excluded.meter_share_pct,
      diesel_l           = excluded.diesel_l,
      diesel_price_eur_l = excluded.diesel_price_eur_l,
      network_fee_eur_ha = excluded.network_fee_eur_ha,
      consumables_eur_ha = excluded.consumables_eur_ha,
      updated_at         = now();
  end if;

  return v_id;
end;
$$;

revoke execute on function public.save_season(uuid, jsonb, jsonb, bigint, jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.save_season(uuid, jsonb, jsonb, bigint, jsonb, jsonb, jsonb, jsonb) to authenticated;
-- ---------------------------------------------------------------------------
-- 5. season_irrigation_costs: the calculation, one row per season (all units per hectare)
-- ---------------------------------------------------------------------------
--   source, power, method   as recorded; with no record: a borehole when the field has a water
--                           point and is not rainfed, an electric pump, the crop's usual method
--   level                   0, 0.5 or 1 (see the top of the file)
--   water_m3_ha, water_basis      reported | estimated
--   lift_m, lift_basis            pump_depth | borehole_depth (upper bound) | default (surface)
--   pressure_m, head_m
--   energy_kwh_ha / diesel_l_ha   pumping energy (reported or estimated)
--   energy_eur_ha, energy_basis   reported | estimated | unknown (needed but cannot be worked out)
--   *_line                        whether season_cost_lines shows that part
--   irrigation_basis              not_irrigated | ongoing | unknown_source | no_reference |
--                                 estimated | estimated_from_volume | reported
create or replace view public.season_irrigation_costs
with (security_invoker = true)
as
with p as (
  select
    max(value) filter (where key = 'electricity_eur_kwh')      as el_price,
    max(value) filter (where key = 'diesel_eur_l')             as diesel_price,
    max(value) filter (where key = 'pump_efficiency_electric') as eff_el,
    max(value) filter (where key = 'pump_efficiency_diesel')   as eff_diesel,
    max(value) filter (where key = 'diesel_kwh_per_l')         as diesel_kwh_l,
    max(value) filter (where key = 'head_drip_m')              as head_drip,
    max(value) filter (where key = 'head_sprinkler_m')         as head_sprinkler,
    max(value) filter (where key = 'head_reel_m')              as head_reel,
    max(value) filter (where key = 'head_surface_m')           as head_surface,
    max(value) filter (where key = 'surface_lift_m')           as surface_lift,
    max(value) filter (where key = 'level_some')               as level_some,
    max(value) filter (where key = 'level_full')               as level_full
  from public.irrigation_parameters
),
s as (
  select
    h.id as season_id, h.field_id, f.area_ha,
    (h.sown_on is not null and h.harvested_on is null)                         as ongoing,
    coalesce(i.source,
             case when f.water_point_id is not null and f.irrigation <> 'rainfed' then 'borehole' end) as source,
    i.power                                                                    as rec_power,
    coalesce(i.method, b.typical_method)                                       as method,
    i.water_m3, i.pump_hours, i.pump_flow_m3h, i.electric_bill_eur, i.electric_kwh,
    coalesce(i.meter_share_pct, 100) / 100.0                                   as share,
    i.diesel_l, i.diesel_price_eur_l, i.network_fee_eur_ha, i.consumables_eur_ha,
    f.well_depth_m, f.pump_depth_m,
    b.full_mm,
    case coalesce(nullif(h.irrigation, 'unknown'),
                  case f.irrigation when 'rainfed' then 'none' when 'limited' then 'some' else 'full' end)
      when 'none' then 0::numeric
      when 'some' then p.level_some
      else p.level_full
    end                                                                        as level,
    p.el_price, p.diesel_price, p.eff_el, p.eff_diesel, p.diesel_kwh_l,
    p.head_drip, p.head_sprinkler, p.head_reel, p.head_surface, p.surface_lift
  from public.crop_history h
  join public.fields f on f.id = h.field_id
  left join public.season_irrigation i          on i.season_id = h.id
  left join public.crop_irrigation_baselines b  on b.crop_id = h.crop_id
  cross join p
),
w as (
  select s.*,
    case when s.source in ('borehole', 'surface') then coalesce(s.rec_power, 'electric') end as power,
    case when s.area_ha > 0 then coalesce(s.water_m3, s.pump_hours * s.pump_flow_m3h) / s.area_ha end as water_rep_ha,
    case when not s.ongoing and s.full_mm is not null then s.full_mm * s.level * 10 end            as water_est_ha,
    case s.source
      when 'borehole' then coalesce(s.pump_depth_m, s.well_depth_m)
      when 'surface'  then s.surface_lift
      when 'network'  then 0
    end                                                                        as lift_m,
    case s.source
      when 'borehole' then case when s.pump_depth_m is not null then 'pump_depth'
                                when s.well_depth_m is not null then 'borehole_depth' end
      when 'surface'  then 'default'
    end                                                                        as lift_basis,
    case s.method
      when 'drip'      then s.head_drip
      when 'sprinkler' then s.head_sprinkler
      when 'reel'      then s.head_reel
      when 'surface'   then s.head_surface
    end                                                                        as pressure_m
  from s
),
e as (
  select w.*,
    case when w.source = 'none' then 0 else coalesce(w.water_rep_ha, w.water_est_ha) end as water_ha,
    case when w.source = 'none' then null
         when w.water_rep_ha is not null then 'reported'
         when w.water_est_ha is not null then 'estimated' end                   as water_basis,
    case when w.source in ('borehole', 'surface') then w.lift_m + w.pressure_m end as head_m,
    case when w.power = 'electric' and w.area_ha > 0
         then coalesce(w.electric_bill_eur * w.share, w.electric_kwh * w.share * w.el_price) / w.area_ha end as el_rep_eur_ha,
    case when w.power = 'electric' and w.area_ha > 0
         then w.electric_kwh * w.share / w.area_ha end                          as el_rep_kwh_ha,
    case when w.power = 'diesel' and w.area_ha > 0 then w.diesel_l / w.area_ha end as diesel_rep_l_ha,
    coalesce(w.diesel_price_eur_l, w.diesel_price)                              as diesel_unit_price
  from w
),
x as (
  select e.*,
    -- hydraulic energy, kWh per ha = 9.81 / 3600 × head (m) × water (m³/ha)
    9.81 / 3600 * e.head_m * e.water_ha                                         as hyd_kwh_ha,
    (e.el_rep_eur_ha is not null or e.diesel_rep_l_ha is not null)               as energy_reported
  from e
),
y as (
  select x.*,
    case x.power
      when 'electric' then coalesce(x.el_rep_kwh_ha, case when x.el_rep_eur_ha is null then x.hyd_kwh_ha / x.eff_el end)
    end                                                                          as kwh_ha,
    case x.power
      when 'diesel' then coalesce(x.diesel_rep_l_ha, x.hyd_kwh_ha / (x.eff_diesel * x.diesel_kwh_l))
    end                                                                          as l_ha,
    -- energy is a cost line when it was reported, or when water was used and must be pumped
    -- (or the source is unknown)
    ((x.power is not null and (x.energy_reported or coalesce(x.water_ha, 0) > 0))
      or (x.source is null and coalesce(x.water_ha, 0) > 0))                     as energy_line,
    (x.source = 'network' and (x.network_fee_eur_ha is not null or coalesce(x.water_ha, 0) > 0)) as network_line,
    (x.consumables_eur_ha is not null)                                           as consumables_line
  from x
),
z as (
  select y.*,
    case y.power
      when 'electric' then coalesce(y.el_rep_eur_ha, y.kwh_ha * y.el_price)
      when 'diesel'   then y.l_ha * y.diesel_unit_price
    end                                                                          as energy_cost
  from y
)
select
  z.season_id,
  z.field_id,
  z.source,
  z.power,
  z.method,
  z.level,
  round(z.water_ha, 1)                                                          as water_m3_ha,
  z.water_basis,
  z.lift_m,
  z.lift_basis,
  z.pressure_m,
  z.head_m,
  round(z.kwh_ha, 1)                                                            as energy_kwh_ha,
  round(z.l_ha, 1)                                                              as diesel_l_ha,
  z.energy_line,
  case when not z.energy_line then null
       when z.energy_cost is null then 'unknown'
       when z.energy_reported then 'reported'
       else 'estimated' end                                                     as energy_basis,
  case z.power when 'electric' then z.kwh_ha when 'diesel' then z.l_ha end      as energy_quantity_ha,
  case z.power when 'electric' then 'kWh' when 'diesel' then 'l' end            as energy_unit,
  case when z.power = 'electric' and z.el_rep_eur_ha is not null and z.el_rep_kwh_ha is null then null
       when z.power = 'electric' then z.el_price
       when z.power = 'diesel' then z.diesel_unit_price end                     as energy_unit_price,
  case when z.energy_line then z.energy_cost end                                as energy_eur_ha,
  z.network_line,
  z.network_fee_eur_ha,
  z.consumables_line,
  z.consumables_eur_ha,
  case
    when z.source = 'none' then 'not_irrigated'
    when not (z.energy_line or z.network_line or z.consumables_line)
      then case when z.ongoing then 'ongoing' else 'not_irrigated' end
    when z.source is null then 'unknown_source'
    when (z.energy_line and z.energy_cost is null) or (z.network_line and z.network_fee_eur_ha is null) then 'no_reference'
    when z.energy_line and not z.energy_reported
      then case when z.water_basis = 'reported' then 'estimated_from_volume' else 'estimated' end
    else 'reported'
  end                                                                           as irrigation_basis
from z;

revoke all on public.season_irrigation_costs from public, anon;
grant select on public.season_irrigation_costs to authenticated;

-- ---------------------------------------------------------------------------
-- 6. season_cost_lines: + irrigation; + last column estimated (columns otherwise unchanged)
-- ---------------------------------------------------------------------------
create or replace view public.season_cost_lines
with (security_invoker = true)
as
select h.id as season_id, h.field_id, 'fertilizer'::text as category,
       a.id as line_id, a.product_name as item, a.applied_on,
       a.rate_kg_ha as quantity_ha, 'kg'::text as unit, a.price_eur_kg as unit_price_eur,
       round(a.rate_kg_ha * a.price_eur_kg, 2) as cost_eur_ha,
       'fertilizer_applications'::text as source_table,
       false as estimated
from public.fertilizer_applications a
join public.crop_history h on h.id = a.season_id
union all
select h.id, h.field_id, 'contract_work',
       a.id, a.product_name, a.applied_on,
       null, null, null,
       round(a.contractor_eur_ha, 2),
       'fertilizer_applications',
       false
from public.fertilizer_applications a
join public.crop_history h on h.id = a.season_id
where a.contractor
union all
select h.id, h.field_id, 'crop_protection',
       p.id, p.product_name, p.applied_on,
       p.dose_per_ha, p.unit, p.price_eur_unit,
       round(p.dose_per_ha * p.price_eur_unit, 2),
       'protection_applications',
       false
from public.protection_applications p
join public.crop_history h on h.id = p.season_id
union all
select h.id, h.field_id, 'contract_work',
       p.id, p.product_name, p.applied_on,
       null, null, null,
       round(p.contractor_eur_ha, 2),
       'protection_applications',
       false
from public.protection_applications p
join public.crop_history h on h.id = p.season_id
where p.contractor
union all
select h.id, h.field_id, 'seed',
       s.id, coalesce(s.variety_name, s.crop_id), s.sown_on,
       s.rate_kg_ha, 'kg', s.price_eur_kg,
       round(s.rate_kg_ha * s.price_eur_kg, 2),
       'seed_applications',
       false
from public.seed_applications s
join public.crop_history h on h.id = s.season_id
union all
select h.id, h.field_id, 'contract_work',
       s.id, coalesce(s.variety_name, s.crop_id), s.sown_on,
       null, null, null,
       round(s.contractor_eur_ha, 2),
       'seed_applications',
       false
from public.seed_applications s
join public.crop_history h on h.id = s.season_id
where s.contractor
union all
-- Irrigation (from season_irrigation_costs): pumping energy, network fee, consumables.
-- line_id is the season id (one irrigation record per season); item says which part.
select c.season_id, c.field_id, 'irrigation',
       c.season_id, x.item, null::date,
       x.quantity_ha, x.unit, x.unit_price_eur,
       round(x.cost_eur_ha, 2),
       'season_irrigation',
       x.estimated
from public.season_irrigation_costs c
cross join lateral (values
  ('energy',      c.energy_line,      c.energy_quantity_ha, c.energy_unit, c.energy_unit_price, c.energy_eur_ha,      c.energy_basis = 'estimated'),
  ('network_fee', c.network_line,     null::numeric,        null::text,    null::numeric,       c.network_fee_eur_ha, false),
  ('consumables', c.consumables_line, null::numeric,        null::text,    null::numeric,       c.consumables_eur_ha, false)
) as x(item, included, quantity_ha, unit, unit_price_eur, cost_eur_ha, estimated)
where x.included;

-- ---------------------------------------------------------------------------
-- 7. season_finance: irrigation in the costs; irrigation columns appended (existing unchanged)
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
         sum(cost_eur_ha) filter (where category = 'irrigation')      as irrigation_eur_ha,
         bool_or(estimated)                                           as cost_estimated,
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
  se.certified_seed,
  -- Irrigation (columns added by 20261106)
  co.irrigation_eur_ha,
  ic.irrigation_basis,
  ic.source                                                  as irrigation_source,
  ic.power                                                   as irrigation_power,
  ic.method                                                  as irrigation_method,
  ic.water_m3_ha,
  round(ic.water_m3_ha / 10, 1)                              as water_m3_stremma,
  ic.water_basis,
  ic.lift_m                                                  as irrigation_lift_m,
  ic.lift_basis                                              as irrigation_lift_basis,
  ic.head_m                                                  as irrigation_head_m,
  ic.energy_kwh_ha                                           as irrigation_kwh_ha,
  ic.diesel_l_ha                                             as irrigation_diesel_l_ha,
  case when ic.water_m3_ha > 0 and q.main_kg is not null
       then round(q.main_kg / ic.water_m3_ha, 2) end         as kg_per_m3,
  coalesce(co.cost_estimated, false)                         as cost_estimated
from public.crop_history h
join public.fields f      on f.id = h.field_id
left join public.crops c  on c.id = h.crop_id
left join costs co        on co.season_id = h.id
left join nutrients nu    on nu.season_id = h.id
left join treatments tr   on tr.season_id = h.id
left join seeds se        on se.season_id = h.id
left join public.season_irrigation_costs ic on ic.season_id = h.id
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
-- 8. field_finance: irrigation columns appended (existing columns unchanged)
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
         round(avg(seed_eur_ha), 2)                                         as avg_seed_eur_ha,
         round(avg(irrigation_eur_ha), 2)                                   as avg_irrigation_eur_ha,
         round(sum(water_m3_ha * area_ha), 0)                               as total_water_m3_field,
         round(avg(water_m3_ha) filter (where water_m3_ha > 0), 0)          as avg_water_m3_ha
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
  pf.avg_seed_eur_ha,
  -- Irrigation (columns added by 20261106)
  pf.avg_irrigation_eur_ha,
  pf.total_water_m3_field,
  pf.avg_water_m3_ha
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
--   -- exactly one save_season, with 8 arguments
--   select pg_get_function_identity_arguments(oid) from pg_proc where proname = 'save_season';
--     -> ..., p_income jsonb, p_seeds jsonb, p_irrigation jsonb
--
--   -- the reference values (expect 12 and 15 rows)
--   select key, value, unit from public.irrigation_parameters order by key;
--   select crop_id, full_mm, typical_method from public.crop_irrigation_baselines order by crop_id;
--
--   -- irrigation per season: where every figure comes from
--   select h.crop_id, c.source, c.power, c.method, c.water_m3_ha, c.water_basis, c.lift_m,
--          c.lift_basis, c.head_m, c.energy_kwh_ha, c.diesel_l_ha, round(c.energy_eur_ha, 2) as energy_eur_ha,
--          c.energy_basis, c.irrigation_basis
--   from public.season_irrigation_costs c join public.crop_history h on h.id = c.season_id;
--
--   -- in the season totals
--   select field_name, crop_id, irrigation_eur_ha, water_m3_stremma, kg_per_m3, total_cost_eur_stremma,
--          margin_eur_stremma, cost_estimated
--   from public.season_finance order by field_name, sown_on desc nulls last;
--
--   -- to change a reference value, e.g. your electricity tariff:
--   --   update public.irrigation_parameters set value = 0.093 where key = 'electricity_eur_kwh';
-- ---------------------------------------------------------------------------