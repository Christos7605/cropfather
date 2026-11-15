-- 20261045_season_extra_cost.sql
-- Other costs of a crop season (rent, fuel, machinery) that the season log does not already ask for.
-- Stored per hectare on crop_history, added as a priced line so season_finance, field_finance and
-- model_data.seasons.costs.total_eur_ha include it. model_data also lists it as extra_eur_ha.
-- Empty stays null. The check cap is 20000 euros per hectare (2000 euros per stremma).
-- Run after 20261043. Idempotent. Replaces save_season, season_cost_lines and model_data.

begin;

alter table public.crop_history
  add column if not exists extra_cost_eur_ha numeric;

alter table public.crop_history
  drop constraint if exists crop_history_extra_cost_check;

alter table public.crop_history
  add constraint crop_history_extra_cost_check
  check (extra_cost_eur_ha is null or (extra_cost_eur_ha >= 0 and extra_cost_eur_ha <= 20000));

comment on column public.crop_history.extra_cost_eur_ha is
  'Other costs of this season, euros per hectare (rent, fuel, machinery). Null when the farmer left it empty.';

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
      tillage, residues, nitrogen, irrigation, yield_outcome, notes, source, extra_cost_eur_ha
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
      'farmer',
      case
        when nullif(p_season ->> 'extra_cost_eur_ha', '') is null then null
        else round((p_season ->> 'extra_cost_eur_ha')::numeric, 2)
      end
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
      notes         = left(nullif(btrim(p_season ->> 'notes'), ''), 500),
      extra_cost_eur_ha = case
        when nullif(p_season ->> 'extra_cost_eur_ha', '') is null then null
        else round((p_season ->> 'extra_cost_eur_ha')::numeric, 2)
      end
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
where x.included
union all
select h.id, h.field_id, 'other',
       h.id, 'extra', null::date,
       null::numeric, null::text, null::numeric,
       round(h.extra_cost_eur_ha, 2),
       'crop_history',
       false
from public.crop_history h
where h.extra_cost_eur_ha is not null and h.extra_cost_eur_ha > 0;

create or replace view public.model_data
with (security_invoker = true) as
select
  f.id      as field_id,
  f.user_id,
  (
    select jsonb_build_object(
      'version',        r.version,
      'status',         r.status,
      'answered_count', r.answered_count,
      'question_count', r.question_count,
      'answers',        r.answers,
      'updated_at',     r.updated_at,
      'submitted_at',   r.submitted_at
    )
    from public.farmer_questionnaire_responses r
    where r.user_id = f.user_id
    order by r.updated_at desc
    limit 1
  ) as farm_questionnaire,
  (
    select jsonb_build_object(
      'version',        r.version,
      'status',         r.status,
      'answered_count', r.answered_count,
      'question_count', r.question_count,
      'answers',        r.answers,
      'updated_at',     r.updated_at,
      'submitted_at',   r.submitted_at
    )
    from public.questionnaire_responses r
    where r.field_id = f.id
    order by r.updated_at desc
    limit 1
  ) as field_questionnaire,
  coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'season_id',     sf.season_id,
        'crop_id',       sf.crop_id,
        'crop_name_en',  sf.crop_name_en,
        'crop_name_el',  sf.crop_name_el,
        'season_year',   sf.season_year,
        'sown_on',       sf.sown_on,
        'harvested_on',  sf.harvested_on,
        'ongoing',       sf.ongoing,
        'tillage',       h.tillage,
        'residues',      h.residues,
        'nitrogen',      h.nitrogen,
        'irrigation',    sf.irrigation_level,
        'yield_outcome', sf.yield_outcome,
        'costs', jsonb_build_object(
          'fertilizer_eur_ha',      sf.fertilizer_eur_ha,
          'crop_protection_eur_ha', sf.crop_protection_eur_ha,
          'seed_eur_ha',            sf.seed_eur_ha,
          'contract_work_eur_ha',   sf.contract_work_eur_ha,
          'irrigation_eur_ha',      sf.irrigation_eur_ha,
          'extra_eur_ha',           h.extra_cost_eur_ha,
          'total_eur_ha',           sf.total_cost_eur_ha,
          'complete',               sf.cost_complete,
          'estimated',              sf.cost_estimated
        ),
        'income', jsonb_build_object(
          'disclosed',        sf.income_disclosed,
          'yield_kg_ha',      sf.reported_main_kg_ha,
          'price_eur_kg',     sf.reported_main_price_eur_kg,
          'straw_kg_ha',      sf.straw_kg_ha,
          'straw_price_eur_kg', sf.straw_price_eur_kg,
          'subsidy_eur_ha',   sf.subsidy_eur_ha,
          'other_eur_ha',     sf.other_income_eur_ha,
          'revenue_eur_ha',   sf.revenue_eur_ha,
          'revenue_basis',    sf.revenue_basis,
          'margin_eur_ha',    sf.margin_eur_ha
        )
      )
      order by sf.sown_on nulls last, sf.season_id
    )
    from public.season_finance sf
    join public.crop_history h on h.id = sf.season_id
    where sf.field_id = f.id
  ), '[]'::jsonb) as seasons,
  jsonb_build_object(
    'features', jsonb_build_array(jsonb_build_object(
      'coords', coalesce((
        select jsonb_agg(
          jsonb_build_array(
            round(st_x(pt.geom)::numeric, 7),
            round(st_y(pt.geom)::numeric, 7)
          )
          order by pt.path[1]
        )
        from st_dumppoints(st_exteriorring(f.geom)) as pt
        where pt.path[1] < st_npoints(st_exteriorring(f.geom))
      ), '[]'::jsonb)
    )),
    'start', '2023-07-01',
    'end', coalesce(to_char(f.prediction_requested_on, 'YYYY-MM-DD'), '2023-07-31'),
    'max_cloud', 15
  ) as coords
from public.fields f;

revoke all on public.model_data from public, anon;
grant select on public.model_data to authenticated;

commit;
