# second_model – field data

`all_field_data.py` collects everything the pruning model needs to know about **one field** and saves it as
**one row** in `field_data/field_data.csv`. It reuses the data scripts in `Backend/Data/` and does not change them.

## Input

| | |
|---|---|
| `points` | the field boundary, a list of `[lon, lat]` |
| `end` | the date the farmer runs the app (`YYYY-MM-DD`) |

```python
from all_field_data import get_field_data
field_info = get_field_data(field["points"], field["end"])
```

## The idea

The farmer wants to know what to plant **for the coming season**, which hasn't happened yet.
So instead of measuring the past few months, we look at **the same coming months in past years** and average them.

```
end date = 2025-11-30   ->   coming season = the next 6 months (Dec .. May)

        2022-12-01 .. 2023-05-30   ┐
        2023-12-01 .. 2024-05-30   ├─ averaged -> one "typical" coming season
        2024-12-01 .. 2025-05-30   ┘
```

Settings at the top of `all_field_data.py`:

| Setting | Value | Meaning |
|---|---|---|
| `SEASON_MONTHS` | 6 | length of the coming season |
| `CLIMATE_YEARS` | 3 | number of past years averaged |

## What each value covers

| Data | Period | Source |
|---|---|---|
| Elevation | once (doesn't change) | `Data/elevation` |
| Soil clay / sand (0–30 cm) | once | `Data/soil` |
| Soil pH (0–30 cm) | once – SoilGrids 2.0 is a single map, there is no pH time series | `Data/soil_ph` (new) |
| `rain_mm` | the 6-month season, mean of 3 years | NASA GPM IMERG |
| `rain_annual_mm` | the 12 months ending on the season's last day, mean of 3 years | NASA GPM IMERG |
| `temp_air_*`, `temp_lst_*` | the 6-month season, mean of 3 years | NASA POWER (air), Landsat (surface) |
| `temp_month_1_c` … `temp_month_6_c` | mean air temperature of each coming month, mean of 3 years | NASA POWER daily |
| `temp_coldest_month_c` / `temp_warmest_month_c` | coldest / warmest of those 6 months | – |
| `temp_coldest_month_ever_c` / `temp_warmest_month_ever_c` | coldest / warmest single month of all 18 | – |
| `et_*_mm`, `et_et0_mm` | the 6-month season, mean of 3 years | ECOSTRESS + MODIS |

`climate_window` and `climate_years` in the CSV record which months and years were used.

## Things to know

- **Rain gaps:** NASA's monthly rain is published 3–4 months late. If a month is missing, `rain.py --fill-missing`
  uses the same month one year earlier (other apps calling `rain.py` without the flag are not affected).
- **Air vs surface temperature:** crop temperature limits are air temperatures, so pruning uses the
  `temp_month_*` values. Surface temperature (LST) only covers clear days and runs hot over bare soil.
- **Temperature pruning** compares *monthly means* with the crops' `temp_min` / `temp_max`
  (FAO ECOCROP limits refer to growing-season temperatures, not single cold nights).
- **Air temperature grid is ~50 km**, so a coastal field's real extremes can be a bit stronger.
- **Values** come back as numbers; a missing value is `None`.
- **Run time:** ET and Landsat are the slow parts (3 × 6 months of satellite passes). Rain and air temperature are cached.

## Still missing

- Soil salinity (ECe) – needed for the salinity pruning.
- Groundwater / irrigation water salinity (ECw).