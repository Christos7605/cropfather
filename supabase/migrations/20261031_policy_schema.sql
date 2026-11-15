-- 20261030_policy_schema.sql
-- Field Shift: CAP / legislation knowledge base, in one file.
--
--   A. crops columns            botanical genus (ΚΓΠΚ 7), yield and producer price
--   B. crop_groups              crop groups as a tree, and their members
--   C. regions                  administrative regions (NUTS based)
--   D. schemes                  CAP schemes and actions as a tree, with their kind
--   E. provisions               subsidies and constraints, with their details,
--                               crops and regions
--   F. practices                farming practices a provision requires or forbids
--   G. scheme_incompatibilities CAP schemes not allowed on the same parcel
--   H. current_subsidies (view) the subsidy amounts that apply today
--
-- Replaces the six separate policy migrations (crop_genus, crop_groups, regions,
-- provisions, practices, scheme_incompatibilities), which never ran on any
-- database. The sections are in dependency order, so the file runs top to bottom
-- in the SQL Editor in one go.
--
-- Run after the team migrations up to 20261024_cadastre_source.sql (needs
-- public.crops from 20261022_auth_rls.sql). Runs in one transaction: either
-- everything is created or nothing is. Idempotent: safe to run more than once.
--
-- Schema only. The data is in data/policy/*.csv and is loaded after this file,
-- in the order given in data/policy/README.md.

begin;

-- ===========================================================================
-- A. crops columns: genus, yield, producer price
-- ===========================================================================
-- Field Shift: botanical genus of each crop, and the yield and producer price
-- that give its market revenue.
--
--   crops.genus         e.g. 'Triticum', 'Hordeum', 'Zea'
--   crops.yield_kg_ha   average yield, kg/ha
--   crops.price_eur_kg  producer (farm gate) price, EUR/kg
--
-- Revenue per hectare is yield_kg_ha * price_eur_kg, in EUR/ha like the
-- subsidies in subsidy_details, so the two add up directly. Production cost is
-- not here yet.
--
-- Conditionality ΚΓΠΚ 7 (provisions 28-29) counts crop rotation as a change of
-- botanical genus, not of family. Five of the nine crop-shift crops are Poaceae,
-- so family alone cannot tell a rotation (wheat -> barley, Triticum -> Hordeum)
-- from a repeat (durum -> soft wheat, both Triticum). Empty for mixtures
-- (vetch_oat) and fallow.
--
-- Yield and price are filled only for the nine crop-shift crops, from
-- Παράκτιες_20_καλλιέργειες.xlsx: yield is production / area in the
-- high-exposure coastal regional units (ΕΛΣΤΑΤ 2024), price is the latest
-- available producer price (agridata 2026, else ΥΠΑΑΤ 2026, else Eurostat 2024).
-- They are averages for the coastal zone, not values of one field.
--
-- public.crops itself comes from 20261022_auth_rls.sql; this only adds columns.
-- Schema only. The values are data, kept in data/policy/crops.csv. Crops that
-- 20261022_auth_rls.sql already inserted must be updated, not skipped, when the
-- CSV is loaded (see data/policy/README.md).

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
-- genus         free text, no check, like crops.family
-- yield_year    harvest year of the yield statistics
-- price_date    date of the price; empty for annual prices and old ranges
-- price_kind    market      price observed on a market or in an official bulletin
--               indicative  estimate (old range, product to confirm); the
--                           explanation must say it is approximate
-- *_source      where the number comes from, as text (like provisions.source_ref)
alter table public.crops add column if not exists genus        text;
alter table public.crops add column if not exists yield_kg_ha  numeric;
alter table public.crops add column if not exists yield_year   int;
alter table public.crops add column if not exists yield_source text;
alter table public.crops add column if not exists price_eur_kg numeric;
alter table public.crops add column if not exists price_date   date;
alter table public.crops add column if not exists price_kind   text;
alter table public.crops add column if not exists price_source text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crops_yield_check') then
    alter table public.crops
      add constraint crops_yield_check
      check ((yield_kg_ha is null or yield_kg_ha > 0)
             and (yield_year is null or yield_year between 2000 and 2100));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crops_price_check') then
    alter table public.crops
      add constraint crops_price_check
      check ((price_eur_kg is null or price_eur_kg > 0)
             and (price_eur_kg is null) = (price_kind is null)
             and (price_kind is null or price_kind in ('market', 'indicative')));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Verification (run manually, after loading the CSV data):
--   -- every crop-shift crop has a genus (expect 0 rows)
--   select c.id from public.crops c
--   join public.crop_group_members m on m.crop_id = c.id and m.group_id = 'crop_shift'
--   where c.genus is null;
--
--   -- crops sharing a genus: switching between them is not a rotation
--   -- (expect wheat_durum and wheat_soft under Triticum, faba_bean and vetch under Vicia)
--   select genus, array_agg(id order by id) from public.crops
--   where genus is not null group by genus having count(*) > 1;
--
--   -- market revenue of the crop-shift crops, EUR/ha (expect 9 rows)
--   select c.id, c.yield_kg_ha, c.price_eur_kg, c.price_kind,
--          round(c.yield_kg_ha * c.price_eur_kg, 2) as revenue_eur_ha
--   from public.crops c
--   join public.crop_group_members m on m.crop_id = c.id and m.group_id = 'crop_shift'
--   order by revenue_eur_ha desc;
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- B. crop_groups, crop_group_members
-- ===========================================================================
-- Field Shift: crop groups used by the CAP / legislation texts.
--
--   crop_groups         the groups themselves, as a tree (parent_id)
--   crop_group_members  which crop belongs to which group (many-to-many)
--
-- A crop can sit in several groups at once (e.g. maize is both arable and
-- water-intensive), so membership lives in its own table instead of a parent_id
-- on public.crops. Members store the most specific groups only; ancestors are
-- found by walking parent_id (recursive CTE).
--
-- Groups come from the texts read so far (ΥΑ Π1-31.1 water-intensive crop
-- replacement, coupled support for cereals) and from the crop-shift roles in
-- Παράκτιες_20_καλλιέργειες.xlsx. "cereals" follows the ΥΑ wording ("cereals
-- instead of maize"): it holds wheat, barley and oat, not maize or rice.
--
-- Schema only. The groups and their members are data, kept in
-- data/policy/crop_groups.csv and data/policy/crop_group_members.csv and loaded
-- after the migrations.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.crop_groups (
  id          text primary key,
  name_en     text not null,
  name_el     text not null,
  parent_id   text references public.crop_groups (id) on delete restrict,
  description text,
  constraint crop_groups_not_own_parent check (parent_id is distinct from id)
);

create index if not exists crop_groups_parent_id_idx on public.crop_groups (parent_id);

create table if not exists public.crop_group_members (
  group_id text not null references public.crop_groups (id) on delete cascade,
  crop_id  text not null references public.crops (id) on delete cascade,
  primary key (group_id, crop_id)
);

create index if not exists crop_group_members_crop_id_idx on public.crop_group_members (crop_id);

-- ---------------------------------------------------------------------------
-- 2. Row Level Security: reference data, readable by everyone,
--    writable only with the service role (same pattern as public.crops)
-- ---------------------------------------------------------------------------
alter table public.crop_groups enable row level security;
alter table public.crop_group_members enable row level security;

drop policy if exists "crop_groups_read" on public.crop_groups;
create policy "crop_groups_read" on public.crop_groups for select using (true);

drop policy if exists "crop_group_members_read" on public.crop_group_members;
create policy "crop_group_members_read" on public.crop_group_members for select using (true);

-- ---------------------------------------------------------------------------
-- Verification (run manually, after loading the CSV data):
--   -- every group with its direct crops
--   select g.id, g.name_el, g.parent_id, array_agg(m.crop_id order by m.crop_id) as crops
--   from public.crop_groups g
--   left join public.crop_group_members m on m.group_id = g.id
--   group by g.id, g.name_el, g.parent_id order by g.id;
--
--   -- all groups a crop belongs to, ancestors included (here: maize)
--   with recursive up as (
--     select g.* from public.crop_groups g
--     join public.crop_group_members m on m.group_id = g.id
--     where m.crop_id = 'maize'
--     union
--     select p.* from public.crop_groups p join up on p.id = up.parent_id
--   )
--   select id, name_el from up order by id;
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- C. regions
-- ===========================================================================
-- Field Shift: administrative regions that CAP / legislation provisions apply to.
--
-- First phase hierarchy (NUTS based):
--   EU  ->  Greece  ->  Region (NUTS 2, Περιφέρεια)  ->  Regional unit (NUTS 3, ΠΕ)
-- Municipalities and special zones (Natura, nitrates, salinity) come later as new
-- region_type values, with no change to this table.
--
-- No geometry yet: a geom column (MultiPolygon, 4326, GIST index) is added by a
-- later migration, and the boundaries are loaded by a script in pipeline/.
--
-- Schema only. The regions are data, kept in data/policy/regions.csv (the roots
-- 'eu' and 'gr' for now; regions and regional units later from the NUTS data)
-- and loaded after the migrations.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
-- region_type values used so far: 'eu', 'country', 'region', 'regional_unit'.
-- Later: 'municipality', 'natura', 'nitrate_zone', 'salinity_zone'. No check
-- constraint on purpose, so new types need no schema change.
-- alias_el keeps the former name of a regional unit (the old νομός).
create table if not exists public.regions (
  id          text primary key,
  name_el     text not null,
  name_en     text not null,
  region_type text not null,
  parent_id   text references public.regions (id) on delete restrict,
  nuts_code   text unique,
  alias_el    text,
  constraint regions_not_own_parent check (parent_id is distinct from id)
);

create index if not exists regions_parent_id_idx   on public.regions (parent_id);
create index if not exists regions_region_type_idx on public.regions (region_type);

-- ---------------------------------------------------------------------------
-- 2. Row Level Security: reference data, readable by everyone,
--    writable only with the service role (same pattern as public.crop_groups)
-- ---------------------------------------------------------------------------
alter table public.regions enable row level security;

drop policy if exists "regions_read" on public.regions;
create policy "regions_read" on public.regions for select using (true);

-- ---------------------------------------------------------------------------
-- Verification (run manually, after loading the CSV data):
--   -- the two roots (expect 2 rows)
--   select id, name_el, region_type, parent_id, nuts_code from public.regions order by id;
--
--   -- every region under Greece, with its depth (once regions are loaded)
--   with recursive tree as (
--     select r.*, 0 as depth from public.regions r where r.id = 'gr'
--     union all
--     select c.*, t.depth + 1 from public.regions c join tree t on c.parent_id = t.id
--   )
--   select depth, id, name_el, region_type from tree order by depth, id;
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- D. schemes
-- ===========================================================================
-- Field Shift: the CAP schemes, interventions and actions that provisions and
-- incompatibilities refer to, as a tree (parent_id).
--
-- Ids are the codes as the texts write them, so the same scheme can appear at
-- several levels: '31.1' (intervention Π1-31.1) -> '31.1-Α' (action) ->
-- '31.1-1' ... '31.1-6' (the amounts per replaced crop). A constraint written on
-- '31.1-Α' is therefore a condition of the amounts written on '31.1-1' ... '31.1-6'.
--
-- kind  conditionality    rules every recipient of area payments must keep
--                         (ΚΓΠΚ): their constraints apply whatever is claimed
--       decoupled         paid per hectare whatever the crop (Π1-21, 29, 30):
--                         the same for every crop, so left out of crop comparison
--       coupled           paid only for a given crop (coupled support, cotton aid)
--       eco_scheme        annual voluntary scheme of Pillar I (Π1-31.x)
--       agri_environment  multi-year commitment of Pillar II, Article 70 (Π3-70)
--       rdp_2014_2022     measure of the previous Rural Development Programme,
--                         still relevant while its commitments run
-- Every row has a kind (children repeat the kind of their parent), so the kind
-- is known without walking the tree.
--
-- Schema only. The schemes are data, kept in data/policy/schemes.csv and loaded
-- after this file.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
create table if not exists public.schemes (
  id          text primary key,
  parent_id   text references public.schemes (id) on delete restrict,
  kind        text not null,
  name_el     text not null,
  description text,
  constraint schemes_not_own_parent check (parent_id is distinct from id),
  constraint schemes_kind_check check (kind in (
    'conditionality', 'decoupled', 'coupled', 'eco_scheme',
    'agri_environment', 'rdp_2014_2022'
  ))
);

create index if not exists schemes_parent_id_idx on public.schemes (parent_id);
create index if not exists schemes_kind_idx      on public.schemes (kind);

-- ---------------------------------------------------------------------------
-- 2. Row Level Security: reference data, readable by everyone,
--    writable only with the service role (same pattern as public.crop_groups)
-- ---------------------------------------------------------------------------
alter table public.schemes enable row level security;

drop policy if exists "schemes_read" on public.schemes;
create policy "schemes_read" on public.schemes for select using (true);

-- ---------------------------------------------------------------------------
-- Verification (run manually, after loading the CSV data):
--   -- the Π1-31.1 tree (expect 31.1 -> 31.1-Α, 31.1-Β; 31.1-Α -> 31.1-1 ... 31.1-6)
--   select id, parent_id, kind, name_el from public.schemes
--   where id like '31.1%' order by parent_id nulls first, id;
--
--   -- active constraints for a subsidy: those on its scheme or any ancestor,
--   -- plus every conditionality constraint (here: subsidy 5, 31.1-5)
--   with recursive up as (
--     select s.* from public.schemes s
--     join public.provisions p on p.scheme_code = s.id where p.id = 5
--     union
--     select s.* from public.schemes s join up on s.id = up.parent_id
--   )
--   select p.id, p.scheme_code, p.statement_el from public.provisions p
--   join public.schemes s on s.id = p.scheme_code
--   where p.provision_type = 'constraint'
--     and (p.scheme_code in (select id from up) or s.kind = 'conditionality')
--   order by p.id;
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- E. provisions, subsidy_details, constraint_details, provision_crops, provision_regions
-- ===========================================================================
-- Field Shift: provisions extracted from CAP / legislation texts, linked to the
-- crops and regions they apply to.
--
--   provisions          one rule: a subsidy or a constraint
--   subsidy_details     amount of a subsidy (1:1, only for provision_type 'subsidy')
--   constraint_details  condition of a constraint (1:1, only for 'constraint')
--   provision_crops     which crops or crop groups a provision concerns, and how
--   provision_regions   which regions a provision applies to, or excludes
--
-- Not in this file (later): documents/chunks. Until documents
-- exists, the source of a provision is kept as text in source_ref / source_url.

-- ---------------------------------------------------------------------------
-- 1. provisions
-- ---------------------------------------------------------------------------
-- scheme_code   CAP intervention or action the provision belongs to (a
--               public.schemes id), e.g. '31.1-4', '31.1-Α', 'Π1-32.1', 'ΚΓΠΚ 7'.
--               A constraint is a condition of the subsidies on the same scheme
--               or below it, unless its scheme is conditionality.
-- statement_el  one sentence for people, reused in the explanation, e.g.
--               '522 €/ha για χειμερινά σιτηρά σε αντικατάσταση μηδικής'
-- claim_year    application year the amounts refer to (subsidies); rules without
--               a year use valid_from / valid_to instead
-- extracted_by  model name, or 'manual' for rows entered by hand
-- Only reviewed provisions are used by the recommendation and readable by users.
create table if not exists public.provisions (
  id             bigint generated always as identity primary key,
  provision_type text not null,
  scheme_code    text references public.schemes (id) on delete restrict,
  statement_el   text not null,
  claim_year     int,
  valid_from     date,
  valid_to       date,
  superseded_by  bigint references public.provisions (id) on delete set null,
  review_status  text not null default 'extracted',
  extracted_by   text,
  reviewed_by    uuid references auth.users (id) on delete set null,
  reviewed_at    timestamptz,
  source_ref     text,
  source_url     text,
  created_at     timestamptz not null default now(),
  constraint provisions_type_check
    check (provision_type in ('subsidy', 'constraint')),
  constraint provisions_review_status_check
    check (review_status in ('extracted', 'reviewed', 'rejected')),
  constraint provisions_claim_year_check
    check (claim_year is null or claim_year between 2000 and 2100),
  constraint provisions_valid_range_check
    check (valid_to is null or valid_from is null or valid_to >= valid_from),
  constraint provisions_not_own_successor
    check (superseded_by is distinct from id),
  -- lets the detail tables check the type through their foreign key
  constraint provisions_id_type_uniq unique (id, provision_type)
);

create index if not exists provisions_type_idx          on public.provisions (provision_type);
create index if not exists provisions_review_status_idx on public.provisions (review_status);
create index if not exists provisions_scheme_code_idx   on public.provisions (scheme_code);

-- ---------------------------------------------------------------------------
-- 2. subsidy_details (1:1)
-- ---------------------------------------------------------------------------
-- The (provision_id, provision_type) foreign key only accepts subsidies.
-- amount         unit amount, in the unit of the text (usually EUR/ha;
--                conversion to στρέμματα happens only on display)
-- amount_kind    fixed            amount set by a decision for that year
--                indicative       planned or estimated amount (e.g. the CAP Strategic
--                                 Plan's planned unit amount, or a pre-announcement);
--                                 the explanation must say it is approximate
--                farmer_declared  depends on the farmer (e.g. the value of their basic
--                                 payment entitlements); amount stays empty
-- min_amount     lower end of the planned range, for indicative amounts
-- max_amount     maximum amount set in the CAP Strategic Plan, when it differs
-- reduction_pct  linear reduction applied to reach amount (0 when none)
-- cap, cap_unit  ceiling per beneficiary, e.g. 50 'ha'
create table if not exists public.subsidy_details (
  provision_id   bigint primary key,
  provision_type text not null default 'subsidy',
  amount         numeric,
  amount_kind    text not null default 'fixed',
  unit           text not null default 'EUR/ha',
  min_amount     numeric,
  max_amount     numeric,
  reduction_pct  numeric,
  cap            numeric,
  cap_unit       text,
  foreign key (provision_id, provision_type)
    references public.provisions (id, provision_type) on delete cascade,
  constraint subsidy_details_type_check   check (provision_type = 'subsidy'),
  constraint subsidy_details_amount_kind_check
    check (amount_kind in ('fixed', 'indicative', 'farmer_declared')),
  constraint subsidy_details_amount_check check (
    (amount is null) = (amount_kind = 'farmer_declared')
    and (amount is null or amount >= 0)
    and (min_amount is null or min_amount >= 0)
    and (max_amount is null or max_amount >= 0)
    and (min_amount is null or max_amount is null or min_amount <= max_amount)
  ),
  constraint subsidy_details_unit_check   check (unit in ('EUR/ha', 'EUR/head', 'EUR/t', 'EUR/holding')),
  constraint subsidy_details_reduction_check
    check (reduction_pct is null or reduction_pct between 0 and 100),
  constraint subsidy_details_cap_check
    check ((cap is null) = (cap_unit is null) and (cap is null or cap > 0))
);

-- ---------------------------------------------------------------------------
-- 3. constraint_details (1:1)
-- ---------------------------------------------------------------------------
-- The (provision_id, provision_type) foreign key only accepts constraints.
-- constraint_kind  eligibility  a condition to receive the subsidy
--                  obligation   something the farmer must do (a commitment)
--                  prohibition  something the farmer must not do
-- parameter        what is checked; values used so far: 'sowing_density',
--                  'certified_seed', 'min_area', 'crop_rotation', 'nitrogen_input',
--                  'sowing_date', 'irrigation'. Free text, no check, so new ones
--                  need no schema change.
-- operator         comparisons need value_num, 'between' needs value_num and
--                  value_num_max, '=' takes a number or a text, 'required' and
--                  'forbidden' take no value
create table if not exists public.constraint_details (
  provision_id    bigint primary key,
  provision_type  text not null default 'constraint',
  constraint_kind text not null,
  parameter       text not null,
  operator        text not null,
  value_num       numeric,
  value_num_max   numeric,
  value_text      text,
  unit            text,
  foreign key (provision_id, provision_type)
    references public.provisions (id, provision_type) on delete cascade,
  constraint constraint_details_type_check check (provision_type = 'constraint'),
  constraint constraint_details_kind_check
    check (constraint_kind in ('eligibility', 'obligation', 'prohibition')),
  constraint constraint_details_operator_check
    check (operator in ('>=', '<=', '>', '<', '=', 'between', 'required', 'forbidden')),
  constraint constraint_details_value_check check (
    case operator
      when 'between' then value_num is not null and value_num_max is not null
                          and value_num_max >= value_num
      when '='       then value_num is not null or value_text is not null
      when 'required'  then value_num is null and value_num_max is null
      when 'forbidden' then value_num is null and value_num_max is null
      else value_num is not null and value_num_max is null
    end
  )
);

create index if not exists constraint_details_parameter_idx on public.constraint_details (parameter);

-- ---------------------------------------------------------------------------
-- 4. provision_crops: a crop OR a crop group, with its role
-- ---------------------------------------------------------------------------
--   applies_to  the crop the provision is about (e.g. the crop to sow)
--   replaces    the crop being replaced (e.g. alfalfa in "cereals instead of alfalfa")
--   excluded    explicitly left out
-- Crops and groups cannot be deleted while a provision points to them.
create table if not exists public.provision_crops (
  id             bigint generated always as identity primary key,
  provision_id   bigint not null references public.provisions (id) on delete cascade,
  crop_id        text references public.crops (id) on delete restrict,
  crop_group_id  text references public.crop_groups (id) on delete restrict,
  role           text not null default 'applies_to',
  constraint provision_crops_one_target
    check (num_nonnulls(crop_id, crop_group_id) = 1),
  constraint provision_crops_role_check
    check (role in ('applies_to', 'replaces', 'excluded'))
);

create unique index if not exists provision_crops_crop_uniq
  on public.provision_crops (provision_id, crop_id, role) where crop_id is not null;
create unique index if not exists provision_crops_group_uniq
  on public.provision_crops (provision_id, crop_group_id, role) where crop_group_id is not null;
create index if not exists provision_crops_crop_id_idx       on public.provision_crops (crop_id);
create index if not exists provision_crops_crop_group_id_idx on public.provision_crops (crop_group_id);

-- ---------------------------------------------------------------------------
-- 5. provision_regions
-- ---------------------------------------------------------------------------
--   applies_to  the provision applies in this region (and everything under it)
--   excluded    the region is left out (e.g. "except the islands")
create table if not exists public.provision_regions (
  provision_id bigint not null references public.provisions (id) on delete cascade,
  region_id    text not null references public.regions (id) on delete restrict,
  role         text not null default 'applies_to',
  primary key (provision_id, region_id),
  constraint provision_regions_role_check
    check (role in ('applies_to', 'excluded'))
);

create index if not exists provision_regions_region_id_idx on public.provision_regions (region_id);

-- ---------------------------------------------------------------------------
-- 6. Row Level Security: readable by everyone once reviewed,
--    writable only with the service role
-- ---------------------------------------------------------------------------
alter table public.provisions         enable row level security;
alter table public.subsidy_details    enable row level security;
alter table public.constraint_details enable row level security;
alter table public.provision_crops    enable row level security;
alter table public.provision_regions  enable row level security;

drop policy if exists "provisions_read_reviewed" on public.provisions;
create policy "provisions_read_reviewed" on public.provisions
  for select using (review_status = 'reviewed');

drop policy if exists "subsidy_details_read_reviewed" on public.subsidy_details;
create policy "subsidy_details_read_reviewed" on public.subsidy_details
  for select using (exists (
    select 1 from public.provisions p
    where p.id = subsidy_details.provision_id and p.review_status = 'reviewed'
  ));

drop policy if exists "constraint_details_read_reviewed" on public.constraint_details;
create policy "constraint_details_read_reviewed" on public.constraint_details
  for select using (exists (
    select 1 from public.provisions p
    where p.id = constraint_details.provision_id and p.review_status = 'reviewed'
  ));

drop policy if exists "provision_crops_read_reviewed" on public.provision_crops;
create policy "provision_crops_read_reviewed" on public.provision_crops
  for select using (exists (
    select 1 from public.provisions p
    where p.id = provision_crops.provision_id and p.review_status = 'reviewed'
  ));

drop policy if exists "provision_regions_read_reviewed" on public.provision_regions;
create policy "provision_regions_read_reviewed" on public.provision_regions
  for select using (exists (
    select 1 from public.provisions p
    where p.id = provision_regions.provision_id and p.review_status = 'reviewed'
  ));

-- ---------------------------------------------------------------------------
-- Verification (run manually):
--   -- the five tables exist with RLS on (expect 5 rows, rowsecurity = true)
--   select tablename, rowsecurity from pg_tables
--   where schemaname = 'public'
--     and tablename in ('provisions', 'subsidy_details', 'constraint_details',
--                       'provision_crops', 'provision_regions');
--
--   -- a subsidy row must be rejected for a constraint provision (expect an
--   -- foreign key error on the second insert; run inside a transaction and roll back)
--   begin;
--   insert into public.provisions (provision_type, statement_el)
--     values ('constraint', 'test') returning id;
--   insert into public.subsidy_details (provision_id, amount) values (<id above>, 1);
--   rollback;
--
--   -- reviewed provisions for a crop, including those set on its groups and
--   -- their ancestors (here: durum wheat)
--   with recursive grp as (
--     select g.* from public.crop_groups g
--     join public.crop_group_members m on m.group_id = g.id
--     where m.crop_id = 'wheat_durum'
--     union
--     select p.* from public.crop_groups p join grp on p.id = grp.parent_id
--   )
--   select pr.id, pr.provision_type, pr.scheme_code, pr.statement_el, pc.role
--   from public.provisions pr
--   join public.provision_crops pc on pc.provision_id = pr.id
--   where pr.review_status = 'reviewed'
--     and (pc.crop_id = 'wheat_durum' or pc.crop_group_id in (select id from grp));
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- F. practices, provision_practices
-- ===========================================================================
-- Field Shift: farming practices that provisions require, allow or forbid.
--
--   practices            the vocabulary of practices (rotation, green manure, ...)
--   provision_practices  which practices a provision concerns, and how
--
-- The practices come from the texts read so far: conditionality (ΚΓΠΚ 4, 7),
-- coupled support and cotton aid (certified seed, no GMO) and Π3-70-5.1 (carbon
-- footprint in arable crops).
--
-- Schema only. The practices and their links to provisions are data, kept in
-- data/policy/practices.csv and data/policy/provision_practices.csv and loaded
-- after the migrations.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.practices (
  id          text primary key,
  name_el     text not null,
  name_en     text not null,
  description text
);

-- role  required  the farmer must apply it
--       forbidden the farmer must not apply it
--       optional  one of several practices that count towards the provision
create table if not exists public.provision_practices (
  provision_id bigint not null references public.provisions (id) on delete cascade,
  practice_id  text not null references public.practices (id) on delete restrict,
  role         text not null default 'required',
  primary key (provision_id, practice_id),
  constraint provision_practices_role_check
    check (role in ('required', 'forbidden', 'optional'))
);

create index if not exists provision_practices_practice_id_idx on public.provision_practices (practice_id);

-- ---------------------------------------------------------------------------
-- 2. Row Level Security: practices readable by everyone, links only for
--    reviewed provisions; writable only with the service role
-- ---------------------------------------------------------------------------
alter table public.practices           enable row level security;
alter table public.provision_practices enable row level security;

drop policy if exists "practices_read" on public.practices;
create policy "practices_read" on public.practices for select using (true);

drop policy if exists "provision_practices_read_reviewed" on public.provision_practices;
create policy "provision_practices_read_reviewed" on public.provision_practices
  for select using (exists (
    select 1 from public.provisions p
    where p.id = provision_practices.provision_id and p.review_status = 'reviewed'
  ));

-- ---------------------------------------------------------------------------
-- Verification (run manually, after loading the CSV data):
--   select count(*) from public.practices;   -- expect 14
--   select pp.provision_id, p.name_el, pp.role
--   from public.provision_practices pp join public.practices p on p.id = pp.practice_id
--   order by 1, 2;
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- G. scheme_incompatibilities
-- ===========================================================================
-- Field Shift: CAP schemes that cannot be combined on the same parcel
-- (ΥΑ 1606/09.06.2023 "Ασυμβατότητες", as amended).
--
--   scheme_incompatibilities  one row per pair of schemes or actions that are
--                             not allowed together, with its source
--
-- Codes are written as in the ΥΑ tables: eco-schemes ('31.1', '31.1-Α', '31.9'),
-- Article 70 actions ('70-1.2.1'), and RDP 2014-2022 measures ('10.1.08',
-- '11 Βιολογική κτηνοτροφία'). Both sides are public.schemes ids, the same as
-- provisions.scheme_code. A pair on '31.1' also covers every action under it.
--
-- A pair is stored once, in either order: the unique index on the ordered pair
-- rejects (B, A) when (A, B) exists.
--
-- Schema only. The pairs are data, kept in
-- data/policy/scheme_incompatibilities.csv and loaded after the migrations.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
-- note           name of the second scheme, or a condition from the ΥΑ footnotes
-- review_status  same meaning as in provisions; only 'reviewed' rows are readable
create table if not exists public.scheme_incompatibilities (
  scheme_a      text not null references public.schemes (id) on delete restrict,
  scheme_b      text not null references public.schemes (id) on delete restrict,
  note          text,
  review_status text not null default 'extracted',
  extracted_by  text,
  source_ref    text,
  source_url    text,
  primary key (scheme_a, scheme_b),
  constraint scheme_incompatibilities_distinct check (scheme_a <> scheme_b),
  constraint scheme_incompatibilities_review_status_check
    check (review_status in ('extracted', 'reviewed', 'rejected'))
);

create unique index if not exists scheme_incompatibilities_pair_uniq
  on public.scheme_incompatibilities (least(scheme_a, scheme_b), greatest(scheme_a, scheme_b));
create index if not exists scheme_incompatibilities_scheme_b_idx
  on public.scheme_incompatibilities (scheme_b);

-- ---------------------------------------------------------------------------
-- 2. Row Level Security: readable by everyone once reviewed,
--    writable only with the service role
-- ---------------------------------------------------------------------------
alter table public.scheme_incompatibilities enable row level security;

drop policy if exists "scheme_incompatibilities_read_reviewed" on public.scheme_incompatibilities;
create policy "scheme_incompatibilities_read_reviewed" on public.scheme_incompatibilities
  for select using (review_status = 'reviewed');

-- ---------------------------------------------------------------------------
-- Verification (run manually, after loading the CSV data):
--   -- everything that cannot be combined with action 31.1-Α or intervention 31.1
--   select case when scheme_a in ('31.1', '31.1-Α') then scheme_b else scheme_a end as other,
--          note
--   from public.scheme_incompatibilities
--   where '31.1' in (scheme_a, scheme_b) or '31.1-Α' in (scheme_a, scheme_b)
--   order by 1;
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- H. current_subsidies (view)
-- ===========================================================================
-- Field Shift: the subsidy amounts that apply today, one row per subsidy and
-- crop (or crop group) it applies to. The recommendation and the explanation
-- read amounts from here, never from provisions directly.
--
-- provisions keeps every amount ever published: amounts of older claim years
-- (coupled support 2023 next to 2025) and amounts replaced by an amendment
-- (superseded_by). Summing the rows without superseded_by would count both
-- 2023 and 2025 (e.g. soft wheat 269,78 + 115 €/ha). This view keeps:
--   1. subsidies not replaced by an amendment (superseded_by is null)
--   2. with a claim_year: only the latest claim_year for the same scheme and
--      the same crop or group
--   3. without a claim_year: only if today is between valid_from and valid_to
--      (cotton aid, Π3-70-5.1, the CAP Strategic Plan amounts)
--
-- scheme_kind comes from schemes.kind: leave out 'decoupled' when comparing
-- crops. replaces_crop_ids / replaces_group_ids: when not empty, the subsidy is
-- paid only if the field had one of these crops the year before (crop_history).
--
-- security_invoker: the view reads the tables with the rights of the caller,
-- so the RLS of provisions still applies (users see reviewed rows only).

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
       p.source_url,
       p.review_status
from ranked r
join public.provisions p      on p.id = r.provision_id
join public.subsidy_details d on d.provision_id = r.provision_id
left join public.schemes s    on s.id = r.scheme_code
where (r.claim_year is not null and r.claim_year = r.latest_claim_year)
   or (r.claim_year is null
       and (r.valid_from is null or r.valid_from <= current_date)
       and (r.valid_to   is null or r.valid_to   >= current_date));

-- ---------------------------------------------------------------------------
-- Verification (run manually, after loading the CSV data, as the service role):
--   -- one amount per scheme and crop (expect 0 rows)
--   select scheme_code, crop_id, crop_group_id, count(*) from public.current_subsidies
--   group by 1, 2, 3 having count(*) > 1;
--
--   -- coupled support for soft wheat: expect only provision 35, 115 €/ha (2025)
--   select provision_id, amount, claim_year from public.current_subsidies
--   where scheme_code = 'Π1-32.1' and crop_id = 'wheat_soft';
-- ---------------------------------------------------------------------------

commit;