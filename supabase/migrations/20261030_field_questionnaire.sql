-- 0007_field_questionnaire.sql
-- Field Shift: the farmer's questionnaire about each field.
--
--   questionnaire_responses   one row per field and questionnaire version, answers as JSON
--                             ({ "<questionId>": <value>, ... }). Drafts are saved as the
--                             farmer types; "submitted" once they press Finish.
--   my_fields                 + the latest response's status and progress (for the field card)
--   questionnaire_answers     one row per answer, ready for the ML pipeline
--
-- The questions themselves live in the frontend (src/lib/questionnaire.ts, texts in en/el.ts).
-- A changed question set gets a new version, so old answers keep their meaning.
--
-- Run after 0006. Idempotent: safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. Responses
-- ---------------------------------------------------------------------------
create table if not exists public.questionnaire_responses (
  id             uuid primary key default gen_random_uuid(),
  field_id       uuid not null references public.fields (id) on delete cascade,
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
  unique (field_id, version),
  check (question_count between 0 and 200 and answered_count between 0 and question_count)
);

create index if not exists questionnaire_responses_user_idx on public.questionnaire_responses (user_id);

-- Timestamps are set by the database, not the browser
create or replace function public.questionnaire_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  if new.status = 'submitted' and (tg_op = 'INSERT' or old.status is distinct from 'submitted') then
    new.submitted_at := now();
  elsif new.status = 'draft' then
    new.submitted_at := null;
  end if;
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;   -- cannot be rewritten
  end if;
  return new;
end;
$$;

revoke execute on function public.questionnaire_touch() from public, anon, authenticated;

drop trigger if exists questionnaire_touch on public.questionnaire_responses;
create trigger questionnaire_touch
  before insert or update on public.questionnaire_responses
  for each row execute function public.questionnaire_touch();

-- RLS: own answers, and only for own fields
alter table public.questionnaire_responses enable row level security;
drop policy if exists "questionnaire_own" on public.questionnaire_responses;
create policy "questionnaire_own" on public.questionnaire_responses
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.fields f
      where f.id = field_id and f.user_id = (select auth.uid())
    )
  );
revoke all on public.questionnaire_responses from anon;

-- ---------------------------------------------------------------------------
-- 2. my_fields: append the latest response's progress (existing columns unchanged)
-- ---------------------------------------------------------------------------
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
  q.updated_at     as survey_updated_at
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
-- 3. One row per answer (the ML pipeline reads this with the service role)
-- ---------------------------------------------------------------------------
create or replace view public.questionnaire_answers
with (security_invoker = true)
as
select
  r.field_id,
  r.user_id,
  r.version,
  r.status,
  a.key   as question_id,
  a.value as answer,
  r.updated_at
from public.questionnaire_responses r
cross join lateral jsonb_each(r.answers) a;

revoke all on public.questionnaire_answers from anon;
grant select on public.questionnaire_answers to authenticated;

-- ---------------------------------------------------------------------------
-- Verification (run manually):
--   select count(*) from public.questionnaire_responses;
--   select question_id, answer from public.questionnaire_answers limit 20;
-- ---------------------------------------------------------------------------