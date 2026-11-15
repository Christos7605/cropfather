-- 0002_auth_rls.sql
-- Field Shift: profile auto-creation, RLS on every public table, DB-side field
-- derivation (area, grid cell), per-account field limits, account deletion.
--
-- Idempotent: safe to run more than once, and safe if an earlier draft of 0002
-- was already executed (old policies/triggers are dropped and recreated).
-- Assumes PostGIS plus the tables profiles, fields, crop_history from the plan.

-- ---------------------------------------------------------------------------
-- 1. Profile auto-creation (works with email confirmation and guest sign-in)
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, language)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      case when new.is_anonymous then 'Guest Judge' else 'Farmer' end
    ),
    'el'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill users created before the trigger existed
insert into public.profiles (id, display_name, language)
select
  u.id,
  coalesce(
    nullif(u.raw_user_meta_data ->> 'display_name', ''),
    case when u.is_anonymous then 'Guest Judge' else 'Farmer' end
  ),
  'el'
from auth.users u
on conflict (id) do nothing;

-- Basic input constraints on profiles
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_language_check') then
    alter table public.profiles
      add constraint profiles_language_check check (language in ('el', 'en'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_display_name_check') then
    alter table public.profiles
      add constraint profiles_display_name_check
      check (display_name is null or char_length(display_name) between 1 and 80);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Reference data: crops (needed for the crop_history foreign key)
-- ---------------------------------------------------------------------------
create table if not exists public.crops (
  id        text primary key,
  name_en   text,
  name_el   text,
  family    text,
  type      text,
  n_fixer   boolean default false
);

insert into public.crops (id, name_en, name_el, family, type, n_fixer) values
  ('wheat_durum', 'Durum wheat',      'Σκληρό σιτάρι',          'Poaceae',    'cereal',    false),
  ('wheat_soft',  'Soft wheat',       'Μαλακό σιτάρι',          'Poaceae',    'cereal',    false),
  ('barley',      'Barley',           'Κριθάρι',                'Poaceae',    'cereal',    false),
  ('maize',       'Maize',            'Καλαμπόκι',              'Poaceae',    'cereal',    false),
  ('cotton',      'Cotton',           'Βαμβάκι',                'Malvaceae',  'fibre',     false),
  ('sunflower',   'Sunflower',        'Ηλίανθος',               'Asteraceae', 'oilseed',   false),
  ('chickpea',    'Chickpea',         'Ρεβίθι',                 'Fabaceae',   'legume',    true),
  ('lentil',      'Lentil',           'Φακή',                   'Fabaceae',   'legume',    true),
  ('faba_bean',   'Faba bean',        'Κουκιά',                 'Fabaceae',   'legume',    true),
  ('alfalfa',     'Alfalfa',          'Τριφύλλι',               'Fabaceae',   'forage',    true),
  ('vetch_oat',   'Vetch-oat cover',  'Μείγμα βίκου-βρώμης',    'mixed',      'cover',     true),
  ('fallow',      'Fallow',           'Αγραναπαύση',            null,         'fallow',    false)
on conflict (id) do nothing;

-- crop_history.crop_id -> crops.id (enables crops(name_en, name_el) embeds)
-- Fails if crop_history already holds crop_id values that are not in crops.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crop_history_crop_fk') then
    alter table public.crop_history
      add constraint crop_history_crop_fk foreign key (crop_id) references public.crops (id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Row Level Security: enable everywhere, then rebuild policies from scratch
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  p record;
begin
  foreach t in array array[
    'profiles', 'fields', 'crop_history', 'recommendation_runs',
    'crops', 'crop_params', 'grid_cells', 'cell_summaries'
  ]
  loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      for p in
        select policyname from pg_policies
        where schemaname = 'public' and tablename = t
      loop
        execute format('drop policy %I on public.%I', p.policyname, t);
      end loop;
    end if;
  end loop;
end $$;

-- profiles: read/update own row only (rows are created by the trigger, removed by cascade)
create policy "profiles_select_own" on public.profiles
  for select using ((select auth.uid()) = id);
create policy "profiles_update_own" on public.profiles
  for update using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- fields: full access to own rows; user_id defaults to the caller
create policy "fields_own" on public.fields
  for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.fields alter column user_id set default auth.uid();

-- crop_history: own rows via the parent field
create policy "crop_history_own" on public.crop_history
  for all
  using (exists (
    select 1 from public.fields f
    where f.id = crop_history.field_id and f.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.fields f
    where f.id = crop_history.field_id and f.user_id = (select auth.uid())
  ));

-- reference tables: readable by everyone, writable only with the service role
create policy "crops_read" on public.crops for select using (true);

do $$
begin
  if to_regclass('public.recommendation_runs') is not null then
    create policy "recommendation_runs_own" on public.recommendation_runs
      for all
      using ((select auth.uid()) = user_id)
      with check ((select auth.uid()) = user_id);
  end if;
  if to_regclass('public.crop_params') is not null then
    create policy "crop_params_read" on public.crop_params for select using (true);
  end if;
  if to_regclass('public.grid_cells') is not null then
    create policy "grid_cells_read" on public.grid_cells for select using (true);
  end if;
  if to_regclass('public.cell_summaries') is not null then
    create policy "cell_summaries_read" on public.cell_summaries for select using (true);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Field derivation in the database (no API needed): validity, area, grid cell
-- ---------------------------------------------------------------------------
drop trigger if exists fields_set_area on public.fields;   -- from the earlier draft
drop function if exists public.set_field_area();

create or replace function public.set_field_derived()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_area_ha numeric;
begin
  if not st_isvalid(new.geom) then
    raise exception 'Field boundary is not a valid polygon (does it cross itself?)'
      using errcode = '22023';
  end if;

  v_area_ha := st_area(new.geom::geography) / 10000;

  if v_area_ha < 0.01 then
    raise exception 'Field boundary is too small' using errcode = '22023';
  end if;
  if v_area_ha > 10000 then
    raise exception 'Field is too large (maximum 10,000 ha)' using errcode = '22023';
  end if;

  new.area_ha := round(v_area_ha, 2);

  -- Grid cell lookup only once grid_cells has been populated by the pipeline
  if to_regclass('public.grid_cells') is not null then
    select g.id into new.cell_id
    from public.grid_cells g
    where st_intersects(g.geom, st_pointonsurface(new.geom))
    limit 1;
  end if;

  return new;
end;
$$;

drop trigger if exists fields_derive on public.fields;
create trigger fields_derive
  before insert or update of geom on public.fields
  for each row execute function public.set_field_derived();

-- ---------------------------------------------------------------------------
-- 5. Per-account field limit (guests are anonymous Supabase users)
-- ---------------------------------------------------------------------------
create or replace function public.enforce_field_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_anonymous boolean;
  v_count     integer;
  v_max       integer;
begin
  select coalesce(u.is_anonymous, false) into v_anonymous
  from auth.users u where u.id = new.user_id;

  v_max := case when v_anonymous then 3 else 25 end;

  select count(*) into v_count from public.fields f where f.user_id = new.user_id;

  if v_count >= v_max then
    raise exception 'Field limit reached (% fields for this account type)', v_max
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke execute on function public.enforce_field_limit() from public, anon, authenticated;

drop trigger if exists fields_limit on public.fields;
create trigger fields_limit
  before insert on public.fields
  for each row execute function public.enforce_field_limit();

-- ---------------------------------------------------------------------------
-- 6. Account deletion (callable by the signed-in user; cascades remove their data)
-- ---------------------------------------------------------------------------
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  delete from auth.users where id = (select auth.uid());
end;
$$;

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- ---------------------------------------------------------------------------
-- Verification (run manually, every row must show rowsecurity = true):
--   select tablename, rowsecurity from pg_tables where schemaname = 'public';
-- Cascade check (profiles, fields must show confdeltype = 'c'):
--   select conrelid::regclass as tbl, confdeltype from pg_constraint
--   where contype = 'f' and confrelid in ('auth.users'::regclass, 'public.fields'::regclass);
-- ---------------------------------------------------------------------------