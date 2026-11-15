-- 20261103_fertilizer_contractor.sql
-- Field Shift: "Who did the work?" for fertilisers too, as for plant protection.
--
--   fertilizer_applications   + contractor: true when a contractor or hired worker spread it
--                             + contractor_eur_ha: what that work cost per hectare (only with
--                               contractor; the app asks per stremma)
--   save_season(...)          same 5 arguments; now also saves the two new fertiliser fields
--   season_cost_lines (view)  contract_work now includes fertiliser work; new last column
--                               source_table tells which table a line comes from (line ids are
--                               unique only within their table)
--   season_finance (view)     contractor_count counts fertiliser and plant protection jobs.
--                               contract_work_eur_ha and the totals include fertiliser work
--                               through season_cost_lines. Columns unchanged.
--   field_finance (view)      unchanged (reads season_finance)
--
-- Run after 20261102_crop_protection_costs.sql. Runs in one transaction. Idempotent: safe to run
-- more than once. Existing fertilisers get contractor = false (done by the farmer).

begin;

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
alter table public.fertilizer_applications add column if not exists contractor boolean not null default false;
alter table public.fertilizer_applications add column if not exists contractor_eur_ha numeric;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fertilizer_applications_fee_check') then
    alter table public.fertilizer_applications add constraint fertilizer_applications_fee_check check (
      (contractor_eur_ha is null or (contractor_eur_ha >= 0 and contractor_eur_ha <= 1000))
      and (contractor or contractor_eur_ha is null)
    );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. save_season: the fertilisers now carry contractor and contractor_eur_ha
-- ---------------------------------------------------------------------------
-- p_applications: [ { ..., contractor, contractor_eur_ha } ]  (both optional: a request without
--   them, from a browser that still has the previous version of the app, saves "done by the
--   farmer"). Everything else is exactly as in 20261102.
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

  return v_id;
end;
$$;

revoke execute on function public.save_season(uuid, jsonb, jsonb, bigint, jsonb) from public, anon;
grant execute on function public.save_season(uuid, jsonb, jsonb, bigint, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. season_cost_lines: fertiliser work joins contract_work; source_table added at the end
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
where p.contractor;

-- ---------------------------------------------------------------------------
-- 4. season_finance: contractor_count over both tables (same columns as before)
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

revoke all on public.season_cost_lines, public.season_finance, public.field_finance from public, anon;
grant select on public.season_cost_lines, public.season_finance, public.field_finance to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- Verification (run manually):
--   -- the two new columns (expect 2 rows)
--   select column_name, data_type, column_default from information_schema.columns
--   where table_schema = 'public' and table_name = 'fertilizer_applications'
--     and column_name in ('contractor', 'contractor_eur_ha');
--
--   -- still exactly one save_season, with 5 arguments
--   select pg_get_function_identity_arguments(oid) from pg_proc where proname = 'save_season';
--
--   -- contract work by table
--   select source_table, count(*), sum(cost_eur_ha) from public.season_cost_lines
--   where category = 'contract_work' group by 1;
-- ---------------------------------------------------------------------------