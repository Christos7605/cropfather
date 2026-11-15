# Temperature

Gets the **minimum, mean and maximum temperature** of each polygon over a time window, from two sources:

| | Source | Detail | How often |
|---|---|---|---|
| **Air temperature** (2 m) | NASA POWER (MERRA-2 weather reanalysis) | ~50 km, one value per site | Every day, no gaps |
| **Land surface temperature (LST)** | Landsat 8 + 9 thermal band (Collection 2 Level-2) | 30 m grid, per pixel | A pass about every 8 days, clear days only |

Both are free and need no account. Daily weather is cached in `Data/weather_cache/`.

---

## Setup

```Shell
python -m pip install numpy matplotlib pystac-client planetary-computer stackstac rasterio shapely pyproj requests
```

`common.py` must be in the folder above this script (`Data/`).

## Run

```Shell
python temperature.py --source "path/to/source.json"                          # window = start..end
python temperature.py --source "path/to/source.json" --days 90 --lst-days 60  # windows ending on each polygon's "date"
python temperature.py --source "path/to/source.json" --onlydata               # CSVs only
```

| Option | What it does | Default |
|---|---|---|
| `--source` | JSON from the map page or build_dataset.py | required |
| `--days N` | Air temperature: the N days ending on each polygon's `"date"` | start..end |
| `--lst-days N` | Landsat: the N days ending on each polygon's `"date"` | start..end |
| `--onlydata` | Write only the CSVs, without images | off |
| `--out` | Output folder | `temperature_output` |

The script uses `max_cloud` from the JSON: a Landsat pass is skipped if more than that % of the polygon is cloud.

---

## Output

**`temperature.csv`**, one row per site:

| Column | Meaning |
|---|---|
| `air_days` | Days of air temperature in the window |
| `air_min_c` / `air_mean_c` / `air_max_c` | Coldest daily minimum / average of daily means / hottest daily maximum |
| `hot_days_over_30c` | Days with a maximum above 30 °C |
| `lst_passes` | Clear Landsat passes in the window |
| `lst_min_c` / `lst_mean_c` / `lst_max_c` | Coldest pixel / average of the passes' means / hottest pixel |
| `lst_minus_air_c` | Average over passes of (surface mean − that day's air max). Crops that transpire stay cool; stressed crops and bare soil run hot |

**`temperature_passes.csv`** has one row per clear pass (date, satellite, cloud %, LST min/mean/max, that day's air temperature).

**Images** (`<site>/<date>_LST.png`, not with `--onlydata`): every 30 m pixel is shown, clipped to the polygon. Clouds and water are light grey.

---

## Notes

- **Land surface temperature isn't air temperature.** On a sunny day, dry bare soil can be 10–20 °C hotter than the air.
- **Landsat only sees through clear skies.** A cloudy window may have no passes; air temperature is always available.
- **Errors don't stop the run.** If the Landsat search fails for one polygon, it still gets its air temperature, and the other polygons carry on.
