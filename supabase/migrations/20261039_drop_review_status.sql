-- 20261039_drop_review_status.sql
-- Field Shift: no review step for the policy data. Every provision in data/policy/*.csv is in
-- use and readable by everyone.
--
--   provisions                 - review_status, reviewed_by, reviewed_at (extracted_by stays:
--                                who or what typed the row in, 'manual' or a model name)
--   scheme_incompatibilities   dropped: nothing read it, and the app does not ask which other
--                              schemes a parcel is in (ΥΑ 1606 pairs with Π1-31.1). The 32
--                              schemes that existed only for it leave data/policy/schemes.csv.
--   RLS policies               "*_read_reviewed" (only reviewed rows) -> "*_read" (all rows).
--                              Writing stays with the service role, as before.
--   current_subsidies (view)   recreated without the review_status column
--
-- Run after 20261038_fifteen_crops.sql and before 20261040_crop_subsidies.sql.
-- The first run drops current_subsidies only while that view still has review_status,
-- which is the shape from 20261031. A second run, including one after 20261042, leaves
-- crop_subsidies, crop_economics and the policy functions in place and replaces
-- current_subsidies where it stands. Do not re-run 20261031_policy_schema.sql after
-- this file: its policies use review_status. Runs in one transaction.

begin;

-- ---------------------------------------------------------------------------
-- 1. The old current_subsidies still exposes review_status
-- ---------------------------------------------------------------------------
-- Dependents are removed only in that case, so the column drop below can succeed.
-- After this file has run once, the column is gone and this block does nothing.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'current_subsidies'
      and column_name = 'review_status'
  ) then
    if exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'crop_constraints' and c.relkind = 'v'
    ) then
      drop function if exists public.crop_constraint_json(public.crop_constraints);
      drop view if exists public.crop_constraints;
    end if;
    drop function if exists public.crop_policy(text, text, text);
    drop function if exists public.crop_comparison(text, text, jsonb);
    drop function if exists public.crop_comparison(text, text);
    drop view if exists public.crop_economics;
    drop view if exists public.crop_subsidies;
    drop view if exists public.current_subsidies;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. RLS: every row readable
-- ---------------------------------------------------------------------------
drop policy if exists "provisions_read_reviewed" on public.provisions;
drop policy if exists "provisions_read" on public.provisions;
create policy "provisions_read" on public.provisions for select using (true);

drop policy if exists "subsidy_details_read_reviewed" on public.subsidy_details;
drop policy if exists "subsidy_details_read" on public.subsidy_details;
create policy "subsidy_details_read" on public.subsidy_details for select using (true);

drop policy if exists "constraint_details_read_reviewed" on public.constraint_details;
drop policy if exists "constraint_details_read" on public.constraint_details;
create policy "constraint_details_read" on public.constraint_details for select using (true);

drop policy if exists "provision_crops_read_reviewed" on public.provision_crops;
drop policy if exists "provision_crops_read" on public.provision_crops;
create policy "provision_crops_read" on public.provision_crops for select using (true);

drop policy if exists "provision_regions_read_reviewed" on public.provision_regions;
drop policy if exists "provision_regions_read" on public.provision_regions;
create policy "provision_regions_read" on public.provision_regions for select using (true);

drop policy if exists "provision_practices_read_reviewed" on public.provision_practices;
drop policy if exists "provision_practices_read" on public.provision_practices;
create policy "provision_practices_read" on public.provision_practices for select using (true);


-- ---------------------------------------------------------------------------
-- 3. Columns
-- ---------------------------------------------------------------------------
alter table public.provisions drop constraint if exists provisions_review_status_check;
drop index if exists public.provisions_review_status_idx;
alter table public.provisions drop column if exists review_status;
alter table public.provisions drop column if exists reviewed_by;
alter table public.provisions drop column if exists reviewed_at;

-- scheme incompatibilities: the whole table goes (its rows, policy and indexes with it)
drop table if exists public.scheme_incompatibilities;

-- ---------------------------------------------------------------------------
-- 4. current_subsidies, as in 20261031_policy_schema.sql section H, without review_status
-- ---------------------------------------------------------------------------
create or replace view public.current_subsidies
with (security_invoker = true) as
with targets as (
  select p.id as provision_id, p.scheme_code, p.claim_year, p.valid_from, p.valid_to,
         pc.crop_id, pc.crop_group_id
  from public.provisions p
  join public.provision_crops pc on pc.provision_id = p.id and pc.role = 'applies_to'
  where p.provision_type = 'subsidy'
    and p.superseded_by is null
),
ranked as (
  select t.*,
         max(t.claim_year) over (partition by t.scheme_code, t.crop_id, t.crop_group_id) as latest_claim_year
  from targets t
)
select r.provision_id,
       r.scheme_code,
       s.kind as scheme_kind,
       r.crop_id,
       r.crop_group_id,
       d.amount,
       d.amount_kind,
       d.unit,
       d.min_amount,
       d.max_amount,
       d.reduction_pct,
       d.cap,
       d.cap_unit,
       r.claim_year,
       r.valid_from,
       r.valid_to,
       array(select x.crop_id from public.provision_crops x
             where x.provision_id = r.provision_id and x.role = 'replaces' and x.crop_id is not null
             order by x.crop_id) as replaces_crop_ids,
       array(select x.crop_group_id from public.provision_crops x
             where x.provision_id = r.provision_id and x.role = 'replaces' and x.crop_group_id is not null
             order by x.crop_group_id) as replaces_group_ids,
       p.statement_el,
       p.source_ref,
       p.source_url
from ranked r
join public.provisions p      on p.id = r.provision_id
join public.subsidy_details d on d.provision_id = r.provision_id
left join public.schemes s    on s.id = r.scheme_code
where (r.claim_year is not null and r.claim_year = r.latest_claim_year)
   or (r.claim_year is null
       and (r.valid_from is null or r.valid_from <= current_date)
       and (r.valid_to   is null or r.valid_to   >= current_date));

commit;
