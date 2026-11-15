#!/usr/bin/env python3
"""
Was the NDVI of each drawn shape above a threshold on a given Sentinel-2 date?
Writes {"vegetated": true/false, "date": ...} for every site to a JSON file.

    python ndvi_checker.py --source source.json                   # last usable date, threshold 0.3
    python ndvi_checker.py --source source.json --date 2          # second-to-last usable date
    python ndvi_checker.py --source source.json --max 0.25        # other threshold
    python ndvi_checker.py --source source.json --stat max_typical

--date N counts usable dates backwards from the JSON's "end" (per site's window):
    1 = the last usable date, 2 = the one before it, and so on.
A date is "usable" with the same rules as salt_indexes.py: footprint covers the whole
shape, at most 0.1% no data, and cloud/shadow in the shape at most "max_cloud" (JSON, default 20%).

Output: a JSON file (--out, default ndvi_check.json), one entry per site in JSON order:
    [{"site": "site1_polygon", "vegetated": true, "date": "2026-03-28"}, ...]
"vegetated" is true if NDVI > --max. If there aren't N usable dates, vegetated and date are null.
Exit code: 0 if every site got an answer, 2 if any site is null.

Needs salt_indexes.py next to this file (and common.py in the parent folder, as before).
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import planetary_computer as pc
import pystac_client

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))   # Data/ (common.py)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import retry, site_windows  # noqa: E402
from salt_indexes import (  # noqa: E402
    BAD_SCL,
    DEFAULT_MAX_CLOUD_IN_AREA,
    MAX_NODATA_FRACTION,
    MAX_PIXELS,
    build_sites,
    choose_resolution,
    find_full_coverage_dates,
    inside_mask,
    load_date,
    norm_diff,
    typical_max,
    utm_epsg,
)

DEFAULT_MAX = 0.3
BANDS = ["B04", "B08"]          # Red, NIR
STATS = {
    "mean": lambda v: float(v.mean()),
    "median": lambda v: float(np.median(v)),
    "max_typical": typical_max,
    "max": lambda v: float(v.max()),
    "min": lambda v: float(v.min()),
}


def nth_usable_ndvi(site, catalog, n, max_cloud):
    """Go back from the end of the site's window and return (date, ndvi_values, cloud_pct)
    for the n-th usable date, or None if there are fewer than n."""
    geom = site["geom"]
    bbox = list(geom.bounds)
    epsg = utm_epsg(geom.centroid.x, geom.centroid.y)
    resolution = choose_resolution(bbox, MAX_PIXELS)

    print(f"\n=== {site['name']} ({site['start']} to {site['end']}; {resolution} m pixels) ===")
    dates = retry(find_full_coverage_dates, catalog, geom, site["start"], site["end"],
                  what=f"{site['name']} Sentinel-2 search")

    found = 0
    for date in sorted(dates, reverse=True):            # newest first
        try:
            refl, scl, x, y = retry(load_date, dates[date], bbox, epsg, resolution, BANDS,
                                    what=f"{site['name']} Sentinel-2 {date}")
        except Exception as e:                           # one bad date never stops the site
            print(f"  {date}: download failed ({type(e).__name__}: {str(e)[:160]})")
            continue

        inside_draw = inside_mask(geom, x, y, epsg, all_touched=True)    # coverage
        inside = inside_mask(geom, x, y, epsg, all_touched=False)        # statistics
        if not inside_draw.any():
            print(f"  {date}: skipped, shape is smaller than one pixel")
            continue
        if not inside.any():
            inside = inside_draw                                         # very thin shapes

        nodata = np.isnan(scl) | np.isnan(refl["B04"]) | np.isnan(refl["B08"])
        nodata_frac = nodata[inside_draw].mean()
        if nodata_frac > MAX_NODATA_FRACTION:
            print(f"  {date}: skipped, {nodata_frac:.1%} of the shape has no data")
            continue

        bad = np.isin(scl, BAD_SCL) & ~nodata
        cloud_pct = 100 * bad[inside].mean()
        if cloud_pct > max_cloud:
            print(f"  {date}: skipped, {cloud_pct:.1f}% cloud/shadow (limit {max_cloud}%)")
            continue

        ndvi = norm_diff(refl["B08"], refl["B04"])
        valid = inside & ~nodata & ~bad & np.isfinite(ndvi)
        if not valid.any():
            print(f"  {date}: skipped, no valid pixels left")
            continue

        found += 1
        print(f"  {date}: usable date #{found} ({cloud_pct:.1f}% cloud/shadow)")
        if found == n:
            return date, ndvi[valid], cloud_pct

    print(f"  Only {found} usable date(s) in the window; --date {n} not available.")
    return None


def main():
    parser = argparse.ArgumentParser(description="1 if the NDVI was above --max on the chosen date, else 0.")
    parser.add_argument("--source", required=True, help="path to the JSON file with the sites")
    parser.add_argument("--max", type=float, default=DEFAULT_MAX,
                        help=f"NDVI threshold; 1 if NDVI > max (default {DEFAULT_MAX})")
    parser.add_argument("--date", type=int, default=1,
                        help="which usable date, counted back from the end: 1 = last, 2 = second to last ... (default 1)")
    parser.add_argument("--stat", choices=list(STATS), default="mean",
                        help="NDVI value of the shape compared with --max (default mean)")
    parser.add_argument("--days", type=int, help="use the N days ending on each site's 'date' (else start..end)")
    parser.add_argument("--out", default="ndvi_check.json", help="JSON file for the answer (default ndvi_check.json)")
    args = parser.parse_args()
    if args.date < 1:
        parser.error("--date must be 1 or more (1 = last usable date)")

    sel = json.loads(Path(args.source).read_text(encoding="utf-8"))
    max_cloud = float(sel.get("max_cloud", DEFAULT_MAX_CLOUD_IN_AREA))

    windows = site_windows(sel, args.days)
    sites = build_sites(sel["features"])
    if not sites:
        raise SystemExit("No valid sites to process.")
    for site in sites:
        w_start, w_end = windows[site["index"]]
        site["start"], site["end"] = w_start.isoformat(), w_end.isoformat()

    catalog = retry(pystac_client.Client.open, "https://planetarycomputer.microsoft.com/api/stac/v1",
                    modifier=pc.sign_inplace, what="Planetary Computer")

    results = []
    for site in sites:
        try:
            hit = nth_usable_ndvi(site, catalog, args.date, max_cloud)
        except Exception as e:                           # one bad site never stops the others
            print(f"!! {site['name']} ndvi_checker: {type(e).__name__}: {str(e)[:200]}", flush=True)
            hit = None
        if hit is None:
            results.append({"site": site["name"], "vegetated": None, "date": None})
            continue
        date, values, cloud_pct = hit
        value = STATS[args.stat](values)
        vegetated = bool(value > args.max)
        print(f"  -> {site['name']} {date}: NDVI {args.stat} {value:.4f} "
              f"{'>' if vegetated else '<='} {args.max}  =>  {'vegetated' if vegetated else 'barren'}")
        results.append({"site": site["name"], "vegetated": vegetated, "date": date.isoformat()})

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"\nAnswer written to {out}")
    sys.exit(2 if any(r["vegetated"] is None for r in results) else 0)


if __name__ == "__main__":
    main()