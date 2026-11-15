-- 20261042_policy_read.sql
-- Field Shift: one way to READ the policy and economic data, for the recommendation model (an
-- LLM that calls the database) and for the app. The tables stay as they are; this file only adds
-- the reading side, so that nobody has to rebuild the joins and rules in a prompt.
--
--   crop_group_closure (view)   every crop with every group it belongs to, directly or through
--                               the group tree. 'all' holds every crop.
--   scheme_closure (view)       every scheme with itself and its ancestors (31.1-4 -> 31.1-Α -> 31.1).
--   crop_constraints (view)     one row per crop and constraint that applies today. The rule of
--                               data/policy/README.md, which no view applied until now:
--                                 1. conditionality (ΚΓΠΚ): always, for the crops it names
--                                 2. any other constraint: only as a condition of a subsidy the
--                                    crop gets, on the same scheme or below it. The subsidies it
--                                    conditions are in subsidy_provision_ids.
--   provision_in_region()       whether a provision applies in a region: it is linked to the
--                               region or to one above it (a provision for 'gr' holds in every
--                               regional unit), and not excluded there.
--   crop_policy()               everything about ONE crop in one region, as one JSON document:
--                               subsidies with their conditions, conditionality, sources (ΦΕΚ).
--                               With the previous crop of the field, Π1-31.1 is resolved.
--   crop_comparison()           the 15 crops side by side, from crop_economics, as one JSON
--                               document, with the notes needed to read it correctly. Mock
--                               prices and yields are left out. With the expected yield of each
--                               crop at the field's salinity (from the salinity model), revenue
--                               is scaled to it.
--   my_season_costs()           the calling farmer's own seasons: what they recorded as costs,
--                               yield and price. Only reported figures, no estimates.
--
-- The three functions are what the model calls (supabase.rpc). Everything in them comes from the
-- tables: no amount or rule is written here.
--
-- Run after 20261041_crop_economics.sql; the seed can be loaded before or after. Do not re-run
-- 20261039_drop_review_status.sql after this file (it drops crop_subsidies, which the views here
-- read). Runs in one transaction. Idempotent: safe to run more than once.

begin;

-- ---------------------------------------------------------------------------
-- 1. Closures of the two trees
-- ---------------------------------------------------------------------------
create or replace view public.crop_group_closure
with (security_invoker = true) as
with recursive t as (
  select m.crop_id, m.group_id, 0 as depth
  from public.crop_group_members m
  union
  select t.crop_id, g.parent_id, t.depth + 1
  from t
  join public.crop_groups g on g.id = t.group_id
  where g.parent_id is not null and t.depth < 20
)
select crop_id, group_id, min(depth) as depth
from t
group by crop_id, group_id
union all
-- 'all' is the root: it holds every crop, also those in no group (e.g. fallow)
select c.id, 'all', 1000
from public.crops c
where not exists (select 1 from t where t.crop_id = c.id and t.group_id = 'all');

create or replace view public.scheme_closure
with (security_invoker = true) as
with recursive t as (
  select s.id as scheme_id, s.id as ancestor_id, 0 as depth
  from public.schemes s
  union
  select t.scheme_id, p.parent_id, t.depth + 1
  from t
  join public.schemes p on p.id = t.ancestor_id
  where p.parent_id is not null and t.depth < 20
)
select scheme_id, ancestor_id, depth from t;

