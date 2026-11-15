# Prediction pipeline

The prediction page is in place. The two checks it stands in for are not. This note is the contract for wiring them later, without adding a separate HTTP API.

## What the farmer sees

`/prediction` lists the farmer's fields. Predict stays disabled until the general questionnaire is complete, and for any field whose own questionnaire is not complete. One request can run at a time. The lock lives in this browser (`fieldshift.prediction.<user id>`). Starting a request also writes `fields.prediction_requested_on` (the local calendar day). `model_data.coords.end` reads that day.

`/prediction/fields/:id` then runs two phases. The labels are bilingual: "NDVI verification" / "Έλεγχος NDVI", then "Prediction" / "Πρόβλεψη". A progress state stays on screen from arrival until the four results.

The times below are placeholders. They go away when the worker below exists. The labels stay.

1. NDVI verification runs for 5 seconds, then the page always shows the vegetation warning. A real check shows that warning only when the field comes back vegetated.
2. **Cancel prediction** clears the lock and returns to `/prediction`. Another request, on this field or another, can start.
3. **The field is empty** ("Το χωράφι είναι άδειο") is the override. The farmer is telling us the check is wrong and the field is empty. NDVI verification continues for 3 more seconds, then the label changes.
4. Prediction runs for 20 seconds and shows four placeholders, in this order:
   - Environmentally best
   - Financially best
   - Current
   - Balanced

Showing the four results also clears the lock. Leaving the page mid-run keeps the lock; coming back starts again from NDVI verification. Refreshing after the results drops the placeholders, because they are only on the page until the worker stores them.

## Where the NDVI program lives

`backend/Data/salt_indexes/ndvi_checker.py` (the folder is `salt_indexes`). It is a Python program: NumPy, Planetary Computer, and the same Sentinel-2 download as `salt_indexes.py`. It is not something to run inside a Supabase Edge Function. Edge Functions are Deno, have a short timeout, and cannot host this stack or a satellite download.

```text
python ndvi_checker.py --source source.json
```

The source JSON is the same shape as `model_data.coords`: one feature, `coords` as `[lon, lat]`, `start`, `end`, `max_cloud`. Today those are `start` 2023-07-01, `end` the day Predict was pressed (or 2023-07-31 until then), `max_cloud` 15.

A date counts as usable when the footprint covers the shape, no-data is at most 0.1%, and cloud or shadow inside the shape is at most `max_cloud`. `--date 1` is the last usable date at or before `end`.

The program writes one object per site: `vegetated` is true when NDVI is above `--max`. The script default is 0.3. That number stays in the worker. The page does not choose the threshold. Exit 0 means every site got an answer. Exit 2 means some site had no usable date (`vegetated` null). A null answer is a failure of the check, not a vegetation warning and not an override.

## Requests, using the Supabase client we already have

The browser already talks to Postgres through `supabase-js`. That is the API. A new public REST service, and an Edge Function in front of it, do not add anything the table insert does not already do.

Add one table, `prediction_runs`, one row per request:

| column | role |
| --- | --- |
| id | the request |
| user_id | the farmer, for row level security |
| field_id | the field |
| status | `ndvi`, `needs_override`, `predict`, `done`, `cancelled`, `failed` |
| vegetated | the checker's answer, null until it returns |
| results | the four rotations, null until phase 2 finishes |
| created_at | when Predict was pressed |

The farmer can read their own rows. They can insert a row in `ndvi`, and they can update their own row only from `needs_override` to `cancelled` or to `predict`. They cannot write `vegetated` or `results`. The worker uses the service role and can.

What the browser does, all through the existing client:

- **Update** `fields.prediction_requested_on`. Already implemented in `recordPredictionRequest`.
- **Insert** a `prediction_runs` row with status `ndvi`. This insert is the start signal. No separate POST.
- **Subscribe** to that row (Realtime, or a short poll of the same select). The page replaces the 5s / 3s / 20s clocks with the row's status, and keeps the two labels.
- **Update** the row to `cancelled` or `predict` when the farmer chooses. Cancel still returns to `/prediction` and clears the lock.

What the worker does. It runs beside `backend/Data`, so `ndvi_checker.py` can import `salt_indexes.py` and `common.py`. It watches `prediction_runs` for `ndvi` and `predict` (Realtime or a poll). It does not need an Edge Function to be told to start.

1. Read `model_data` for that field: `coords`, both questionnaires, and `seasons` (crop, dates, costs including `extra_eur_ha`, income).
2. Write `coords` to a temp JSON file and run `ndvi_checker.py`.
3. Store `vegetated`. If true, set status `needs_override` and wait. The page shows the warning. If false, set status `predict` and continue. If the program exits 2, set status `failed` and show that the check could not be made. Do not invent a vegetation answer.
4. On `predict` (either the field was empty, or the farmer overrode), run the prediction model with the `model_data` row.
5. Store the four results in the order above and set status `done`.

Phase 2's program is not written yet. Until it is, the worker can store the four placeholder kinds and the page renders those. The card order stays environment, financial, current, balanced.

## What not to add

- Do not call `ndvi_checker.py` from the browser, and do not wrap it in an Edge Function. The download is too heavy and the runtime is Python.
- Do not add a GET or POST route of our own for these two phases. Insert, update, select and Realtime on `prediction_runs` are the requests.
- An Edge Function is worth adding only later, if the worker cannot sit where the database is and something has to mint a short-lived job token. It still would not run the checker.
