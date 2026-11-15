-- 20261046_prediction_runs.sql
-- One row per rotation request. The browser inserts it and reads it.
-- The NDVI worker (service role) writes vegetated, observed_on and error.
-- A farmer never updates those columns: farmer_set_prediction only moves the status.
--
--   ndvi            waiting for the checker
--   running         the checker is running
--   needs_override  vegetated on observed_on; the farmer must cancel or override
--   failed          the checker could not answer
--   cancelled       the farmer cancelled
--   predict         the field is empty, or the farmer overrode; phase 2 may start
--   done            the placeholder results were shown
--
-- Run after 20261045_season_extra_cost.sql. Idempotent.

begin;

create table if not exists public.prediction_runs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  field_id     uuid not null references public.fields (id) on delete cascade,
  status       text not null default 'ndvi'
                 check (status in ('ndvi', 'running', 'needs_override', 'failed', 'cancelled', 'predict', 'done')),
  vegetated    boolean,
  observed_on  date,
  error        text,
  results      jsonb,
  created_at   timestamptz not null default now()
);

comment on table public.prediction_runs is
  'One rotation request. The NDVI worker fills vegetated and observed_on; the farmer only moves the status.';

comment on column public.prediction_runs.observed_on is
  'Sentinel-2 day ndvi_checker.py used. Null when the check has not answered.';

create index if not exists prediction_runs_status_created_idx
  on public.prediction_runs (status, created_at);

alter table public.prediction_runs enable row level security;

drop policy if exists "prediction_runs_select" on public.prediction_runs;
create policy "prediction_runs_select" on public.prediction_runs
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "prediction_runs_insert" on public.prediction_runs;
create policy "prediction_runs_insert" on public.prediction_runs
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and status = 'ndvi'
    and exists (
      select 1 from public.fields f
      where f.id = field_id and f.user_id = (select auth.uid())
    )
  );

revoke all on public.prediction_runs from public, anon;
grant select, insert on public.prediction_runs to authenticated;
grant select, insert, update, delete on public.prediction_runs to service_role;

-- The farmer's three choices. Anything else, including writing the checker's answer, is refused.
create or replace function public.farmer_set_prediction(p_run_id uuid, p_choice text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_user uuid;
begin
  if p_choice not in ('cancel', 'override', 'finish') then
    raise exception 'Unknown choice' using errcode = '22023';
  end if;

  select status, user_id into v_status, v_user
  from public.prediction_runs
  where id = p_run_id
  for update;

  if v_user is null or v_user is distinct from auth.uid() then
    raise exception 'Prediction not found' using errcode = 'P0002';
  end if;

  if p_choice = 'cancel' and v_status in ('needs_override', 'failed') then
    update public.prediction_runs set status = 'cancelled' where id = p_run_id;
  elsif p_choice = 'override' and v_status = 'needs_override' then
    update public.prediction_runs set status = 'predict' where id = p_run_id;
  elsif p_choice = 'finish' and v_status = 'predict' then
    update public.prediction_runs set status = 'done' where id = p_run_id;
  else
    raise exception 'That choice is not available' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.farmer_set_prediction(uuid, text) from public, anon;
grant execute on function public.farmer_set_prediction(uuid, text) to authenticated;

commit;
