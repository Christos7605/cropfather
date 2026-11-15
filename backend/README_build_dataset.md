# Build dataset

Builds the **training dataset**: every LUCAS 2018 point, joined with the data gathered for its square around its **sampling date**. The result has one row per point, ready for a machine-learning model.

---

## Folder layout

```
base_folder/
├── pipeline/
│   ├── config.py                    SQUARES_CSV
│   └── output/
│       ├── 01_lucas_points.csv      LUCAS points (POINTID, SURVEY_DATE, EC, ...)
│       └── <squares csv>            one square per point + EC_LABEL
└── backend/
    ├── build_dataset.py             this script (can also sit in backend/Data/)
    └── Data/
        ├── all_data.py              runs every data script for a batch of squares
        ├── common.py                shared helpers (time windows, retries, weather)
        ├── elevation/ soil/ rain/ temperature/ evapotranspiration/ salt_indexes/
        └── finished_dataset.csv     <- result
```

The script finds the folders by itself and prints them at the start.

---

## Setup

Activate the virtual environment first. **The prompt must start with `(venv)`.** Then install everything the data scripts need:

```Shell
.\venv\Scripts\activate
python -m pip install numpy pillow matplotlib requests h5py pyhdf earthaccess pystac-client planetary-computer stackstac xarray rasterio shapely pyproj
```

`pyhdf` reads the MODIS ET files, which cover the LUCAS 2018 dates before ECOSTRESS existed.

---

## Run

```Shell
python build_dataset.py --limit 200                    # test on the first 200 points
python build_dataset.py                                # all points
python build_dataset.py --workers 4                    # more batches at the same time
python build_dataset.py --skip evapotranspiration      # passed on to all_data.py
python build_dataset.py --rebuild                      # just rebuild the CSV from saved progress
```

| Option | What it does | Default |
|---|---|---|
| `--limit N` | Only the first N points | all |
| `--workers N` | Batches processed at the same time | `3` |
| `--batch-size N` | Max points per batch | `40` |
| `--cell D` | Size of a batch area, in degrees | `1.0` |
| `--only NAME …` / `--skip NAME …` | Data scripts to run / not run (passed to all_data.py) | all |
| `--rebuild` | Rebuild `finished_dataset.csv` without downloading anything | off |

Script names: `elevation`, `soil`, `rain`, `temperature`, `evapotranspiration`, `salt_indexes`.

---

## Time windows (the important part)

Every time-dependent value is taken from a window that **ends on the point's sampling date** (D):

| Data | Window | Column examples |
|---|---|---|
| Rain | the **90 days** ending on D | `rain_mm` |
| Air temperature | the **90 days** ending on D | `temp_air_max_c`, `temp_hot_days_over_30c` |
| ET | the **90 days** ending on D | `et_mean_mm`, `et0_mm`, `et_kc_mean` |
| Landsat surface temperature | the **60 days** ending on D | `temp_lst_mean_c`, `temp_lst_minus_air_c` |
| Sentinel-2 indexes | the **60 days** ending on D | `index_NDVI_mean_mean`, `index_SI2_mean_mean` |
| Elevation, soil | — (they don't change) | `elevation_mean_m`, `soil_clay_pct` |

- **D** is `SURVEY_DATE` from `01_lucas_points.csv` (LUCAS format DD-MM-YY). If that column is missing, the square's `end_date` is used.
- **The lengths are set at the top of `all_data.py`** (`CLIMATE_DAYS`, `SATELLITE_DAYS`).
- **New points work the same way.** Give each one a `"date"` (e.g. today) and the same scripts build the same features. A JSON from the map page, with no `"date"`, uses its `start` / `end` as before.
- **ET** comes from **MODIS** (500 m, 8-day) before 9 July 2018 (ECOSTRESS didn't exist yet) and for any point with no clear ECOSTRESS pass. When ECOSTRESS passes exist (70 m), they're used and MODIS fills the days between them. The column `et_source` says which was used.
- **Small squares** (smaller than one pixel) use the pixel under the square's centre.

---

## How it works (and why it's fast)

1. **Dates:** reads every point and its sampling date.
2. **Batches:** groups nearby points into batches (same 1° × 1° area, up to 40 points). One request JSON per batch lists every square with its `id` and `date`.
3. **One all_data.py run per batch.** Logins, searches and downloads are shared by every point in the batch:
   - **Rain:** monthly GPM files are kept in `rain/gpm_cache/` and reused by every batch.
   - **MODIS ET tiles:** kept in `evapotranspiration/modis_cache/` and reused.
   - **Weather:** air temperature and ET₀ come from **NASA POWER**, which is free and has no daily request limit. They're cached in `Data/weather_cache/`.
   - **ECOSTRESS passes:** downloaded once per batch, then deleted.
4. **Results:** each point's row is joined with its LUCAS row and its square (`square_coords`, `start_date`, `end_date`, `max_cloud`, `EC_LABEL`).

---

## Errors

Nothing stops the run:
- **Network calls** are retried automatically (3 tries, with growing waits).
- **A failing site** (one square) only loses that value. The other sites and scripts carry on.
- **A failing script** (e.g. a missing package) only loses its columns for that batch.
- **On screen**, every problem is shown under its batch, with the **POINTID** and the reason:

```
    batch 2: 46000012 temperature (air): RuntimeError: NASA POWER: too many requests
    batch 2: evapotranspiration failed - its data is left out - ModuleNotFoundError: No module named 'pyhdf'
[batch 4/270] lat 47, lon 15: 38/40 points with data (6m 12s) | 10489 points left, ~19h 05m to go
```

- **Logs:** a batch's full log is kept in `Data/_dataset_work/` only if something went wrong.

---

## Stopping and resuming

- **Progress is saved after every batch** (`features_cache.jsonl`). Stop at any time and run the same command again; finished points are skipped.
- **Points that got no data at all** are retried automatically.
- **Redo everything:** delete `features_cache.jsonl`, for example after changing a script or the window lengths.

---

## Output

| File | What it is |
|---|---|
| `finished_dataset.csv` | **The dataset.** One row per point. Rewritten every 10 batches and at the end |
| `features_cache.jsonl` | Saved progress |
| `_dataset_work/requests/` | The request JSON of each batch, to rerun one by hand with all_data.py |
| `_dataset_work/*.log` | Logs of batches that had problems |

---

## Columns

`finished_dataset.csv` keeps only what the model needs (38 columns):

- **Target:** `EC` (mS/m).
- **IDs, not features:** `POINTID`, `TH_LAT`, `TH_LONG` (keep them for spatial cross-validation).
- **Features:** `Depth`, `elevation_mean_m`, soil, rain, temperature, ET (`et_mean_mm`, `et_et0_mm`, `et_kc_mean`) and the index mean/min/max columns.

Columns that repeat another one or only describe how the data was made are left out: `EC_LABEL` (a copy of `EC`), dates, square settings, extra elevation and ET stats, pass/date counts. The list is `DROP_COLUMNS` at the top of `build_dataset.py`. They stay in `features_cache.jsonl`, so after editing the list run `python build_dataset.py --rebuild` (no downloads).

## Notes for training

- **`EC` is the target** (LUCAS EC, mS/m; divide by 100 for dS/m). Most European points are non-saline, so check how many are actually saline before training.
- **Bare-soil indexes** (SI2, BI, NDSI) are often empty when fields are green at sampling time, because vegetation is masked. NDVI, NDMI and CRSI are always filled.
- **Use the same scripts for new points**, with `"date"` set to the day you want the prediction for, so the features mean the same thing as in training.
