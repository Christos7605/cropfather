#!/usr/bin/env python3
"""
Runs every data script (with --onlydata where it exists) for one source.json and merges
their CSVs into two machine-learning-ready tables.

    python all_data.py --source source.json
    python all_data.py --source source.json --only elevation soil      # run just some of them
    python all_data.py --source source.json --skip evapotranspiration  # run all but some

Folder layout (all_data.py sits in Data/):
    Data/
      all_data.py
      source.json
      elevation/elevation.py
      rain/rain.py
      ...
If a script isn't at the path written below, it is searched for anywhere inside Data/.

Output (in --out, default all_data_output/)
    all_data.csv           ONE ROW PER SITE, fixed columns (no dates in the column names).
                           Time series are summarised over the whole date range,
                           e.g. rain_mm_sum, et_mean_mm_mean, temp_air_max_c_max, index_SI2_mean_mean.
                           -> one row = one sample for a model.
    all_data_monthly.csv   ONE ROW PER SITE AND MONTH: site, month, rain_mm, et_mean_mm, temp_air_max_c, ...
                           -> for seasonal features or time-series models.
    raw/<script>/...       the original CSVs of each script (kept for checking)

Dates: a site with a "date" (its sampling date, as build_dataset.py writes) gets windows that END
on that date - CLIMATE_DAYS for rain / air temperature / ET, SATELLITE_DAYS for the satellite
indexes and surface temperature. Sites without one use the JSON's start..end.
A script that crashes only while Python shuts down, after writing its CSV, keeps its data.
"""
import argparse
import csv
import json
import shutil
import statistics
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent

# ================================================================================================
#  SCRIPTS - edit this list to change what runs and which columns you get.
#
#  name    : short name (used with --only / --skip and for the raw output folder)
#  script  : path of the .py file, relative to this Data/ folder
#  args    : extra command options, exactly as you would type them
#            (--source and --out are added automatically)
#  csvs    : which CSVs to read, and how:
#     prefix  : start of every column name from this CSV
#     keys    : fixed categories that become part of the column name (depth, index name ...)
#     copy    : columns copied as they are (for data without dates: elevation, soil)
#     time    : "date" or "month" column, for time series
#     summary : {column: [how to summarise over the whole range]} -> all_data.csv
#               choices: mean, sum, min, max, count, median
#     monthly : columns averaged per month -> all_data_monthly.csv
# ================================================================================================
CLIMATE_DAYS = "90"      # rain, air temperature, ET: the 90 days ending on each site's sampling "date"
SATELLITE_DAYS = "60"    # Sentinel-2 indexes, Landsat surface temperature: the 60 days ending on it
# (sites without a "date" - e.g. from the map page - use the JSON's start..end instead)
IDLE_MINUTES = 15        # a script that prints nothing for this long is stuck (e.g. a dead download): it is
                         # stopped and its data left out, so the next script still runs. None = never stop.

SCRIPTS = [
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
        "args": [],                                    # CSV-only script, no --onlydata needed
        "csvs": {"soil.csv": {"prefix": "soil", "copy": ["clay_pct", "sand_pct"]}},
    },
    {
        "name": "rain",
        "script": "rain/rain.py",
        "args": ["--days", CLIMATE_DAYS],              # CSV-only script, no --onlydata needed
        "csvs": {"rain.csv": {"prefix": "rain", "copy": ["rain_mm"]}},
    },
    {
        "name": "temperature",
        "script": "temperature/temperature.py",
        "args": ["--onlydata", "--days", CLIMATE_DAYS, "--lst-days", SATELLITE_DAYS],
        "csvs": {"temperature.csv": {
            "prefix": "temp",
            "copy": ["air_min_c", "air_mean_c", "air_max_c", "hot_days_over_30c", "lst_passes",
                     "lst_min_c", "lst_mean_c", "lst_max_c", "lst_minus_air_c"]}},
    },
    {
        "name": "evapotranspiration",
        "script": "evapotranspiration/evapotranspiration.py",
        "args": ["--onlydata", "--days", CLIMATE_DAYS],   # e.g. add "--min-hour", "10"
        "csvs": {"et_window.csv": {
            "prefix": "et",
            "copy": ["et_mean_mm", "et_min_mm", "et_max_mm", "et0_mm", "kc_mean", "good_dates",
                     "modis_days", "source"]}},
    },
    {
        "name": "salt_indexes",
        "script": "salt_indexes/salt_indexes.py",
        "args": ["--onlydata", "--days", SATELLITE_DAYS, "--mode", "SI2", "BI", "NDSI", "NDVI", "NDMI", "CRSI"],
        "csvs": {"index_values.csv": {
            "prefix": "index", "keys": ["index"], "time": "date",
            "summary": {"mean": ["mean", "min", "max", "count"]},
            "monthly": ["mean"]}},
    },
]
# ================================================================================================