-- ---------------------------------------------------------------------------
-- 2. crop_constraints
-- ---------------------------------------------------------------------------
-- applies_when:
--   'always'        conditionality: holds whatever support is claimed
--   'with_subsidy'  a condition of the subsidies in subsidy_provision_ids (crop_subsidies):
--                   it matters only if the farmer claims one of them
-- A constraint of a scheme the crop gets no subsidy from is not listed (e.g. the maize
-- conditions for wheat, although both are on Π1-32.1).
create or replace view public.crop_constraints
with (security_invoker = true) as
with current_constraints as (
  select p.id as provision_id, p.scheme_code, p.statement_el, p.valid_from, p.valid_to,
         p.source_ref, p.source_url
  from public.provisions p
  where p.provision_type = 'constraint'
    and p.superseded_by is null
    and (p.valid_from is null or p.valid_from <= current_date)
    and (p.valid_to   is null or p.valid_to   >= current_date)
),
matches as (
  -- constraint that names the crop itself
  select cc.provision_id, pc.crop_id as target_crop_id, null::text as via_group_id, -1 as depth
  from current_constraints cc
  join public.provision_crops pc
    on pc.provision_id = cc.provision_id and pc.role = 'applies_to' and pc.crop_id is not null
  union all
  -- constraint written for a group: every crop in it
  select cc.provision_id, g.crop_id, pc.crop_group_id, g.depth
  from current_constraints cc
  join public.provision_crops pc
    on pc.provision_id = cc.provision_id and pc.role = 'applies_to' and pc.crop_group_id is not null
  join public.crop_group_closure g on g.group_id = pc.crop_group_id
),
kept as (
  select m.*,
         row_number() over (partition by m.target_crop_id, m.provision_id order by m.depth) as rn
  from matches m
  where not exists (
    select 1 from public.provision_crops x
    where x.provision_id = m.provision_id
      and x.role = 'excluded'
      and (x.crop_id = m.target_crop_id
           or x.crop_group_id in (select g.group_id from public.crop_group_closure g
                                  where g.crop_id = m.target_crop_id))
  )
),
linked as (
  select k.target_crop_id, k.provision_id, k.via_group_id,
         -- the subsidies of this crop that the constraint conditions: same scheme or below it
         array(select cs.provision_id
               from public.crop_subsidies cs
               join public.scheme_closure sc on sc.scheme_id = cs.scheme_code
               where cs.crop_id = k.target_crop_id
                 and sc.ancestor_id = cc.scheme_code
               order by cs.provision_id) as subsidy_provision_ids
  from kept k
  join current_constraints cc on cc.provision_id = k.provision_id
  where k.rn = 1
)
select l.target_crop_id                 as crop_id,
       c.name_el                        as crop_name_el,
       l.provision_id,
       cc.scheme_code,
       s.kind                           as scheme_kind,
       s.name_el                        as scheme_name_el,
       l.via_group_id,
       case when s.kind = 'conditionality' then 'always' else 'with_subsidy' end as applies_when,
       l.subsidy_provision_ids,
       d.constraint_kind,
       d.parameter,
       d.operator,
       d.value_num,
       d.value_num_max,
       d.value_text,
       d.unit,
       array(select x.crop_id from public.provision_crops x
             where x.provision_id = l.provision_id and x.role = 'replaces' and x.crop_id is not null
             order by x.crop_id)        as replaces_crop_ids,
       cc.valid_from,
       cc.valid_to,
       cc.statement_el,
       cc.source_ref,
       cc.source_url
from linked l
join current_constraints cc        on cc.provision_id = l.provision_id
join public.crops c                on c.id = l.target_crop_id
join public.constraint_details d   on d.provision_id = l.provision_id
left join public.schemes s         on s.id = cc.scheme_code
where s.kind = 'conditionality'
   or cardinality(l.subsidy_provision_ids) > 0;

-- ---------------------------------------------------------------------------
-- 3. Regions
-- ---------------------------------------------------------------------------
create or replace function public.provision_in_region(p_provision_id bigint, p_region_id text)
returns boolean
language sql
stable
set search_path = public
as $$
  with recursive up as (
    select r.id, r.parent_id, 0 as depth
    from public.regions r
    where r.id = p_region_id
    union all
    select r.id, r.parent_id, up.depth + 1
    from public.regions r
    join up on r.id = up.parent_id
    where up.depth < 20
  )
  select exists (select 1 from public.provision_regions pr
                 join up on up.id = pr.region_id
                 where pr.provision_id = p_provision_id and pr.role = 'applies_to')
     and not exists (select 1 from public.provision_regions pr
                     join up on up.id = pr.region_id
                     where pr.provision_id = p_provision_id and pr.role = 'excluded');
