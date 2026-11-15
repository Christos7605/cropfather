#!/usr/bin/env python3
"""
Temperature (min / mean / max) for the polygons in source.json.

    python temperature.py --source source.json                              # request's start..end
    python temperature.py --source source.json --days 90 --lst-days 60      # windows ending on each site's "date"
    python temperature.py --source source.json --onlydata                   # CSVs only, no images

Two sources:
  * Air temperature (2 m) per day - NASA POWER (MERRA-2, ~50 km), free, no account, cached on disk.
    Window: --days N (the N days ending on the site's "date"), else start..end.
  * Land surface temperature (LST) per pixel - Landsat 8 + 9 thermal band (Collection 2 Level-2,
    30 m grid, a clear pass every ~8 days). From Microsoft Planetary Computer, no account.
    Window: --lst-days N, else start..end.  Uses max_cloud (% of the polygon) from the JSON.

Output (in --out, default temperature_output/)
  temperature.csv           one row per site:
                            site, air_days, air_min_c, air_mean_c, air_max_c, hot_days_over_30c,
                            lst_passes, lst_min_c, lst_mean_c, lst_max_c, lst_minus_air_c
  temperature_passes.csv    one row per site and clear Landsat pass (details)
  <site>/<date>_LST.png     surface temperature of each clear pass   (not with --onlydata)

air_min = coldest daily minimum, air_mean = average of daily means, air_max = hottest daily maximum;
LST min / max = coldest / hottest pixel of all passes, LST mean = average of the passes' means;
lst_minus_air = mean over passes of (pass LST mean - that day's air max): crops that transpire
stay cool, stressed crops and bare soil run hot.

Needs: python -m pip install numpy matplotlib pystac-client planetary-computer stackstac rasterio shapely pyproj requests
"""
import argparse
import csv
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import dask
import numpy as np
import planetary_computer as pc
import pystac_client
import shapely
import stackstac
from affine import Affine
from pyproj import Transformer
from rasterio.enums import Resampling
from rasterio.features import geometry_mask
from shapely.geometry import Polygon, shape
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))   # Data/ (common.py)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import in_order, retry, site_windows, weather_daily  # noqa: E402

STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"
COLLECTION = "landsat-c2-l2"
ST_SCALE, ST_OFFSET = 0.00341802, 149.0          # Landsat C2 L2 surface temperature -> Kelvin
QA_BAD_BITS = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5)   # fill, clouds, cirrus, shadow, snow
QA_WATER_BIT = 1 << 7
SCENE_CLOUD_PREFILTER = 90                        # skip scenes >90% cloudy before downloading
MAX_NODATA_FRACTION = 0.001                       # a pass must cover the whole polygon
SITE_THREADS = 4                                  # sites processed at the same time with --onlydata (1 = one by one)
PASS_DOWNLOADS = 3                                # Landsat passes of one site downloading at the same time (1 = one by one)


# ----------------------------------------------------------------- helpers --
def find_passes(catalog, geom, start, end):
    """{date: [items]} for Landsat 8/9 dates whose footprints cover the whole polygon."""
    items = catalog.search(
        collections=[COLLECTION], bbox=list(geom.bounds), datetime=f"{start}/{end}",
        query={"platform": {"in": ["landsat-8", "landsat-9"]},
               "eo:cloud_cover": {"lt": SCENE_CLOUD_PREFILTER}},
    ).item_collection()
    by_date = {}
    for it in sorted(items, key=lambda i: i.datetime):
        by_date.setdefault(it.datetime.date(), []).append(it)
    return {d: g for d, g in by_date.items()
            if unary_union([shape(i.geometry) for i in g]).buffer(1e-4).contains(geom)}


def load_pass(items, bbox, epsg):
    """LST (°C), QA and pixel-centre coordinates for one date (same-day scenes mosaicked)."""
    common = dict(bounds_latlon=bbox, epsg=epsg, resolution=30, dtype="float64", fill_value=np.nan,
                  rescale=False, xy_coords="center")
    st = stackstac.stack(items, assets=["lwir11"], resampling=Resampling.bilinear, **common)
    qa = stackstac.stack(items, assets=["qa_pixel"], resampling=Resampling.nearest, **common)
    # both computed in one go, so the two downloads run at the same time (same values)
    st, qa = dask.compute(stackstac.mosaic(st.where(st != 0), dim="time").sel(band="lwir11"),    # 0 = no data
                          stackstac.mosaic(qa.where(qa != 1), dim="time").sel(band="qa_pixel"))  # 1 = fill
    return st.values * ST_SCALE + ST_OFFSET - 273.15, qa.values, st.x.values, st.y.values