AGGREGATES = {"mean": statistics.fmean, "sum": sum, "min": min, "max": max,
              "median": statistics.median, "count": len}


def find_script(rel_path):
    p = HERE / rel_path
    if p.exists():
        return p
    found = sorted(HERE.rglob(Path(rel_path).name))
    return found[0] if found else None


def run_watched(name, cmd, cwd):
    """Run one script, pass its output on as it comes, and stop it if it goes silent for
    IDLE_MINUTES (network calls without a timeout can wait forever). Returns the exit code."""
    # stdin is inherited, as before: run by hand, a login prompt can still be answered (under
    # build_dataset.py the input is already empty, so a prompt fails at once there).
    # UTF-8 output, so the bytes passed on below show correctly in the console.
    env = {**os.environ, "PYTHONIOENCODING": os.environ.get("PYTHONIOENCODING", "utf-8")}
    proc = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
    last = [time.time()]

    def pump():                                       # raw bytes: progress bars without a newline count too
        out = sys.stdout.buffer
        while chunk := os.read(proc.stdout.fileno(), 4096):
            last[0] = time.time()
            out.write(chunk)
            out.flush()

    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    while True:
        try:
            proc.wait(timeout=2)                      # returns the moment the script ends
            break
        except subprocess.TimeoutExpired:             # still running: check it isn't stuck
            if IDLE_MINUTES and time.time() - last[0] > IDLE_MINUTES * 60:
                print(f"\n!! {name}: no output for {IDLE_MINUTES} min - stopped (stuck download or login?)",
                      flush=True)
                proc.kill()
                proc.wait()
                break
    reader.join(timeout=10)
    return proc.returncode


def run(entry, source, raw_dir):
    """Run one script; return its output folder, or None if it failed."""
    script = find_script(entry["script"])
    if script is None:
        print(f"!! {entry['name']}: {entry['script']} not found - skipped")
        return None
    out = raw_dir / entry["name"]
    cmd = [sys.executable, str(script), "--source", str(source), "--out", str(out), *entry["args"]]
    print(f"\n{'=' * 80}\n>> {entry['name']}: {' '.join(cmd[1:])}\n{'=' * 80}", flush=True)
    shutil.rmtree(out, ignore_errors=True)                          # no leftovers from an earlier run
    rc = run_watched(entry["name"], cmd, script.parent)               # output is shown live
    if rc != 0:
        # Some scripts crash while Python shuts down (GDAL threads on Windows) AFTER writing
        # their CSV. If every CSV is there, the data is fine: keep it.
        if all((out / name).exists() for name in entry["csvs"]):
            print(f"   ({entry['name']} exited with code {rc} after writing its data - data kept)")
            return out
        print(f"!! {entry['name']} failed - its data is left out")
        return None
    return out


def col_name(prefix, keys, col, agg=None):
    """prefix + key values + column (without a repeated prefix) + aggregate."""
    if col.startswith(prefix + "_"):
        col = col[len(prefix) + 1:]
    return "_".join(p for p in (prefix, *keys, col, agg) if p)


