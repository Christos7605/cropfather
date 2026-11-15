#!/usr/bin/env python3
"""
Collects the data the second model needs for ONE field, using the data scripts in Backend/Data.

    python all_field_data.py --field field.json   # field.json: {"points": [[lon, lat], ...], "end": "YYYY-MM-DD"}
    python all_field_data.py --field field.json --refresh   # ignore what is saved, collect everything again

or from code (e.g. main.py):
    from all_field_data import get_field_data
    field_info = get_field_data(field["points"], field["end"])

The "end" date is the day the farmer runs the app; the crop is for the coming season. So:
  - soil, soil pH, elevation: read once (they don't change from season to season).
  - rain, temperature, evapotranspiration: CLIMATE - the SEASON_MONTHS after the end date, taken in
    each of the last CLIMATE_YEARS years and averaged. E.g. end 2025-11-30, 6 months, 2 years:
    2024-12-01..2025-05-30 and 2023-12-01..2024-05-30.
    Annual rain (rain_annual_mm) is the 12 months ending on the same day, also averaged.

Folder layout:
    Backend/
      Data/                     all_data.py + the data scripts (rain/, soil/, ...) - reused, not copied
      second_model/
        all_field_data.py       this file
        field_data/             output
          field_data.csv        ONE ROW for the field
          raw/static/<script>/  CSVs of soil, soil pH, elevation
          raw/<year>/<script>/  CSVs of rain, temperature, ET for each past season
          request.json          which field / end date / settings the saved data belongs to

Reuse: nothing is downloaded twice.
  - Same field, same end date, same settings, field_data.csv there -> it is loaded, nothing runs.
  - Otherwise every script whose CSV is already in raw/ is reused and only the missing ones run
    (e.g. a script that failed last time, or a new season window after the end date changed).
  - A DIFFERENT field (other points) -> the old raw/ data is deleted first, so fields never mix.
  - refresh=True / --refresh -> everything is collected again.
"""
import argparse
import calendar
import csv
import importlib.util
import json
import shutil
import statistics
import sys
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA_DIR = HERE.parent / "Data"
OUT_DIR = HERE / "field_data"

SEASON_MONTHS = 6       # the coming season: this many months after the end date
CLIMATE_YEARS = 3       # averaged over this many past years (more years = steadier rain estimate)


# Reuse run() and merge_csv() from Backend/Data/all_data.py
_spec = importlib.util.spec_from_file_location("data_all_data", DATA_DIR / "all_data.py")
data = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(data)

# Reuse weather_daily() from Backend/Data/common.py (NASA POWER daily air temperature, cached on disk)
sys.path.insert(0, str(DATA_DIR))
from common import weather_daily  # noqa: E402


# ================================================================================================
#  SCRIPTS - same format as Backend/Data/all_data.py. "{days}" is replaced by the season length.
# ================================================================================================
STATIC_SCRIPTS = [          # read once, for the end date
    {
        "name": "elevation",
        "script": "elevation/elevation.py",
        "args": ["--onlydata"],
        "csvs": {"elevation.csv": {
            "prefix": "elevation",
            "copy": ["elevation_min_m", "elevation_mean_m", "elevation_max_typical_m", "elevation_max_m"]}},
    },
    {
        "name": "soil",
        "script": "soil/soil_data.py",
        "args": [],
        "csvs": {"soil.csv": {"prefix": "soil", "copy": ["clay_pct", "sand_pct"]}},
    },
    {
        "name": "soil_ph",
        "script": "soil_ph/soil_ph.py",
        "args": [],
        "csvs": {"soil_ph.csv": {"prefix": "soil", "copy": ["ph_0_30cm", "ph_min", "ph_max"]}},
    },
]

