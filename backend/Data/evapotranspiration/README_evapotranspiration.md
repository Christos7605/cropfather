# Evapotranspiration (ET)

Gets **ECOSTRESS** evapotranspiration (70 m pixels) for the polygons and dates in `source.json`. For each good satellite pass and each month it gives the **minimum, mean, typical maximum and actual maximum** ET.

**Data:** ECOSTRESS version 3 where it exists, otherwise version 2. Together they cover **July 2018 to now** (ECOSTRESS was launched in June 2018, so there is nothing earlier). Version 3's archive is still being filled in, which is why older dates come from version 2.

ET is the water that actually leaves the field (soil evaporation + plant transpiration). Fields that use less water than their neighbours can be a sign of salt stress.

---

## Setup

```Shell
python -m pip install numpy pillow matplotlib earthaccess requests pyproj
```

You need a free **NASA Earthdata** account (https://urs.earthdata.nasa.gov). The first run asks for your username and password, then remembers them.

## Run

```Shell
python evapotranspiration.py --source "path/to/source.json"              # CSVs + images
python evapotranspiration.py --source "path/to/source.json" --onlydata   # CSVs only
python evapotranspiration.py --source "path/to/source.json" --days 90    # the 90 days ending on each polygon's "date"
```

| Option | What it does | Default |
|---|---|---|
| `--source` | JSON saved by the map page | required |
| `--onlydata` | Write only the CSVs, without images | off |
| `--days N` | Use the N days ending on each polygon's `"date"` (polygons without one use start..end) | off |
| `--no-modis` | Don't fill the days before 9 July 2018 with MODIS | off |
| `--out` | Output folder | `et_output` |
| `--min-hour` | Earliest usable satellite pass (solar time) | `9` |
| `--max-hour` | Latest usable satellite pass (solar time) | `17` |

The script reads `features[].coords`, `start` and `end` from the JSON.

---

## How it works

1. **Search and download.** It searches version 3 first, then fills every pass it doesn't have from version 2. Passes taken too early or late in the day are dropped before downloading. The rest are downloaded **one pass at a time** (daily ET, water mask, cloud mask), read, and deleted, so long date ranges don't fill your disk.
2. **Keep only good passes.** A pass is skipped if:
   - it was taken too early or too late in the day (outside 9–17 h solar time), since daily ET from morning or evening passes is unreliable;
   - it doesn't cover the whole polygon;
   - the polygon is completely cloudy or all water.

   Water and cloudy pixels are masked; the rest is kept.
3. **Estimate monthly ET.** On each good date, every pixel gets **Kc = ET ÷ ET₀**. ET₀ is the FAO-56 reference ET, calculated from NASA POWER daily weather (free, no request limit, cached in `Data/weather_cache/`). Kc is filled in day by day between that pixel's own clear dates and multiplied by each day's ET₀. The days are then added up for each month.
4. **Clean up.** The downloaded `.tif` files are deleted at the end, even if the script stops with an error.

---

## Output

```
et_output/
├── et_daily.csv                  one row per site and good pass
├── et_monthly.csv                one row per site and month
└── site1/                        (not with --onlydata)
    ├── 2026-07-05_ET.png         ET map of each good pass
    └── 2026-07_ET_month.png      estimated monthly ET map
```

**`et_daily.csv`** (mm/day):

| Column | Meaning |
|---|---|
| `site`, `date`, `time_utc` | Which field and when the satellite passed |
| `version` | ECOSTRESS version the pass came from (`v003` or `v002`) |
| `clear_pct` | % of the polygon not covered by cloud |
| `et_min`, `et_mean` | Lowest and average ET |
| `et_max_typical` | Highest ET of the main body of pixels, ignoring a few outliers |
| `et_max` | Highest ET of any pixel |

**`et_window.csv`** (mm over the whole window), one row per site. This is what build_dataset.py uses:

| Column | Meaning |
|---|---|
| `start`, `end`, `days` | The window used |
| `source` | `ECOSTRESS`, `MODIS` or `MODIS+ECOSTRESS` |
| `modis_days`, `good_dates` | Days covered by MODIS / clear ECOSTRESS passes in the window |
| `et0_mm` | Reference ET over the window |
| `et_min_mm`, `et_mean_mm`, `et_max_typical_mm`, `et_max_mm` | ET over the window (mm) |
| `kc_mean` | `et_mean_mm ÷ et0_mm`: how much water the field used compared with a well-watered reference |

**`et_monthly.csv`** (mm/month):

| Column | Meaning |
|---|---|
| `site`, `month` | Which field and month |
| `days` | Days of the month inside the date range |
| `good_dates` | Good passes in that month (0 = estimated from the nearest months) |
| `et0_mm` | Reference ET for the month |
| `et_min_mm`, `et_mean_mm`, `et_max_typical_mm`, `et_max_mm` | Same as above, for the monthly total |

**Typical maximum:** a few pixels far above the rest are treated as outliers. A pixel counts as an outlier if it is above the upper quartile + 1.5 × the spread, but **only if such pixels are at most 5%** of the polygon. If more pixels are that high, they're real (e.g. one well-irrigated corner), and the typical max equals the actual max.

**Images:** a smooth map clipped to the polygon. Colours span the **common range**; outlier pixels above it are shown in **magenta** and below it in **black**. The title gives min, mean, typical max and actual max.

---

## Notes

- **Known gaps with no data at all:** 29 Sep – 4 Dec 2018, 14 Mar – 14 May 2019, and 17 Feb 2020. Months in those gaps are estimated from the nearest good dates (`good_dates` = 0).
- **Units:** if a version-2 file stores ET in W/m² instead of mm/day, the script detects it and converts it automatically.
- **ECOSTRESS** flies on the International Space Station, so passes come at different times of day and are irregular. Expect roughly 2–6 good dates per month in summer and fewer in cloudy months. Use `good_dates` to judge how reliable a monthly value is.
- **Before 9 July 2018** (no ECOSTRESS yet), ET comes from **MODIS** MOD16A2GF (500 m, 8-day). Reading it needs `python -m pip install pyhdf`. MODIS tiles are kept in `modis_cache/` and reused.
- **Errors don't stop the run.** A failing download or polygon is reported (lines starting with `!!`), and the rest carry on.
- `common.py` must be in the folder above this script (`Data/`).
- **ET is modelled from satellite data, not measured.** Single days can be noisy, and monthly totals are more reliable.