def number(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def merge_csv(path, spec, sites, monthly):
    """Add one CSV to the per-site table and the per-site-month table."""
    with open(path, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    prefix, keys, time = spec["prefix"], spec.get("keys", []), spec.get("time")
    groups, month_groups = {}, {}
    for row in rows:
        site = str(row["site"]).split("_")[0]          # 'site1_polygon' -> 'site1'
        kv = tuple(row[k] for k in keys)
        for col in spec.get("copy", []):
            sites.setdefault(site, {})[col_name(prefix, kv, col)] = row.get(col, "")
        for col in spec.get("summary", {}):
            if (x := number(row.get(col))) is not None:
                groups.setdefault((site, kv, col), []).append(x)
        if time:
            month = row[time][:7]
            for col in spec.get("monthly", []):
                if (x := number(row.get(col))) is not None:
                    month_groups.setdefault((site, month, col_name(prefix, kv, col)), []).append(x)

    for (site, kv, col), vals in groups.items():
        for agg in spec["summary"][col]:
            sites.setdefault(site, {})[col_name(prefix, kv, col, agg)] = round(AGGREGATES[agg](vals), 4)
    for (site, month, name), vals in month_groups.items():
        monthly.setdefault((site, month), {})[name] = round(statistics.fmean(vals), 4)
    return len(rows)


def write(path, key_cols, rows):
    """rows: list of (key values, {column: value}). Columns kept in the order they first appear."""
    columns = key_cols + list(dict.fromkeys(c for _, cells in rows for c in cells))
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=columns, restval="")
        w.writeheader()
        for keys, cells in rows:
            w.writerow({**dict(zip(key_cols, keys)), **cells})
    return len(columns) - len(key_cols)


def site_order(s):
    return int(s[4:]) if s[4:].isdigit() else 0


def main():
    ap = argparse.ArgumentParser(description="Run all data scripts and merge their CSVs for machine learning.")
    ap.add_argument("--source", required=True, help="JSON saved by the map page")
    ap.add_argument("--out", default=str(HERE / "all_data_output"), help="output folder")
    ap.add_argument("--only", nargs="+", metavar="NAME", help="run only these scripts")
    ap.add_argument("--skip", nargs="+", metavar="NAME", default=[], help="don't run these scripts")
    args = ap.parse_args()

    source = Path(args.source).resolve()
    out = Path(args.out).resolve()
    raw_dir = out / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    names = [e["name"] for e in SCRIPTS]
    for n in (args.only or []) + args.skip:
        if n not in names:
            ap.error(f"unknown script '{n}'. Available: {', '.join(names)}")
    todo = [e for e in SCRIPTS if (not args.only or e["name"] in args.only) and e["name"] not in args.skip]

    # site centres and date range straight from source.json
    req = json.loads(source.read_text(encoding="utf-8"))
    sites = {f"site{i}": {"centre_lon": round(sum(c[0] for c in f["coords"]) / len(f["coords"]), 6),
                          "centre_lat": round(sum(c[1] for c in f["coords"]) / len(f["coords"]), 6),
                          **({"date": f["date"]} if f.get("date") else
                             {"start": req.get("start", ""), "end": req.get("end", "")})}
             for i, f in enumerate(req["features"], 1)}
    monthly = {}

    summary = []
    for entry in todo:
        folder = run(entry, source, raw_dir)
        if folder is None:
            summary.append(f"{entry['name']}: FAILED / not found")
            continue
        for csv_name, spec in entry["csvs"].items():
            path = folder / csv_name
            if path.exists():
                summary.append(f"{entry['name']}: {csv_name} ({merge_csv(path, spec, sites, monthly)} rows)")
            else:
                summary.append(f"{entry['name']}: {csv_name} missing (no data for these dates?)")

    n_site = write(out / "all_data.csv", ["site"],
                   [((s,), sites[s]) for s in sorted(sites, key=site_order)])
    n_month = write(out / "all_data_monthly.csv", ["site", "month"],
                    [(k, monthly[k]) for k in sorted(monthly, key=lambda k: (site_order(k[0]), k[1]))])

    print(f"\n{'=' * 80}\nSummary")
    for line in summary:
        print("  " + line)
    print(f"\nall_data.csv:         {len(sites)} site(s) x {n_site} columns")
    print(f"all_data_monthly.csv: {len(monthly)} site-month rows x {n_month} columns")
    print(f"-> {out}")


if __name__ == "__main__":
    main()