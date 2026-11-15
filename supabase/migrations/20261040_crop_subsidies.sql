-- 20261040_crop_subsidies.sql
-- Field Shift: the subsidies that apply today, per crop.
--
--   crop_subsidies (view)  one row per crop and current subsidy. Built on current_subsidies.
--                          A subsidy written for a crop group (e.g. 31.1-4 for 'cereals',
--                          Π1-21 for 'arable') is expanded to every crop in that group or
--                          below it. via_group_id tells which group: empty = the subsidy names
--                          the crop itself.
--
-- The provisions keep the groups, because the texts are written for categories ("χειμερινά
-- σιτηρά", "αροτραίες"): a new crop gets all its subsidies by joining its group. This view is
-- only the expanded reading of the same data; nothing is stored twice.
--
-- How a crop gets a subsidy:
--   1. current_subsidies gives the amount that applies today (not superseded, latest
--      claim_year, or valid today)
--   2. the subsidy names the crop, or a group the crop belongs to, directly or through the
--      group tree (crop_groups.parent_id). Every crop is in 'all', even with no group.
--   3. the crop is not excluded from it (provision_crops.role = 'excluded', by crop or group)
-- A crop that reaches the same subsidy through two groups gets one row: the most specific.
--
-- Columns to use:
--   scheme_kind          leave out 'decoupled' when comparing crops (same amount for every
--                        arable crop); keep it for the total income.
--   replaces_crop_ids    when not empty, paid only if the field had one of these crops the
--                        year before (Π1-31.1). Each 31.1 amount is its own row.
--   amount_kind          'indicative': the explanation must say "περίπου".
--
-- Regions are not applied yet: every provision is for Greece ('gr'), see provision_regions.
-- security_invoker: the view reads the policy tables with the rights of the caller.
--
-- Run after 20261039_drop_review_status.sql. Idempotent: safe to run more than once.

create or replace view public.crop_subsidies
with (security_invoker = true) as
with recursive crop_group_tree as (
  -- the groups a crop is listed in (depth 0), then their ancestors
  select m.crop_id, m.group_id, 0 as depth
  from public.crop_group_members m
  union
  select t.crop_id, g.parent_id, t.depth + 1
  from crop_group_tree t
  join public.crop_groups g on g.id = t.group_id
  where g.parent_id is not null and t.depth < 20
),
crop_groups_all as (
  select crop_id, group_id, min(depth) as depth
  from crop_group_tree
  group by crop_id, group_id
  union all
  -- 'all' is the root: it holds every crop, also those in no group (e.g. fallow)
  select c.id, 'all', 1000
  from public.crops c
  where not exists (select 1 from crop_group_tree t where t.crop_id = c.id and t.group_id = 'all')
),
matches as (
  -- subsidy that names the crop itself
  select cs.*, cs.crop_id as target_crop_id, null::text as via_group_id, -1 as depth
  from public.current_subsidies cs
  where cs.crop_id is not null
  union all
  -- subsidy written for a group: every crop in it
  select cs.*, cg.crop_id, cs.crop_group_id, cg.depth
  from public.current_subsidies cs
  join crop_groups_all cg on cg.group_id = cs.crop_group_id
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
           or x.crop_group_id in (select g.group_id from crop_groups_all g
                                  where g.crop_id = m.target_crop_id))
  )
)
select k.target_crop_id as crop_id,
       c.name_el        as crop_name_el,
       k.provision_id,
       k.scheme_code,
       k.scheme_kind,
       s.name_el        as scheme_name_el,
       k.via_group_id,
       k.amount,
       k.amount_kind,
       k.unit,
       k.min_amount,
       k.max_amount,
       k.cap,
       k.cap_unit,
       k.claim_year,
       k.replaces_crop_ids,
       k.replaces_group_ids,
       k.statement_el,
       k.source_ref,
       k.source_url
from kept k
join public.crops c        on c.id = k.target_crop_id
left join public.schemes s on s.id = k.scheme_code
where k.rn = 1;

-- ---------------------------------------------------------------------------
-- Verification (run manually, after loading the policy seed, as the service role):
--   -- every subsidy of one crop (here: field pea: 31.1-1..3 through 'legumes', coupled
--   -- 220,80 directly, the decoupled ones through 'arable' / 'all')
--   select provision_id, scheme_code, scheme_kind, via_group_id, amount, amount_kind,
--          replaces_crop_ids
--   from public.crop_subsidies where crop_id = 'field_pea' order by provision_id;
--
--   -- crop-specific money per crop of the 15, without the decoupled payments and
--   -- without the 31.1 amounts that depend on the previous crop
--   select crop_id, crop_name_el, sum(amount) as eur_ha, string_agg(scheme_code, ', ') as schemes
--   from public.crop_subsidies
--   where scheme_kind <> 'decoupled' and cardinality(replaces_crop_ids) = 0
--     and crop_id in (select crop_id from public.crop_group_members where group_id = 'crop_shift')
--   group by crop_id, crop_name_el order by eur_ha desc;
--
--   -- no crop gets the same subsidy twice (expect 0 rows)
--   select crop_id, provision_id, count(*) from public.crop_subsidies
--   group by 1, 2 having count(*) > 1;
-- ---------------------------------------------------------------------------