$$;

-- ---------------------------------------------------------------------------
-- 4. crop_policy: one crop, one region, one JSON document
-- ---------------------------------------------------------------------------
-- One constraint as JSON, with the practices it requires, allows or forbids.
create or replace function public.crop_constraint_json(r public.crop_constraints)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'provision_id',           r.provision_id,
    'scheme_code',            r.scheme_code,
    'scheme_name_el',         r.scheme_name_el,
    'constraint_kind',        r.constraint_kind,
    'parameter',              r.parameter,
    'operator',               r.operator,
    'value_num',              r.value_num,
    'value_num_max',          r.value_num_max,
    'value_text',             r.value_text,
    'unit',                   r.unit,
    'requires_previous_crop', case when cardinality(r.replaces_crop_ids) > 0
                                   then to_jsonb(r.replaces_crop_ids) end,
    'practices',              (select jsonb_agg(jsonb_build_object(
                                         'practice_id', pp.practice_id,
                                         'name_el',     pr.name_el,
                                         'role',        pp.role)
                                       order by pp.role, pp.practice_id)
                               from public.provision_practices pp
                               join public.practices pr on pr.id = pp.practice_id
                               where pp.provision_id = r.provision_id),
    'valid_from',             r.valid_from,
    'valid_to',               r.valid_to,
    'statement_el',           r.statement_el,
    'source_ref',             r.source_ref,
    'source_url',             r.source_url);
$$;