def save_image(lst, draw, x, y, poly_xy, title, row, path):
    """Pixel map (no smoothing) clipped to the polygon; colours span this pass's min-max."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Polygon as Outline

    px = abs(float(x[1] - x[0]))
    extent = [x[0] - px / 2, x[-1] + px / 2, y[-1] - px / 2, y[0] + px / 2]
    vmin, vmax = row["lst_min_c"], row["lst_max_c"]
    if vmax - vmin < 0.1:
        vmin, vmax = vmin - 0.5, vmax + 0.5
    cmap = plt.get_cmap("inferno").copy()
    cmap.set_bad("lightgrey")                          # clouds / water inside the polygon

    h, w = lst.shape
    fig, ax = plt.subplots(figsize=(8, max(2.5, 7 * h / w) + 1.2))
    im = ax.imshow(np.ma.masked_invalid(np.where(draw, lst, np.nan)), cmap=cmap, vmin=vmin, vmax=vmax,
                   extent=extent, origin="upper", interpolation="nearest")    # every 30 m pixel visible
    outline = np.c_[poly_xy]
    im.set_clip_path(Outline(outline, closed=True, transform=ax.transData))
    ax.plot(*outline.T, color="black", lw=1)
    fig.colorbar(im, ax=ax, shrink=0.7, label="Land surface temperature (°C)")
    ax.set_title(f"{title}\nmin {row['lst_min_c']} | mean {row['lst_mean_c']} | max {row['lst_max_c']} °C"
                 f"   (air: {row['air_min_c']} / {row['air_mean_c']} / {row['air_max_c']} °C)", fontsize=10)
    ax.axis("off")
    fig.savefig(path, dpi=120, bbox_inches="tight")
    plt.close(fig)


# -------------------------------------------------------------------- site --
def process_site(name, coords, catalog, air_win, lst_win, max_cloud, out, make_images):
    geom = Polygon(coords).buffer(0)
    cx, cy = geom.centroid.x, geom.centroid.y
    epsg = (32600 if cy >= 0 else 32700) + int((cx + 180) // 6) + 1     # UTM zone
    print(f"\n=== {name} === air {air_win[0]}..{air_win[1]}, LST {lst_win[0]}..{lst_win[1]}")

    row = {"site": name}
    air = {}
    try:
        air = weather_daily(cy, cx, *air_win)
        if air:
            row.update(air_days=len(air),
                       air_min_c=round(min(w["tmin"] for w in air.values()), 1),
                       air_mean_c=round(float(np.mean([w["tmean"] for w in air.values()])), 1),
                       air_max_c=round(max(w["tmax"] for w in air.values()), 1),
                       hot_days_over_30c=sum(w["tmax"] > 30 for w in air.values()))
        print(f"  Air temperature: {len(air)} days")
    except Exception as e:
        print(f"!! {name} temperature (air): {type(e).__name__}: {str(e)[:200]}", flush=True)
    # air max of the LST pass days (may lie outside the air window)
    try:
        lst_air = weather_daily(cy, cx, *lst_win)
    except Exception:
        lst_air = air

    try:
        passes = retry(find_passes, catalog, geom, lst_win[0].isoformat(), lst_win[1].isoformat(),
                       what=f"{name} Landsat search")
    except Exception as e:                           # keep the air temperature even if Landsat fails
        print(f"!! {name} temperature (Landsat search): {type(e).__name__}: {str(e)[:200]}", flush=True)
        passes = {}
    print(f"  Landsat 8/9 dates covering the whole polygon: {len(passes)}")
    g = shapely.transform(geom, Transformer.from_crs(4326, epsg, always_xy=True).transform, interleaved=False)

    pass_rows = []
    # The next passes download while the current one is handled; passes are still handled one by
    # one in date order, so everything below sees exactly what it saw before.
    load = lambda day, items: retry(load_pass, items, list(geom.bounds), epsg, what=f"{name} Landsat {day}")
    for (day, items), loaded, error in in_order(load, passes.items(), PASS_DOWNLOADS):
        if error is not None:
            e = error
            print(f"!! {name} temperature Landsat {day}: {type(e).__name__}: {str(e)[:160]}", flush=True)
            continue
        lst, qa, x, y = loaded
        tr = Affine(30, 0, x[0] - 15, 0, -30, y[0] + 15)
        draw = geometry_mask([g], lst.shape, tr, invert=True, all_touched=True)
        inside = geometry_mask([g], lst.shape, tr, invert=True, all_touched=False)
        if not inside.any():
            inside = draw
        nodata = np.isnan(lst) | np.isnan(qa)
        if nodata[draw].mean() > MAX_NODATA_FRACTION:
            print(f"  {day}: skipped (does not cover the whole polygon)")
            continue
        qai = np.nan_to_num(qa).astype(np.uint16)
        cloudy = (qai & QA_BAD_BITS) > 0
        cloud_pct = 100 * cloudy[inside].mean()
        if cloud_pct > max_cloud:
            print(f"  {day}: skipped ({cloud_pct:.0f}% cloud > {max_cloud:g}%)")
            continue
        lst = np.where(~nodata & ~cloudy & ((qai & QA_WATER_BIT) == 0), lst, np.nan)   # clouds + water masked
        v = lst[inside & np.isfinite(lst)]
        if v.size == 0:
            print(f"  {day}: skipped (no clear land pixels)")
            continue

        a = lst_air.get(day) or {}
        p = {"site": name, "date": day, "time_utc": items[0].datetime.strftime("%H:%M"),
             "satellite": items[0].properties.get("platform", ""), "cloud_pct": round(cloud_pct, 1),
             "lst_min_c": round(float(v.min()), 1), "lst_mean_c": round(float(v.mean()), 1),
             "lst_max_c": round(float(v.max()), 1), "air_min_c": a.get("tmin"),
             "air_mean_c": a.get("tmean"), "air_max_c": a.get("tmax")}
        pass_rows.append(p)
        print(f"  {day}: LST min {p['lst_min_c']} | mean {p['lst_mean_c']} | max {p['lst_max_c']} °C, "
              f"cloud {cloud_pct:.0f}%")
        if make_images:
            (out / name).mkdir(parents=True, exist_ok=True)
            save_image(lst, draw, x, y, g.exterior.xy,
                       f"{name} – {day} {p['time_utc']} UTC – {p['satellite']}", p,
                       out / name / f"{day}_LST.png")

    row["lst_passes"] = len(pass_rows)
    if pass_rows:
        diffs = [p["lst_mean_c"] - p["air_max_c"] for p in pass_rows if p["air_max_c"] is not None]
        row.update(lst_min_c=min(p["lst_min_c"] for p in pass_rows),
                   lst_mean_c=round(float(np.mean([p["lst_mean_c"] for p in pass_rows])), 1),
                   lst_max_c=max(p["lst_max_c"] for p in pass_rows),
                   lst_minus_air_c=round(float(np.mean(diffs)), 1) if diffs else "")
    return row, pass_rows


def write_csv(path, rows):
    if rows:
        with open(path, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)


# -------------------------------------------------------------------- main --
def main():
    ap = argparse.ArgumentParser(description="Air + land surface temperature for the polygons in source.json.")
    ap.add_argument("--source", required=True, help="JSON saved by the map page / build_dataset.py")
    ap.add_argument("--days", type=int, help="air temperature: the N days ending on each site's 'date'")
    ap.add_argument("--lst-days", type=int, help="Landsat: the N days ending on each site's 'date'")
    ap.add_argument("--onlydata", action="store_true", help="only write the CSVs (no images)")
    ap.add_argument("--out", default="temperature_output", help="output folder")
    args = ap.parse_args()

    req = json.loads(Path(args.source).read_text(encoding="utf-8"))
    sites = [f["coords"] for f in req["features"]]
    air_wins, lst_wins = site_windows(req, args.days), site_windows(req, args.lst_days)
    max_cloud = float(req.get("max_cloud", 20))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    print(f"{len(sites)} site(s), max cloud {max_cloud:g}%")

    catalog = retry(pystac_client.Client.open, STAC_URL, modifier=pc.sign_inplace, what="Planetary Computer")
    def one(i, coords):
        try:
            return process_site(f"site{i}", coords, catalog, air_wins[i - 1], lst_wins[i - 1],
                                max_cloud, out, not args.onlydata)
        except Exception as e:                       # one bad site never stops the others
            print(f"!! site{i} temperature: {type(e).__name__}: {str(e)[:200]}", flush=True)
            return {"site": f"site{i}"}, []

    # Sites mostly wait on the network, so several run at the same time. Images (matplotlib)
    # can't be drawn from several threads, so with images it stays one site at a time.
    threads = SITE_THREADS if args.onlydata else 1
    rows, passes = [], []
    with ThreadPoolExecutor(threads) as ex:
        for r, p in ex.map(one, range(1, len(sites) + 1), sites):     # results stay in site order
            rows.append(r)
            passes += p

    cols = ["site", "air_days", "air_min_c", "air_mean_c", "air_max_c", "hot_days_over_30c",
            "lst_passes", "lst_min_c", "lst_mean_c", "lst_max_c", "lst_minus_air_c"]
    with open(out / "temperature.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, restval="")
        w.writeheader()
        w.writerows(rows)
    write_csv(out / "temperature_passes.csv", passes)
    print(f"\nDone: {len(rows)} site(s), {len(passes)} clear Landsat passes in {out}/"
          + ("" if args.onlydata else " (+ images)"))


if __name__ == "__main__":
    main()