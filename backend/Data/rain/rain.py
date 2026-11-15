#!/usr/bin/env python3
"""
Rainfall (NASA GPM IMERG) for the polygons in source.json -> one CSV.

    python rain.py --source source.json              # each site: the request's start..end
    python rain.py --source source.json --days 90    # each site: the 90 days ending on its "date"
    python rain.py --source source.json --days 365 --fill-missing
                                                     # a month that isn't available is replaced by the
                                                     # same month one year earlier (listed in filled_months)

Data: GPM_3IMERGM v07 (monthly Final Run, satellite + rain-gauge corrected), 0.1° grid (~10 km).
A window is rarely whole months, so each month counts for the share of its days that fall in
the window (e.g. 10 days of a 30-day month = 1/3 of that month's rain).
Monthly files (~30 MB) are downloaded once into gpm_cache/ (next to this script) and reused by
every later run. Uses the NASA Earthdata login (asked once, then remembered).

Output: rain_output/rain.csv  ->  site, start, end, days, rain_mm, filled_months
        rain_mm is empty if a month of the window isn't published yet (Final Run lags ~3-4 months),
        unless --fill-missing is given.

Needs: python -m pip install numpy matplotlib earthaccess h5py
"""
import argparse
import calendar
import csv
import json
import os
import shutil
import sys
from pathlib import Path

import numpy as np
from matplotlib.path import Path as PolyPath

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))   # Data/ (common.py)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import days_between, retry, site_windows  # noqa: E402

SHORT_NAME, VERSION = "GPM_3IMERGM", "07"
CACHE = Path(__file__).resolve().parent / "gpm_cache"   # monthly files are kept here and reused
RES = 0.1                                               # degrees; grid starts at -180 lon, -90 lat


def cached(month):
    """Path of the cached GPM file for 'YYYY-MM', or None."""
    hits = sorted(CACHE.glob(f"3B-MO.MS.MRG.3IMERG.{month.replace('-', '')}01-*.HDF5"))
    return hits[-1] if hits else None