-- p_previous_crop_id: what the field grew the year before. Π1-31.1 is paid only for some
-- changes; with it, each such subsidy gets applies = 'yes' or 'no'. Without it:
-- 'depends_on_previous_crop'.
-- Empty keys are left out of the result (jsonb_strip_nulls): a missing key means "no value".
create or replace function public.crop_policy(
  p_crop_id          text,
  p_region_id        text default 'gr',
  p_previous_crop_id text default null
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_crop     jsonb;
  v_region   jsonb;
  v_subs     jsonb;
  v_cond     jsonb;
  v_totals   jsonb;
begin
  select jsonb_build_object(
           'id', c.id, 'name_el', c.name_el, 'name_en', c.name_en, 'genus', c.genus,
           'n_fixer', c.n_fixer,
           'in_crop_shift', exists (select 1 from crop_group_members m
                                    where m.crop_id = c.id and m.group_id = 'crop_shift'),
           'groups', (select jsonb_agg(g.group_id order by g.depth, g.group_id)
                      from crop_group_closure g where g.crop_id = c.id))
    into v_crop
  from crops c where c.id = p_crop_id;
  if v_crop is null then
    raise exception 'Unknown crop_id "%". Valid ids: %', p_crop_id,
      (select string_agg(id, ', ' order by id) from crops);
  end if;

  select jsonb_build_object('id', r.id, 'name_el', r.name_el, 'region_type', r.region_type)
    into v_region
  from regions r where r.id = p_region_id;
  if v_region is null then
    raise exception 'Unknown region_id "%". Valid ids: %', p_region_id,
      (select string_agg(id, ', ' order by id) from regions);
  end if;

  if p_previous_crop_id is not null
     and not exists (select 1 from crops where id = p_previous_crop_id) then
    raise exception 'Unknown previous crop_id "%". Valid ids: %', p_previous_crop_id,
      (select string_agg(id, ', ' order by id) from crops);
  end if;

  -- subsidies, each with its own conditions
  with subs as (
    select cs.*,
           case
             when cardinality(cs.replaces_crop_ids) = 0        then 'yes'
             when p_previous_crop_id is null                   then 'depends_on_previous_crop'
             when p_previous_crop_id = any(cs.replaces_crop_ids) then 'yes'
             else 'no'
           end as applies
    from crop_subsidies cs
    where cs.crop_id = p_crop_id
      and provision_in_region(cs.provision_id, p_region_id)
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'provision_id',              s.provision_id,
        'scheme_code',               s.scheme_code,
        'scheme_name_el',            s.scheme_name_el,
        'scheme_kind',               s.scheme_kind,
        'amount',                    s.amount,
        'amount_kind',               s.amount_kind,
        'unit',                      s.unit,
        'min_amount',                s.min_amount,
        'max_amount',                s.max_amount,
        'claim_year',                s.claim_year,
        'via_group_id',              s.via_group_id,
        'requires_previous_crop',    case when cardinality(s.replaces_crop_ids) > 0
                                          then to_jsonb(s.replaces_crop_ids) end,
        'applies',                   s.applies,
        'counts_in_crop_comparison', s.scheme_kind is distinct from 'decoupled',
        'statement_el',              s.statement_el,
        'source_ref',                s.source_ref,
        'source_url',                s.source_url,
        'conditions',                (select jsonb_agg(crop_constraint_json(cc) order by cc.provision_id)
                                      from crop_constraints cc
                                      where cc.crop_id = p_crop_id
                                        and cc.applies_when = 'with_subsidy'
                                        and s.provision_id = any(cc.subsidy_provision_ids)
                                        and provision_in_region(cc.provision_id, p_region_id)))
      order by case s.scheme_kind when 'coupled' then 1 when 'eco_scheme' then 2
                                  when 'agri_environment' then 3 else 4 end,
               s.provision_id), '[]'::jsonb),
    jsonb_build_object(
      'coupled',                     coalesce(sum(s.amount) filter (where s.scheme_kind = 'coupled'), 0),
      'eco_scheme',                  case when p_previous_crop_id is not null
                                          then coalesce(sum(s.amount) filter (
                                                 where s.scheme_kind = 'eco_scheme' and s.applies = 'yes'), 0) end,
      'agri_environment_optional',   coalesce(sum(s.amount) filter (where s.scheme_kind = 'agri_environment'), 0),
      'decoupled_indicative',        coalesce(sum(s.amount) filter (where s.scheme_kind = 'decoupled'), 0))
    into v_subs, v_totals
  from subs s;

  -- conditionality: holds whatever is claimed
  select coalesce(jsonb_agg(crop_constraint_json(cc) order by cc.provision_id), '[]'::jsonb)
    into v_cond
  from crop_constraints cc
  where cc.crop_id = p_crop_id
    and cc.applies_when = 'always'
    and provision_in_region(cc.provision_id, p_region_id);

  return jsonb_strip_nulls(jsonb_build_object(
    'crop',             v_crop,
    'region',           v_region,
    'previous_crop_id', p_previous_crop_id,
    'as_of',            current_date,
    'subsidies',        v_subs,
    'conditionality',   v_cond,
    'totals_eur_ha',    v_totals,
    'notes', jsonb_build_array(
      'All amounts are in EUR/ha (1 ha = 10 stremma).',
      'amount_kind = indicative: a planned or maximum amount, not final. The amount actually paid may differ (range: min_amount to max_amount).',
      'applies = depends_on_previous_crop: the subsidy is paid only if the field grew one of the crops in requires_previous_crop last year. totals_eur_ha.eco_scheme is filled in only when the previous crop is given.',
      'Every subsidy applies only if its conditions are met. The database does not check whether the farmer meets them.',
      'scheme_kind = decoupled: the same amount for every arable crop, so it does not change a comparison between crops. It depends on the farmer (entitlements, holding size, age), not on the crop.',
      'scheme_kind = agri_environment: a voluntary multi-year commitment with costs of its own. It is not part of the margin in crop_economics.',
      'Π1-31.1 cannot be combined with organic farming, another eco-scheme or an agri-environment commitment on the same parcel. The database does not know which programmes a parcel is in.',
      'conditionality: applies to every recipient of direct payments, whichever subsidy is claimed.'
    )));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. crop_comparison: the 15 crops side by side