CLIMATE_SCRIPTS = [         # run once per past year, for the season window of that year
    {
        "name": "rain",
        "script": "rain/rain.py",
        "args": ["--days", "{days}", "--fill-missing"],
        "csvs": {"rain.csv": {"prefix": "rain", "copy": ["rain_mm"]}},
    },
    {
        "name": "rain_annual",      # 12 months ending on the same day, for annual_rain_opt_min / max
        "script": "rain/rain.py",
        "args": ["--days", "365", "--fill-missing"],
        "csvs": {"rain.csv": {"prefix": "rain_annual", "copy": ["rain_mm"]}},
    },
    {
        "name": "temperature",
        "script": "temperature/temperature.py",
        "args": ["--onlydata", "--days", "{days}", "--lst-days", "{days}"],
        "csvs": {"temperature.csv": {
            "prefix": "temp",
            "copy": ["air_min_c", "air_mean_c", "air_max_c", "hot_days_over_30c",
                     "lst_min_c", "lst_mean_c", "lst_max_c"]}},
    },
    {
        "name": "evapotranspiration",
        "script": "evapotranspiration/evapotranspiration.py",
        "args": ["--onlydata", "--days", "{days}"],
        "csvs": {"et_window.csv": {"prefix": "et", "copy": ["et_mean_mm", "et_min_mm", "et_max_mm", "et0_mm"]}},
    },
]
RENAME = {"rain_annual_rain_mm": "rain_annual_mm"}
# ================================================================================================


def add_months(d, months):
    """d + months, clipped to the last day of the month (Jan 31 + 1 month = Feb 28/29)."""
    m = d.month - 1 + months
    y, m = d.year + m // 12, m % 12 + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def season_windows(end):
    """[(start, end), ...] of the SEASON_MONTHS after `end`, in each of the last CLIMATE_YEARS years."""
    start = end + timedelta(days=1)
    stop = add_months(end, SEASON_MONTHS)
    return [(add_months(start, -12 * k), add_months(stop, -12 * k)) for k in range(1, CLIMATE_YEARS + 1)]


def write_source(path, points, day):
    """The request, in the format the data scripts expect: windows END on `day`."""
    path.write_text(json.dumps({"features": [{"coords": points, "date": day.isoformat()}],
                                "start": day.isoformat(), "end": day.isoformat()}, indent=2), encoding="utf-8")


def run_scripts(scripts, source, raw_dir, days=None):
    """Run the scripts for one source.json and return the merged values {column: text}.
    A script whose CSVs are already in raw_dir is not run again: its saved CSVs are used."""
    sites, monthly = {"site1": {}}, {}
    for entry in scripts:
        entry = {**entry, "args": [a.replace("{days}", str(days)) for a in entry["args"]]}
        saved = Path(raw_dir) / entry["name"]
        if all((saved / name).exists() for name in entry["csvs"]):
            print(f"   {entry['name']}: already collected - loaded from {saved}")
            folder = saved
        else:
            folder = data.run(entry, source, raw_dir)
        if folder is None:
            print(f"!! {entry['name']}: no data")
            continue
        for csv_name, spec in entry["csvs"].items():
            path = folder / csv_name
            if path.exists():
                data.merge_csv(path, spec, sites, monthly)
            else:
                print(f"!! {entry['name']}: {csv_name} missing")
    return sites["site1"]


def monthly_temperatures(lat, lon, windows):
    """Mean daily air temperature of each coming month, per past year, then averaged over the years.

    Returns columns temp_month_1_c .. temp_month_N_c (3-year average of each month),
    temp_coldest_month_c / temp_warmest_month_c (min / max of those - compare with temp_min / temp_max),
    temp_coldest_month_ever_c / temp_warmest_month_ever_c (min / max of every single month of every year).
    """
    per_month = {}                                    # month number (1..N) -> [mean of each year]
    for start, stop in windows:
        try:
            daily = weather_daily(lat, lon, start, stop)
        except Exception as e:
            print(f"!! monthly temperature {start}..{stop}: {type(e).__name__}: {str(e)[:200]}", flush=True)
            continue
        groups = {}
        for day, w in daily.items():
            if w.get("tmean") is not None:
                n = (day.year - start.year) * 12 + day.month - start.month + 1
                groups.setdefault(n, []).append(w["tmean"])
        for n, vals in groups.items():
            per_month.setdefault(n, []).append(statistics.fmean(vals))

    row = {f"temp_month_{n}_c": round(statistics.fmean(v), 2) for n, v in sorted(per_month.items())}
    if row:
        every = [x for v in per_month.values() for x in v]
        row.update(temp_coldest_month_c=min(row.values()), temp_warmest_month_c=max(row.values()),
                   temp_coldest_month_ever_c=round(min(every), 2), temp_warmest_month_ever_c=round(max(every), 2))
    return row


