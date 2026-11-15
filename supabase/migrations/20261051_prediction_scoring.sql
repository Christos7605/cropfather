-- 20261051_prediction_scoring.sql
-- Phase 2. The model worker claims a row in predict, marks it scoring while the
-- model runs, then writes done and results, or failed and error.
--
--   scoring   the model is running
--   cancel    also allowed from predict and scoring, so a hung model can be closed
--   prediction_predictor_live()  true when the predictor heartbeat is under 20 seconds old
--
-- prediction_worker_live() stays the NDVI check. Do not re-run 20261046, 20261047,
-- or 20261048. Run after 20261050_crop_cost_approaches.sql. Idempotent.

begin;

do $$
declare
  r record;
begin
  for r in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'prediction_runs'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%status%'
  loop
    execute format('alter table public.prediction_runs drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.prediction_runs
  add constraint prediction_runs_status_check
  check (status in (
    'ndvi', 'running', 'needs_override', 'failed', 'cancelled', 'predict', 'scoring', 'done'
  ));

comment on table public.prediction_worker is
  'Heartbeats. id ndvi is the NDVI worker. id predictor is the model worker.';

create or replace function public.prediction_predictor_live()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.prediction_worker
    where id = 'predictor'
      and seen_at > now() - interval '20 seconds'
  );
$$;

revoke all on function public.prediction_predictor_live() from public, anon;
grant execute on function public.prediction_predictor_live() to authenticated;

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

  if p_choice = 'cancel' and v_status in ('ndvi', 'running', 'needs_override', 'failed', 'predict', 'scoring') then
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

commit;