-- ---------------------------------------------------------------------------
-- p_previous_crop_id: with it, eco_31_1_eur_ha is the exact Π1-31.1 amount for the change
-- previous crop -> this crop (0 when the change is not paid), and it is part of gross_eur_ha.
-- Without it only the range (eco_31_1_min / _max) is given, and it stays out of the sums.
--
--   gross_eur_ha   revenue + coupled + Π1-31.1 (when known). Available for every crop.
--   margin_eur_ha  gross - average cost. Only for crops with costs from at least 3 farmers.
-- The two must not be mixed in one ranking: a crop without costs is not cheaper to grow.
--
-- p_yield_pct: the expected yield of each crop on THIS field, as a percentage of the reference
-- yield, e.g. {"cotton": 96.4, "maize": 61.0}. It comes from the salinity model
-- (backend/second_model/salinity/crops.py, yield_expected). Revenue, gross and margin are then
-- scaled to it; a crop missing from the object keeps the reference yield. Without it the
-- comparison assumes every crop reaches the zone average, which favours salt-sensitive crops.
--
-- Regions: reference yields and prices are one set for the whole study zone (see the notes in
-- the result), and every provision is for Greece. p_region_id is checked and applied to the
-- Π1-31.1 amounts; it is here so that the call stays the same when regional data arrive.
drop function if exists public.crop_comparison(text, text);
create or replace function public.crop_comparison(
  p_region_id        text  default 'gr',
  p_previous_crop_id text  default null,
  p_yield_pct        jsonb default null
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_region jsonb;
  v_rows   jsonb;
begin
  select jsonb_build_object('id', r.id, 'name_el', r.name_el, 'region_type', r.region_type)
    into v_region
  from regions r where r.id = p_region_id;
  if v_region is null then
    raise exception 'Unknown region_id "%". Valid ids: %', p_region_id,
      (select string_agg(id, ', ' order by id) from regions);
  end if;

  if p_previous_crop_id is not null
     and not exists (select 1 from crops where id = p_previous_crop_id) then
    raise exception 'Unknown previous crop_id "%". Valid ids: %', p_previous_crop_id,
      (select string_agg(id, ', ' order by id) from crops);
  end if;

  with base as (
    select e.*,
           c.name_en, c.yield_year, c.yield_source, c.price_date, c.price_source,
           case when p_previous_crop_id is not null then
             coalesce((select sum(cs.amount)
                       from crop_subsidies cs
                       where cs.crop_id = e.crop_id
                         and p_previous_crop_id = any(cs.replaces_crop_ids)
                         and provision_in_region(cs.provision_id, p_region_id)), 0)
           end as eco,
           case when p_yield_pct ? e.crop_id
                then least(100, greatest(0, (p_yield_pct ->> e.crop_id)::numeric)) end as ypct
    from crop_economics e
    join crops c on c.id = e.crop_id
  ),
  scaled as (
    -- mock values are filtered out: no revenue, gross or margin is built on them
    select b.*,
           case when not b.mock_data
                then round(b.revenue_eur_ha * coalesce(b.ypct, 100) / 100, 2) end as rev
    from base b
  ),
  calc as (
    select s.*,
           round(s.rev + s.coupled_eur_ha + coalesce(s.eco, 0), 2) as gross
    from scaled s
  )
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'crop_id',               k.crop_id,
             'name_el',               k.crop_name_el,
             'name_en',               k.name_en,
             'is_previous_crop',      case when p_previous_crop_id is not null
                                           then k.crop_id = p_previous_crop_id end,
             'yield_kg_ha',           case when k.yield_source not like 'MOCK DATA%' then k.yield_kg_ha end,
             'yield_year',            k.yield_year,
             'yield_source',          case when k.yield_source not like 'MOCK DATA%' then k.yield_source end,
             'price_eur_kg',          case when k.price_kind <> 'mock' then k.price_eur_kg end,
             'price_kind',            case when k.price_kind <> 'mock' then k.price_kind end,
             'price_date',            k.price_date,
             'price_source',          case when k.price_kind <> 'mock' then k.price_source end,
             'revenue_available',     not k.mock_data,
             'yield_pct',             k.ypct,
             'revenue_eur_ha',        k.rev,
             'revenue_at_reference_yield_eur_ha',
                                      case when k.ypct is not null and not k.mock_data
                                           then k.revenue_eur_ha end,
             'coupled_eur_ha',        k.coupled_eur_ha,
             'eco_31_1_eur_ha',       k.eco,
             'eco_31_1_min_eur_ha',   k.eco_31_1_min_eur_ha,
             'eco_31_1_max_eur_ha',   k.eco_31_1_max_eur_ha,
             'agri_env_optional_eur_ha', nullif(k.agri_env_eur_ha, 0),
             'decoupled_eur_ha',      k.decoupled_eur_ha,
             'subsidy_approx',        k.subsidy_approx,
             'gross_eur_ha',          k.gross,
             'cost_farmers',          coalesce(k.cost_farmers, 0),
             'cost_seasons',          coalesce(k.cost_seasons, 0),
             'costs', case when k.avg_total_cost_eur_ha is not null then jsonb_build_object(
                        'fertilizer_eur_ha',      k.avg_fertilizer_eur_ha,
                        'crop_protection_eur_ha', k.avg_crop_protection_eur_ha,
                        'seed_eur_ha',            k.avg_seed_eur_ha,
                        'contract_work_eur_ha',   k.avg_contract_work_eur_ha,
                        'irrigation_eur_ha',      k.avg_irrigation_eur_ha,
                        'total_eur_ha',           k.avg_total_cost_eur_ha) end,
             'margin_eur_ha',         round(k.gross - k.avg_total_cost_eur_ha, 2))
           order by k.gross desc nulls last, k.crop_id), '[]'::jsonb)
    into v_rows
  from calc k;

  return jsonb_strip_nulls(jsonb_build_object(
    'region',           v_region,
    'previous_crop_id', p_previous_crop_id,
    'yield_adjusted_for_salinity', p_yield_pct is not null,
    'as_of',            current_date,
    'crops',            v_rows,
    'notes', jsonb_build_array(
      'All amounts are in EUR/ha (1 ha = 10 stremma). Crops are ordered by gross_eur_ha.',
      'Yields and prices are one reference set for the whole study zone (the average of the highly exposed coastal regional units, see yield_source). There are no prices per region or per parcel yet.',
      'revenue_available = false: the database has no sourced price or yield for this crop, so it has no revenue, gross or margin here. Its revenue is unknown, not zero: it cannot be ranked against the other crops.',
      'gross_eur_ha = revenue + coupled support + Π1-31.1 (only when the previous crop is given). It does not subtract costs.',
      'margin_eur_ha exists only where costs exists (an average over at least 3 farmers, from seasons with fully reported costs: seasons with estimated or missing cost lines are left out). A crop without costs does not have zero cost: its cost is unknown. Do not compare the margin of one crop with the gross of another.',
      'costs cover fertiliser, plant protection, seed, contractor fees and irrigation. They do not include land rent, the farmer''s own labour, fuel, machinery depreciation or harvesting.',
      'Coupled support applies only if its conditions are met (see crop_policy). Agri-environment support (agri_env_optional_eur_ha) and decoupled support (decoupled_eur_ha) are not part of gross or margin.',
      'yield_adjusted_for_salinity = true: revenue_eur_ha uses the reference yield x yield_pct / 100, the expected yield of each crop at the salinity of this field. false: every crop is assumed to reach the zone average, which overstates salt-sensitive crops on a saline field.',
      'A ranking by gross_eur_ha is not a recommendation. Water-intensive crops (maize, cotton, rice) lead on gross because their costs are not subtracted.',
      'subsidy_approx = true: some amount for this crop is indicative.'
    )));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. my_season_costs: the calling farmer's own figures
