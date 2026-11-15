-- 20261041_crop_economics.sql
-- Field Shift: one economic row per crop of the 15. Revenue, costs and subsidies side by side.
--
--   crops.price_kind         + 'mock': a placeholder price with no source (data/policy/crops.csv,
--                              NASA/sources/README.md). Shown as approximate, like 'indicative'.
--   crop_cost_averages()     average cost per hectare of each crop, over the harvested seasons
--                            of ALL farmers. Security definer: it reads every season, but returns
--                            only averages, and only when at least 3 farmers have such seasons.
--   crop_economics (view)    per crop of the 15:
--                              revenue    reference yield x price (crops)
--                              costs      the farmers' averages from crop_cost_averages(); empty
--                                         until enough farmers have recorded seasons
--                              subsidies  from crop_subsidies, split by kind
--                              margin     revenue + coupled support - average cost
--
-- Costs are never typed in here: they come from what farmers record in their seasons
-- (fertilisers, plant protection, seed, contract work, irrigation), the same lines as
-- season_cost_lines. A cost category with no lines in a season counts as 0 for that season;
-- a season with any unpriced or estimated line is left out, so the averages hold only what
-- farmers reported.
--
-- Run after 20261040_crop_subsidies.sql, and BEFORE loading data/policy/seed.sql (the seed now
-- uses price_kind = 'mock', which this file allows). Runs in one transaction. Idempotent.

begin;

-- ---------------------------------------------------------------------------
-- 1. price_kind 'mock'
-- ---------------------------------------------------------------------------
alter table public.crops drop constraint if exists crops_price_check;
alter table public.crops
  add constraint crops_price_check
  check ((price_eur_kg is null or price_eur_kg > 0)
         and (price_eur_kg is null) = (price_kind is null)
         and (price_kind is null or price_kind in ('market', 'indicative', 'mock')));