def cells_for(coords):
    """(lon index, lat index) of the 0.1° cells whose centre is inside the polygon,
    or the single cell under the polygon's centre if it is smaller than one cell."""
    c = np.array(coords, dtype=float)
    i0, i1 = int((c[:, 0].min() + 180) // RES), int((c[:, 0].max() + 180) // RES)
    j0, j1 = int((c[:, 1].min() + 90) // RES), int((c[:, 1].max() + 90) // RES)
    ii, jj = np.mgrid[i0:i1 + 1, j0:j1 + 1]
    centres = np.c_[(ii.ravel() + .5) * RES - 180, (jj.ravel() + .5) * RES - 90]
    inside = PolyPath(c).contains_points(centres)
    if inside.any():
        return list(zip(ii.ravel()[inside].tolist(), jj.ravel()[inside].tolist()))
    lon, lat = c.mean(axis=0)
    return [(int((lon + 180) // RES), int((lat + 90) // RES))]


def read_rates(path, site_cells):
    """Mean rain rate (mm/hr) of every site from one GPM_3IMERGM file (file opened once)."""
    import h5py
    out = []
    with h5py.File(path, "r") as f:
        ds = f["Grid/precipitation"]                          # shape (time, lon, lat)
        for cells in site_cells:
            ii, jj = [c[0] for c in cells], [c[1] for c in cells]
            block = ds[0, min(ii):max(ii) + 1, min(jj):max(jj) + 1]
            vals = np.array([block[i - min(ii), j - min(jj)] for i, j in cells], dtype=float)
            vals[vals < 0] = np.nan                           # fill value -9999.9
            out.append(float(np.nanmean(vals)) if np.isfinite(vals).any() else np.nan)
    return out


def download_missing(missing, bbox):
    """Download the monthly files not in the cache yet."""
    import earthaccess
    retry(earthaccess.login, persist=True, what="NASA Earthdata login")
    granules = retry(earthaccess.search_data, short_name=SHORT_NAME, version=VERSION,
                     temporal=(f"{missing[0]}-01", f"{missing[-1]}-28"), bounding_box=bbox,
                     what="GPM search")
    tmp = CACHE / f"tmp_{os.getpid()}"                        # own folder per process: safe in parallel
    tmp.mkdir(parents=True, exist_ok=True)
    found = {g["umm"]["TemporalExtent"]["RangeDateTime"]["BeginningDateTime"][:7] for g in granules}
    not_found = [m for m in missing if m not in found]
    if not_found:
        print(f"  NASA search found no file for: {', '.join(not_found)} (not published yet?)", flush=True)
    try:
        for g in granules:
            month = g["umm"]["TemporalExtent"]["RangeDateTime"]["BeginningDateTime"][:7]
            if month not in missing or cached(month):
                continue
            try:
                paths = retry(earthaccess.download, [g], local_path=str(tmp), what=f"GPM {month} download")
                if not paths:                                # earthaccess returns [] instead of raising
                    print(f"  {month}: found on NASA but the download returned no file", flush=True)
            except Exception as e:
                if "Eula" in type(e).__name__ or "403" in str(e):
                    raise SystemExit("NASA refused the download. Log in at https://urs.earthdata.nasa.gov -> "
                                     "Applications -> Authorized Apps, approve 'NASA GESDISC DATA ARCHIVE' "
                                     "and accept its terms, then run again.")
                raise
            if paths:
                dest = CACHE / Path(paths[0]).name
                try:
                    os.replace(paths[0], dest)                       # finished file -> cache
                except OSError:                                      # another batch saved the same month just now
                    if not dest.exists():
                        raise
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description="GPM rainfall for the polygons in source.json.")
    ap.add_argument("--source", required=True, help="JSON saved by the map page / build_dataset.py")
    ap.add_argument("--days", type=int, help="use the N days ending on each site's 'date'")
    ap.add_argument("--out", default="rain_output", help="output folder")
    ap.add_argument("--fill-missing", action="store_true",
                    help="replace a month that isn't available by the same month one year earlier")
    args = ap.parse_args()

    req = json.loads(Path(args.source).read_text(encoding="utf-8"))
    sites = [f["coords"] for f in req["features"]]
    windows = site_windows(req, args.days)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(exist_ok=True)

    site_cells = [cells_for(c) for c in sites]
    months = sorted({d.strftime("%Y-%m") for s, e in windows for d in days_between(s, e)})
    missing = [m for m in months if cached(m) is None]
    print(f"{len(sites)} site(s), {len(months)} month(s), {len(months) - len(missing)} already downloaded")
    lons = [p[0] for c in sites for p in c]
    lats = [p[1] for c in sites for p in c]
    if missing:
        try:
            download_missing(missing, (min(lons), min(lats), max(lons), max(lats)))
        except SystemExit:
            raise
        except Exception as e:
            print(f"!! rain download: {type(e).__name__}: {str(e)[:200]}", flush=True)

    # monthly totals (mm) per site
    totals = {}

    def read_month(m):
        path = cached(m)
        if path is None:
            return False
        hours = 24 * calendar.monthrange(int(m[:4]), int(m[5:]))[1]
        try:
            for i, rate in enumerate(read_rates(path, site_cells)):
                totals[(i, m)] = rate * hours
            return True
        except Exception as e:
            print(f"!! rain {m}: cannot read {path.name}: {e}", flush=True)
            return False

    unavailable = [m for m in months if not read_month(m)]
    for m in unavailable:
        print(f"  {m}: not available (not published yet, or download failed)")

    # --fill-missing: the same month one year earlier stands in for an unavailable month
    substitute = {}
    if args.fill_missing and unavailable:
        year_before = {m: f"{int(m[:4]) - 1}{m[4:]}" for m in unavailable}
        need = [p for p in sorted(set(year_before.values())) if p not in months and cached(p) is None]
        if need:
            try:
                download_missing(need, (min(lons), min(lats), max(lons), max(lats)))
            except SystemExit:
                raise
            except Exception as e:
                print(f"!! rain download (fill): {type(e).__name__}: {str(e)[:200]}", flush=True)
        for m, p in year_before.items():
            if (p in months and p not in unavailable) or read_month(p):
                substitute[m] = p
                print(f"  {m}: filled with {p}")

    rows = []
    for i, (start, end) in enumerate(windows):
        share = {}
        for d in days_between(start, end):                   # days of each month inside the window
            share[d.strftime("%Y-%m")] = share.get(d.strftime("%Y-%m"), 0) + 1
        used = {m: substitute.get(m, m) if totals.get((i, m)) is None else m for m in share}
        parts = [totals.get((i, used[m])) for m in share]
        ok = all(v is not None and np.isfinite(v) for v in parts)
        rain = sum(totals[(i, used[m])] * n / calendar.monthrange(int(m[:4]), int(m[5:]))[1]
                   for m, n in share.items()) if ok else None
        filled = [f"{m}<-{p}" for m, p in used.items() if p != m]
        rows.append({"site": f"site{i + 1}", "start": start, "end": end, "days": (end - start).days + 1,
                     "rain_mm": "" if rain is None else round(rain, 1), "filled_months": " ".join(filled)})
        print(f"  site{i + 1} {start}..{end}: " + (f"{rain:.1f} mm" if rain is not None else "no data")
              + (f" (filled: {', '.join(filled)})" if filled and rain is not None else ""))

    with open(out / "rain.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["site", "start", "end", "days", "rain_mm", "filled_months"])
        w.writeheader()
        w.writerows(rows)
    print(f"\nDone: {out / 'rain.csv'}")


if __name__ == "__main__":
    main()