-- ---------------------------------------------------------------------------
-- The farmer's own costs come before the averages of other farmers: it is their field. Only the
-- seasons of auth.uid() are returned, whatever key is used; with the service role there is no
-- auth.uid() and the result is empty, so the backend must call this with the farmer's own token.
-- Only what the farmer reported: an irrigation cost the app estimated is left out, the season
-- total is given only when every line is priced and none is estimated, and revenue only when
-- the farmer gave both yield and price.
create or replace function public.my_season_costs(
  p_field_id uuid default null,
  p_crop_id  text default null
)
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'season_id',            sf.season_id,
           'field_id',             sf.field_id,
           'field_name',           sf.field_name,
           'area_ha',              sf.area_ha,
           'crop_id',              sf.crop_id,
           'season_year',          sf.season_year,
           'sown_on',              sf.sown_on,
           'harvested_on',         sf.harvested_on,
           'ongoing',              sf.ongoing,
           'costs_fully_reported', sf.cost_complete and not sf.cost_estimated,
           'unpriced_lines',       nullif(sf.unpriced_lines, 0),
           'costs_eur_ha', jsonb_build_object(
             'fertilizer',      sf.fertilizer_eur_ha,
             'crop_protection', sf.crop_protection_eur_ha,
             'seed',            sf.seed_eur_ha,
             'contract_work',   sf.contract_work_eur_ha,
             'irrigation',      case when not sf.cost_estimated then sf.irrigation_eur_ha end,
             'total',           case when sf.cost_complete and not sf.cost_estimated
                                     then sf.total_cost_eur_ha end),
           'water_m3_ha',          case when sf.water_basis = 'reported' then sf.water_m3_ha end,
           'reported_yield_kg_ha', case when coalesce(sf.income_disclosed, true)
                                        then sf.reported_main_kg_ha end,
           'reported_price_eur_kg', case when coalesce(sf.income_disclosed, true)
                                        then sf.reported_main_price_eur_kg end,
           'revenue_eur_ha',       case when sf.revenue_basis = 'reported' then sf.revenue_eur_ha end))
         order by sf.harvested_on desc nulls first, sf.season_id desc), '[]'::jsonb)
  from season_finance sf
  join fields f on f.id = sf.field_id
  where f.user_id = auth.uid()
    and (p_field_id is null or sf.field_id = p_field_id)
    and (p_crop_id  is null or sf.crop_id  = p_crop_id);
