-- 20261048_prediction_via.sql
-- Which process runs the NDVI check for this row.
--   local   the terminal worker (backend/worker/ndvi_worker.py)
--   github  one GitHub Actions run of the same checker (--once)
--
-- Run after 20261047_prediction_worker.sql. Do not re-run 20261046 or 20261047.
-- Idempotent.

begin;

alter table public.prediction_runs
  add column if not exists via text not null default 'local';

alter table public.prediction_runs
  drop constraint if exists prediction_runs_via_check;

alter table public.prediction_runs
  add constraint prediction_runs_via_check
  check (via in ('local', 'github'));

comment on column public.prediction_runs.via is
  'local: the terminal worker. github: one GitHub Actions run of the same checker.';

commit;
