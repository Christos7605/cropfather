# Prediction pipeline

Phase 1 is the NDVI check. Phase 2 is the crop model in `backend/predictor/predictor_model.py`. There is no separate HTTP API: the browser uses the Supabase client. Localhost uses two Python workers. When the NDVI worker is not running, the site starts the check once on GitHub Actions. When that check reaches the model and the row was started on GitHub, the site starts the model once on GitHub Actions too.

## What the farmer sees

`/prediction` lists the farmer's fields. Predict stays disabled until the general questionnaire is complete, and for any field whose own questionnaire is not complete. One request can run at a time. The lock lives in this browser (`fieldshift.prediction.<user id>`) and stores the `prediction_runs` id.

Pressing Predict writes `fields.prediction_requested_on` (the local calendar day, which `model_data.coords.end` reads) and inserts a `prediction_runs` row with status `ndvi`.

`/prediction/fields/:id` then shows two labels, in both languages: "NDVI verification" / "Έλεγχος NDVI", then "Prediction" / "Πρόβλεψη".

1. NDVI verification stays on screen, with an indeterminate bar, until `ndvi_checker.py` finishes. There is no 5 second timer. The checker does not report a percentage. A `local` row is cancelled if the NDVI heartbeat goes stale, so a stopped terminal does not leave the request running. A `github` row stays on this screen through the Actions queue and the package install. If it is still `ndvi` or `running` after 25 minutes, the page cancels it and shows the infrastructure message.
2. If `vegetated` is true, the warning says "As of {date}, this field has vegetation." `{date}` is the Sentinel-2 day the checker returned (`observed_on`). **Cancel prediction** sets the row to `cancelled`, clears the lock, and returns to `/prediction`. **The field is empty** sets the row to `predict`.
3. If `vegetated` is false, both warnings are skipped and the row is already `predict`.
4. If the checker exits 2, crashes, or returns no date, the page says the check could not be completed. The only action is **Cancel prediction**. A new request can then start.
5. Prediction stays on screen, with an indeterminate bar, while the row is `predict` or `scoring`. There is no 20 second timer. The model worker writes `done` and the full recommendations object, or `failed`. A `local` row is cancelled if the predictor heartbeat goes stale. A `github` row calls `dispatch-predict` once. If that call fails, the row is cancelled and the infrastructure message is shown. If a GitHub row is still `predict` or `scoring` 60 minutes after it was created, the page cancels it. The balanced option is the main result. Financial, environmental, and current sit below it, with scores, money, water, comments, warnings, the ranking, and the crops removed before scoring. If the model fails after the vegetation check succeeded, the page says the prediction could not be completed. The only action is **Cancel prediction**.

Leaving during either wait keeps the lock. Coming back follows the row.

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

## The model

`backend/predictor/predictor_model.py`. It reads four JSON files and writes the four choices. Importing the file does not run a prediction.

```text
python backend/predictor/predictor_model.py --general general-info.json --field field-info.json --seasons farmer-seasons.json --coords field-coords.json --out results.json
```

The worker builds those files from `model_data`, in a temporary folder, so the demo files are not overwritten. `field-info.json` keeps `answers.maxMonths` and also sets `maxDays` to `maxMonths × 30`. Earth Engine signs in through `SALINITY_GEE_KEY` inside `backend/predictor/salinity/extra_features.py`. That variable is a path to the service-account file, or the JSON text itself. The model call still passes project `firld-512718`.

The result object keeps the four crop ids at the top (`economic`, `environmental`, `mixed`, `current`) and adds `options`, `ranking`, `removed_by_pruning`, `confidence_pct`, `field`, `inputs`, `weights`, and `notes`. `options` holds one object per choice, with `scores_pct`, `economics_eur_ha`, `water`, `comments`, and `warnings`. A missing choice has `crop: null`. The worker stores that whole object on `prediction_runs.results`.

## Requests

`prediction_runs` (migration `20261046_prediction_runs.sql`, `via` in `20261048_prediction_via.sql`, `scoring` in `20261051_prediction_scoring.sql`):

- The farmer can read their own rows and insert a row with status `ndvi` for a field they own. `via` is `local` or `github`.
- `farmer_set_prediction(run_id, choice)` is the only farmer write: `cancel` from `ndvi`, `running`, `needs_override`, `failed`, `predict`, or `scoring`; `override` from `needs_override`; `finish` from `predict`.
- The NDVI worker, with the service role, writes `vegetated`, `observed_on`, and `error`.
- The model worker writes `results` and moves the row to `done`, or `failed` and `error`.

The page polls its row about once a second. Each terminal worker polls about every 2 seconds. The calls that are not a table read or write are `dispatch-ndvi` and `dispatch-predict`, which ask GitHub to start one run.

## Workers

```text
python backend/worker/ndvi_worker.py
python backend/worker/ndvi_worker.py --once
python backend/worker/predictor_worker.py
python backend/worker/predictor_worker.py --once
```

Both need `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the environment or `backend/.env`. The predictor worker also needs `SALINITY_GEE_KEY` and `SALINITY_GEE_PROJECT` there for a local run. The anon key in `web/.env.local` cannot write either answer.

With no flag, the NDVI worker writes a heartbeat `id = ndvi` and claims only `via = local` rows in `ndvi`. Its `--once` reads `RUN_ID`, claims that row only when it is still `ndvi` and `via = github`, runs the checker, and exits. It does not write a heartbeat.

With no flag, the predictor worker writes a heartbeat `id = predictor` and claims only `via = local` rows in `predict`. It sets them to `scoring`, runs the model, then stores the result. Its `--once` claims `RUN_ID` only when it is still `predict` and `via = github`, does not write a heartbeat, and exits. A second run that finds the row already taken exits without running the model again.

NDVI outcomes:

- vegetated true: status `needs_override`, store the date
- vegetated false: status `predict`, store the date
- no answer, or a crash: status `failed`, no invented date

Model outcomes:

- the recommendations object written: status `done`, `results` stored
- a crash or a timeout: status `failed`, `error` stored

## GitHub Actions

Both workflows are in the cropfather repository.

`.github/workflows/ndvi.yml` runs on `repository_dispatch` of type `ndvi`, on `ubuntu-latest`, with a 30 minute timeout. It installs the checker's packages and runs `python backend/worker/ndvi_worker.py --once` with `RUN_ID` from the dispatch payload.

`.github/workflows/predict.yml` runs on `repository_dispatch` of type `predict`, on `ubuntu-latest`, with a 45 minute timeout. It installs the checker packages plus Earth Engine, pandas, joblib, and scikit-learn. It sets `SALINITY_GEE_KEY` to the `GEE_SERVICE_ACCOUNT_JSON` secret and `SALINITY_GEE_PROJECT` to `firld-512718`, then runs `python backend/worker/predictor_worker.py --once`.

`supabase/functions/dispatch-ndvi/index.ts` checks the caller's JWT, checks that the row is theirs, still `ndvi`, and `via = github`, then dispatches event type `ndvi`. `supabase/functions/dispatch-predict/index.ts` does the same for a row still in `predict`, and dispatches event type `predict`. Both use the Supabase secret `GITHUB_DISPATCH_TOKEN`. Deploy each function with Verify JWT on. The workflow files and the functions live in the cropfather repository. The page and both workers are the same in both copies.

The first model run downloads the Natural Earth coastline into `backend/predictor/salinity/extra_features_cache/`. That folder is gitignored.
