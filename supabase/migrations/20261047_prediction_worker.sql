-- 20261047_prediction_worker.sql
-- The NDVI worker writes one heartbeat. The site reads it before a prediction
-- starts, and while the check is still waiting, so a stopped worker cannot
-- leave a request running.
--
-- prediction_worker_live() is true when that heartbeat is under 20 seconds old.
-- Cancel is also allowed from ndvi and running, so the farmer can close a
-- request the worker never took.
--
-- Run after 20261046_prediction_runs.sql. Idempotent.

begin;

create table if not exists public.prediction_worker (
  id      text primary key,
  seen_at timestamptz not null
);

comment on table public.prediction_worker is
  'Last moment the NDVI worker was alive. One row, id ndvi.';

alter table public.prediction_worker enable row level security;

drop policy if exists "prediction_worker_select" on public.prediction_worker;
create policy "prediction_worker_select" on public.prediction_worker
  for select to authenticated
  using (true);

revoke all on public.prediction_worker from public, anon;
grant select on public.prediction_worker to authenticated;
grant select, insert, update on public.prediction_worker to service_role;

create or replace function public.prediction_worker_live()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.prediction_worker
    where id = 'ndvi'
      and seen_at > now() - interval '20 seconds'
  );
$$;

revoke all on function public.prediction_worker_live() from public, anon;
grant execute on function public.prediction_worker_live() to authenticated;

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

  if p_choice = 'cancel' and v_status in ('ndvi', 'running', 'needs_override', 'failed') then
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