$$;

grant execute on function public.provision_in_region(bigint, text)       to authenticated, service_role;
grant execute on function public.crop_policy(text, text, text)           to authenticated, service_role;
grant execute on function public.crop_comparison(text, text, jsonb)      to authenticated, service_role;

revoke all on function public.my_season_costs(uuid, text) from public, anon;
grant execute on function public.my_season_costs(uuid, text)             to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- Verification (run manually, after loading the policy seed):
--   -- the constraints of one crop: cotton has 25-27 (cotton aid), 32-33 (Π3-70-5.1),
--   -- 28-30 (ΚΓΠΚ) and 48, 49, 51 (decoupled)
--   select provision_id, scheme_code, applies_when, subsidy_provision_ids, parameter
--   from public.crop_constraints where crop_id = 'cotton' order by provision_id;
--
--   -- wheat must NOT get the maize conditions 19-21 (same scheme, other crop): expect 0 rows
--   select * from public.crop_constraints
--   where crop_id = 'wheat_durum' and provision_id in (19, 20, 21);
--
--   -- every constraint reaches at least one crop (expect 0 rows)
--   select p.id from public.provisions p
--   where p.provision_type = 'constraint'
--     and not exists (select 1 from public.crop_constraints c where c.provision_id = p.id);
--
--   -- the documents the model reads
--   select jsonb_pretty(public.crop_policy('wheat_durum', 'gr', 'cotton'));  -- 31.1-5: applies yes
--   select jsonb_pretty(public.crop_policy('maize'));
--   select jsonb_pretty(public.crop_comparison('gr', 'cotton'));
--   select jsonb_pretty(public.crop_comparison('gr', 'cotton', '{"maize": 55, "wheat_durum": 92}'));
--
--   -- as a signed-in farmer (returns [] for the service role: there is no auth.uid())
--   select jsonb_pretty(public.my_season_costs());
-- ---------------------------------------------------------------------------