-- ---------------------------------------------------------------------------
-- 2. Average costs over all farmers
-- ---------------------------------------------------------------------------
-- Only harvested seasons whose costs are complete (season_finance.cost_complete: at least one
-- cost line and no unpriced line; an unpriced line would count as 0). min_farmers keeps one farmer's costs
-- from being readable through the average: below it, the averages are empty, the counts stay.
create or replace function public.crop_cost_averages(min_farmers int default 3)
returns table (
  crop_id                    text,
  seasons                    int,
  farmers                    int,
  avg_fertilizer_eur_ha      numeric,
  avg_crop_protection_eur_ha numeric,
  avg_seed_eur_ha            numeric,
  avg_contract_work_eur_ha   numeric,
  avg_irrigation_eur_ha      numeric,
  avg_total_cost_eur_ha      numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with s as (
    select sf.crop_id, f.user_id,
           coalesce(sf.fertilizer_eur_ha, 0)      as fertilizer,
           coalesce(sf.crop_protection_eur_ha, 0) as crop_protection,
           coalesce(sf.seed_eur_ha, 0)            as seed,
           coalesce(sf.contract_work_eur_ha, 0)   as contract_work,
           coalesce(sf.irrigation_eur_ha, 0)      as irrigation,
           coalesce(sf.total_cost_eur_ha, 0)      as total
    from public.season_finance sf
    join public.fields f on f.id = sf.field_id
    where sf.harvested_on is not null
      and sf.cost_complete        -- at least one cost line, and every line priced
      and not sf.cost_estimated   -- no estimated line (e.g. pumping energy worked out by the app)
  ),
  g as (
    select crop_id, count(*)::int as seasons, count(distinct user_id)::int as farmers,
           avg(fertilizer) as fertilizer, avg(crop_protection) as crop_protection,
           avg(seed) as seed, avg(contract_work) as contract_work,
           avg(irrigation) as irrigation, avg(total) as total
    from s
    group by crop_id
  )
  select crop_id, seasons, farmers,
         case when farmers >= min_farmers then round(fertilizer, 2)      end,
         case when farmers >= min_farmers then round(crop_protection, 2) end,
         case when farmers >= min_farmers then round(seed, 2)            end,
         case when farmers >= min_farmers then round(contract_work, 2)   end,
         case when farmers >= min_farmers then round(irrigation, 2)      end,
         case when farmers >= min_farmers then round(total, 2)           end
  from g;
$$;

revoke all on function public.crop_cost_averages(int) from public, anon;
grant execute on function public.crop_cost_averages(int) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. crop_economics
-- ---------------------------------------------------------------------------
-- Subsidy columns (EUR/ha, from crop_subsidies):
--   coupled_eur_ha          coupled support for this crop (Π1-32.x, cotton aid)
--   agri_env_eur_ha         agri-environment commitments (Π3-70-5.1): voluntary, with costs of
--                           their own, so shown but left out of margin_eur_ha
--   eco_31_1_min / _max     Π1-31.1: depends on the crop it replaces (field history)
--   decoupled_eur_ha        basic, redistributive, young farmers: same for every arable crop,
--                           so left out of the comparison and of margin_eur_ha
create or replace view public.crop_economics
with (security_invoker = true) as
with sub as (
  select crop_id,
         sum(amount) filter (where scheme_kind = 'coupled')                       as coupled,
         sum(amount) filter (where scheme_kind = 'agri_environment')              as agri_env,
         min(amount) filter (where cardinality(replaces_crop_ids) > 0)            as eco_min,
         max(amount) filter (where cardinality(replaces_crop_ids) > 0)            as eco_max,
         sum(amount) filter (where scheme_kind = 'decoupled')                     as decoupled,
         -- decoupled amounts are indicative for every crop: leaving them in would make
         -- approx true everywhere, so only the crop-specific amounts count here
         bool_or(amount_kind <> 'fixed') filter (where scheme_kind <> 'decoupled') as approx
  from public.crop_subsidies
  group by crop_id
)
select c.id                                                     as crop_id,
       c.name_el                                                as crop_name_el,
       -- revenue
       c.yield_kg_ha,
       c.price_eur_kg,
       c.price_kind,
       (c.price_kind = 'mock' or c.yield_source like 'MOCK DATA%') as mock_data,
       round(c.yield_kg_ha * c.price_eur_kg, 2)                 as revenue_eur_ha,
       -- costs (farmers' averages)
       a.seasons                                                as cost_seasons,
       a.farmers                                                as cost_farmers,
       a.avg_fertilizer_eur_ha,
       a.avg_crop_protection_eur_ha,
       a.avg_seed_eur_ha,
       a.avg_contract_work_eur_ha,
       a.avg_irrigation_eur_ha,
       a.avg_total_cost_eur_ha,
       -- subsidies
       coalesce(s.coupled, 0)                                   as coupled_eur_ha,
       coalesce(s.agri_env, 0)                                  as agri_env_eur_ha,
       s.eco_min                                                as eco_31_1_min_eur_ha,
       s.eco_max                                                as eco_31_1_max_eur_ha,
       coalesce(s.decoupled, 0)                                 as decoupled_eur_ha,
       coalesce(s.approx, false)                                as subsidy_approx,
       -- margin: revenue + coupled support - average cost (empty without costs). The
       -- agri-environment amount stays out: a voluntary commitment with costs of its own.
       round(c.yield_kg_ha * c.price_eur_kg + coalesce(s.coupled, 0)
             - a.avg_total_cost_eur_ha, 2)                      as margin_eur_ha
from public.crops c
join public.crop_group_members m on m.crop_id = c.id and m.group_id = 'crop_shift'
left join sub s on s.crop_id = c.id
left join public.crop_cost_averages() a on a.crop_id = c.id;

commit;

-- ---------------------------------------------------------------------------
-- Verification (run manually, after the seed):
--   select crop_id, revenue_eur_ha, mock_data, cost_farmers, avg_total_cost_eur_ha,
--          coupled_eur_ha, eco_31_1_min_eur_ha, eco_31_1_max_eur_ha, decoupled_eur_ha, margin_eur_ha
--   from public.crop_economics order by revenue_eur_ha desc nulls last;   -- expect 15 rows
-- ---------------------------------------------------------------------------