def _value(v):
    """CSV text -> number where possible; empty -> None (no data); other text stays text."""
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return v


def _request(points, end):
    """What the saved data depends on: the field's points, the end date and the season settings."""
    return {"points": [[round(float(lon), 6), round(float(lat), 6)] for lon, lat in points],
            "end": end, "season_months": SEASON_MONTHS, "climate_years": CLIMATE_YEARS}


def _load_saved(out_dir, request, refresh):
    """field_data.csv as a dict if it belongs to exactly this request, else None.
    Also clears raw/ when the saved data is for another field (or refresh is asked)."""
    meta, result = out_dir / "request.json", out_dir / "field_data.csv"
    old = None
    if meta.exists():
        try:
            old = json.loads(meta.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            old = None
    if refresh or old is None or old.get("points") != request["points"]:
        if (out_dir / "raw").exists() or result.exists():
            why = "refresh asked" if refresh else "different field" if old else "no record of which field it was"
            print(f"Saved data not reused ({why}) - collecting again")
        shutil.rmtree(out_dir / "raw", ignore_errors=True)
        result.unlink(missing_ok=True)
        return None
    if old == request and result.exists():
        with open(result, newline="", encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh))
        if rows:
            return {k: _value(v) for k, v in rows[0].items()}
    return None                                       # same field, other date/settings: reuse raw/ only


def get_field_data(points, end, out_dir=OUT_DIR, refresh=False):
    """Data for one field as a dict (also saved as field_data.csv).
    Loads the saved data when it is for the same field and end date; refresh=True collects it again."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    end_day = date.fromisoformat(end)
    request = _request(points, end)
    saved = _load_saved(out_dir, request, refresh)
    if saved is not None:
        print(f"All data for this field and end date already collected - loaded {out_dir / 'field_data.csv'}")
        return saved
    row = {"centre_lon": round(sum(p[0] for p in points) / len(points), 6),
           "centre_lat": round(sum(p[1] for p in points) / len(points), 6),
           "date": end}

    # soil, soil pH, elevation: once
    raw = out_dir / "raw" / "static"
    raw.mkdir(parents=True, exist_ok=True)
    write_source(raw / "source.json", points, end_day)
    row.update(run_scripts(STATIC_SCRIPTS, raw / "source.json", raw))

    # rain, temperature, ET: the coming season, in each past year
    windows = season_windows(end_day)
    per_year = []
    for start, stop in windows:
        raw = out_dir / "raw" / f"{start}_{stop}"
        raw.mkdir(parents=True, exist_ok=True)
        write_source(raw / "source.json", points, stop)
        print(f"\n######## season {start} .. {stop} ########")
        per_year.append(run_scripts(CLIMATE_SCRIPTS, raw / "source.json", raw, days=(stop - start).days + 1))

    # mean over the years that have a value
    for col in dict.fromkeys(c for year in per_year for c in year):
        vals = [_value(year.get(col)) for year in per_year]
        nums = [v for v in vals if isinstance(v, float)]
        row[RENAME.get(col, col)] = round(statistics.fmean(nums), 2) if nums else ""
    row.update(monthly_temperatures(row["centre_lat"], row["centre_lon"], windows))
    row["climate_window"] = f"{windows[0][0]:%m-%d}..{windows[0][1]:%m-%d}"
    row["climate_years"] = " ".join(f"{s.year}/{e.year}" if s.year != e.year else str(s.year)
                                    for s, e in windows)

    with open(out_dir / "field_data.csv", "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(row))
        writer.writeheader()
        writer.writerow(row)
    (out_dir / "request.json").write_text(json.dumps(request, indent=2), encoding="utf-8")
    print(f"\nfield_data.csv: {len(row)} columns -> {out_dir / 'field_data.csv'}")
    return {k: _value(v) for k, v in row.items()}


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Collect the second model's data for one field.")
    ap.add_argument("--field", required=True, help='JSON with "points" [[lon, lat], ...] and "end" (YYYY-MM-DD)')
    ap.add_argument("--out", default=str(OUT_DIR), help="output folder")
    ap.add_argument("--refresh", action="store_true", help="ignore saved data and collect everything again")
    args = ap.parse_args()
    field = json.loads(Path(args.field).read_text(encoding="utf-8"))
    get_field_data(field["points"], field["end"], args.out, refresh=args.refresh)