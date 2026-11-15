-- 0008_questionnaire_levels.sql
-- Field Shift: questions asked at three levels instead of one.
--
--   farmer_questionnaire_responses   once per farmer: priorities, market, ownership, labour,
--                                    machinery, risk (applies to all of their fields)
--   questionnaire_responses          per field: what the farmer has seen on the land
--                                    (unchanged table from 0007, new question version)
--   crop_history                     per field and season: crop plus tillage, residues,
--                                    nitrogen, irrigation and how the harvest went
--
-- Run after 0007. Idempotent: safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. Farmer-level questionnaire
-- ---------------------------------------------------------------------------
create table if not exists public.farmer_questionnaire_responses (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  version        text not null check (version ~ '^[a-z0-9][a-z0-9._-]{0,31}$'),
  answers        jsonb not null default '{}'::jsonb
                 check (jsonb_typeof(answers) = 'object' and pg_column_size(answers) < 32768),
  status         text not null default 'draft' check (status in ('draft', 'submitted')),
  answered_count int not null default 0,
  question_count int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  submitted_at   timestamptz,
  unique (user_id, version),
  check (question_count between 0 and 200 and answered_count between 0 and question_count)
);

-- Same timestamp rules as the field questionnaire (function from 0007)
drop trigger if exists farmer_questionnaire_touch on public.farmer_questionnaire_responses;
create trigger farmer_questionnaire_touch
  before insert or update on public.farmer_questionnaire_responses
  for each row execute function public.questionnaire_touch();

alter table public.farmer_questionnaire_responses enable row level security;
drop policy if exists "farmer_questionnaire_own" on public.farmer_questionnaire_responses;
create policy "farmer_questionnaire_own" on public.farmer_questionnaire_responses
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
revoke all on public.farmer_questionnaire_responses from anon;

-- One row per answer, for the ML pipeline (service role)
create or replace view public.farmer_questionnaire_answers
with (security_invoker = true)
as
select r.user_id, r.version, r.status, a.key as question_id, a.value as answer, r.updated_at
from public.farmer_questionnaire_responses r
cross join lateral jsonb_each(r.answers) a;

revoke all on public.farmer_questionnaire_answers from anon;
grant select on public.farmer_questionnaire_answers to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Season details on crop_history
--    All optional; 'unknown' means the farmer answered "I don't know".
-- ---------------------------------------------------------------------------
alter table public.crop_history add column if not exists tillage    text;
alter table public.crop_history add column if not exists residues   text;
alter table public.crop_history add column if not exists nitrogen   text;
alter table public.crop_history add column if not exists irrigation text;
alter table public.crop_history add column if not exists yield_outcome text;
alter table public.crop_history add column if not exists notes      text;
alter table public.crop_history add column if not exists created_at timestamptz not null default now();
alter table public.crop_history add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crop_history_details_check') then
    alter table public.crop_history add constraint crop_history_details_check check (
          (tillage       is null or tillage       in ('plough', 'reduced', 'noTill', 'unknown'))
      and (residues      is null or residues      in ('burn', 'remove', 'incorporate', 'leave', 'unknown'))
      and (nitrogen      is null or nitrogen      in ('none', 'low', 'normal', 'high', 'unknown'))
      and (irrigation    is null or irrigation    in ('none', 'some', 'full', 'unknown'))
      and (yield_outcome is null or yield_outcome in ('failed', 'poor', 'normal', 'good', 'unknown'))
      and (notes is null or char_length(notes) <= 500)
    );
  end if;
  -- One crop per field and year (the main crop of that season)
  if not exists (select 1 from pg_constraint where conname = 'crop_history_field_year_key') then
    if exists (
      select 1 from public.crop_history group by field_id, season_year having count(*) > 1
    ) then
      raise notice 'crop_history has several rows for the same field and year; unique rule not added';
    else
      alter table public.crop_history
        add constraint crop_history_field_year_key unique (field_id, season_year);
    end if;
  end if;
end $$;

create or replace function public.crop_history_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
  end if;
  new.notes := nullif(btrim(new.notes), '');
  return new;
end;
$$;

revoke execute on function public.crop_history_touch() from public, anon, authenticated;

drop trigger if exists crop_history_touch on public.crop_history;
create trigger crop_history_touch
  before insert or update on public.crop_history
  for each row execute function public.crop_history_touch();

-- "Other" crop, for seasons with a crop outside the list
insert into public.crops (id, name_en, name_el, family, type, n_fixer)
values ('other', 'Other crop', 'Άλλη καλλιέργεια', null, 'other', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Optional, once: remove answers to the old placeholder field questions (version v1-draft).
-- The app now asks version v2-draft, so those rows are no longer shown anywhere.
--   delete from public.questionnaire_responses where version = 'v1-draft';
--
-- Verification (run manually):
--   select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'crop_history' order by ordinal_position;
--   select count(*) from public.farmer_questionnaire_responses;
-- ---------------------------------------------------------------------------