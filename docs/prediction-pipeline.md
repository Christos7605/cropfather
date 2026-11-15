# Prediction pipeline

Phase 1 is the NDVI check. Phase 2 is still the 20 second placeholder on the page. There is no separate HTTP API: the browser uses the Supabase client. Localhost uses a Python worker. When that worker is not running, the site starts the same check once on GitHub Actions.

## What the farmer sees

`/prediction` lists the farmer's fields. Predict stays disabled until the general questionnaire is complete, and for any field whose own questionnaire is not complete. One request can run at a time. The lock lives in this browser (`fieldshift.prediction.<user id>`) and stores the `prediction_runs` id.

Pressing Predict writes `fields.prediction_requested_on` (the local calendar day, which `model_data.coords.end` reads) and inserts a `prediction_runs` row with status `ndvi`.

`/prediction/fields/:id` then shows two labels, in both languages: "NDVI verification" / "Έλεγχος NDVI", then "Prediction" / "Πρόβλεψη".

1. NDVI verification stays on screen, with an indeterminate bar, until `ndvi_checker.py` finishes. There is no 5 second timer. The checker does not report a percentage. A `local` row is cancelled if the heartbeat goes stale, so a stopped terminal does not leave the request running. A `github` row stays on this screen through the Actions queue and the package install. If it is still `ndvi` or `running` after 25 minutes, the page cancels it and shows the same infrastructure message.
2. If `vegetated` is true, the warning says "As of {date}, this field has vegetation." `{date}` is the Sentinel-2 day the checker returned (`observed_on`). **Cancel prediction** sets the row to `cancelled`, clears the lock, and returns to `/prediction`. **The field is empty** sets the row to `predict`. The checker has already finished, so there is no extra wait before phase 2.
3. If `vegetated` is false, both warnings are skipped and phase 2 starts.
4. If the checker exits 2, crashes, or returns no date, the page says the check could not be completed. The only action is **Cancel prediction**. A new request can then start.
5. Prediction still runs for 20 seconds and shows four placeholders, in this order: Environmentally best, Financially best, Current, Balanced. The page then sets the row to `done` and clears the lock.

Leaving during NDVI keeps the lock. Coming back follows the row, so a finished check shows its warning instead of starting again.

## The checker

`backend/Data/salt_indexes/ndvi_checker.py`. Python, NumPy, and a Sentinel-2 download. It does not run in a Supabase Edge Function.

```text
python ndvi_checker.py --source source.json
```

The source JSON is `model_data.coords`: `features[].coords` as `[lon, lat]`, `start` 2023-07-01, `end` the day Predict was pressed, `max_cloud` 15.

Output, one object:

```json
{ "site": "site1_polygon", "vegetated": true, "date": "2026-03-28" }
```

`vegetated` is true when mean NDVI is above the script default 0.3. That threshold stays in the program. Exit 0 means an answer. Exit 2 means no usable date, and `vegetated` and `date` are null. A null answer is a failure, not a vegetation warning.

## Requests

`prediction_runs` (migration `20261046_prediction_runs.sql`, plus `via` in `20261048_prediction_via.sql`):

- The farmer can read their own rows and insert a row with status `ndvi` for a field they own. `via` is `local` or `github`.
- `farmer_set_prediction(run_id, choice)` is the only farmer write: `cancel` from `ndvi`, `running`, `needs_override`, or `failed`; `override` from `needs_override`; `finish` from `predict`.
- The worker, with the service role, writes `vegetated`, `observed_on`, and `error`.

The page polls its row about once a second. The terminal worker polls about every 2 seconds. The only call that is not a table read or write is `dispatch-ndvi`, which asks GitHub to start one run.

## Worker

```text
python backend/worker/ndvi_worker.py
python backend/worker/ndvi_worker.py --once
```

It needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the environment or `backend/.env`. The anon key in `web/.env.local` cannot write the checker's answer.

With no flag, it writes a heartbeat every 2 seconds and claims only `via = local` rows. `--once` reads `RUN_ID`, claims that row only when it is still `ndvi` and `via = github`, runs the checker, and exits. It does not write a heartbeat. A second run that finds the row already taken exits without running the checker again.

Either start then:

- vegetated true: status `needs_override`, store the date
- vegetated false: status `predict`, store the date
- no answer, or a crash: status `failed`, no invented date

Rows already in `predict` are left for the page. Phase 2's model is not called yet.

## GitHub Actions

The workflow is `.github/workflows/ndvi.yml` in the cropfather repository. It runs on `repository_dispatch` of type `ndvi`, on `ubuntu-latest`, with a 30 minute timeout. It installs the checker's packages and runs `python backend/worker/ndvi_worker.py --once` with `RUN_ID` from the dispatch payload.

`supabase/functions/dispatch-ndvi/index.ts` checks the caller's JWT, checks that the row is theirs, still `ndvi`, and `via = github`, then `POST`s `https://api.github.com/repos/Christos7605/cropfather/dispatches` with `event_type` `ndvi` and `client_payload.run_id`. The token is the Supabase secret `GITHUB_DISPATCH_TOKEN`. Deploy that function with Verify JWT on. The workflow file and the function live in the cropfather repository. The page and the worker are the same in both copies.
