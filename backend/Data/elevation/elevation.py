#!/usr/bin/env python3
"""
Elevation (min / mean / max) for the polygons in source.json.

Data: Copernicus DEM GLO-30 (30 m), the most accurate free global elevation model,
from Microsoft Planetary Computer (no account needed). Heights in metres above sea level.

    python elevation.py --source source.json              # CSV + one image per site
    python elevation.py --source source.json --onlydata   # CSV only

Output (in --out, default elevation_output/)
    elevation.csv            site, centre_lon, centre_lat, elevation_min_m, elevation_mean_m, elevation_max_m
    <site>_elevation.png     map (elevation + hillshade) with the polygon outline

Needs: python -m pip install numpy matplotlib pystac-client planetary-computer stackstac rasterio shapely pyproj
"""
import argparse
import csv
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import planetary_computer as pc
import pystac_client
import shapely
import stackstac
from affine import Affine
from pyproj import Transformer
from rasterio.enums import Resampling
from rasterio.features import geometry_mask
from shapely.geometry import Polygon

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))   # Data/ (common.py)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import retry  # noqa: E402

COLLECTION = "cop-dem-glo-30"
STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"
RESOLUTION = 30                       # metres (native DEM resolution)
OUTLIER_SHARE = 0.05                  # at most 5% of pixels may be treated as outliers on each side
MIN_IQR = 1.0                         # m; stops flat fields from flagging normal 1-2 m bumps
SITE_THREADS = 4                      # sites processed at the same time with --onlydata (1 = one by one)


def typical_range(v):
    """Lowest / highest elevation of the main body of pixels, ignoring a few outliers.

    A pixel is an outlier if it lies beyond the Tukey fence (quartile +/- 1.5 x spread),
    but only when such pixels are rare (<= 5%). If more pixels are out there, they are
    real terrain (e.g. a hill in one corner) and the actual min / max are kept.
    Example: most pixels 0-2 m, 5 pixels at 15 m -> typical max = 2 m.
    """
    q1, q3 = np.percentile(v, [25, 75])
    spread = 1.5 * max(q3 - q1, MIN_IQR)
    lo, hi = q1 - spread, q3 + spread
    low_out, high_out = v < lo, v > hi
    tmin = v[~low_out].min() if low_out.mean() <= OUTLIER_SHARE else v.min()
    tmax = v[~high_out].max() if high_out.mean() <= OUTLIER_SHARE else v.max()
    return float(tmin), float(tmax)


def load_dem(catalog, geom, epsg):
    """DEM on a UTM grid covering the polygon (+ one pixel margin)."""
    w, s, e, n = geom.bounds
    pad = RESOLUTION / 111_000
    bbox = [w - pad, s - pad, e + pad, n + pad]
    items = catalog.search(collections=[COLLECTION], bbox=bbox).item_collection()
    if not items:
        raise SystemExit("No Copernicus DEM tiles found for this area.")
    dem = stackstac.stack(items, assets=["data"], epsg=epsg, resolution=RESOLUTION,
                          bounds_latlon=bbox, dtype="float64", fill_value=np.nan,
                          rescale=False, resampling=Resampling.bilinear, xy_coords="center")
    dem = stackstac.mosaic(dem, dim="time").sel(band="data").compute()   # joins 1°x1° tiles
    return dem.values, dem.x.values, dem.y.values


def save_image(dem, draw, x, y, poly_xy, row, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    px = abs(float(x[1] - x[0]))
    extent = [x[0] - px / 2, x[-1] + px / 2, y[-1] - px / 2, y[0] + px / 2]
    vmin, vmax = row["typical_min"], row["elevation_max_typical_m"]   # colours span the common range
    if vmax - vmin < 1:
        vmin, vmax = vmin - 0.5, vmax + 0.5
    shown = np.where(draw, dem, np.nan)                 # every pixel's elevation, blank outside the polygon

    cmap = plt.get_cmap("terrain").copy()
    cmap.set_over("magenta")                            # outliers above the typical max
    cmap.set_under("black")                             # outliers below the typical min
    fig, ax = plt.subplots(figsize=(10, 8))
    im = ax.imshow(shown, cmap=cmap, vmin=vmin, vmax=vmax, extent=extent, origin="upper")  
    from matplotlib.patches import Polygon as Outline
    im.set_clip_path(Outline(np.c_[poly_xy], closed=True, transform=ax.transData))   # crisp polygon edge
    ax.plot(*poly_xy, color="black", lw=1)
    n_over = int((shown > vmax).sum())
    n_under = int((shown < vmin).sum())
    extend = {(0, 0): "neither", (0, 1): "max", (1, 0): "min", (1, 1): "both"}[(n_under > 0, n_over > 0)]
    fig.colorbar(im, ax=ax, shrink=0.7, extend=extend, label="Elevation (m above sea level)")
    note = []
    if n_over:
        note.append(f"magenta = {n_over} px above {vmax:.1f} m")
    if n_under:
        note.append(f"black = {n_under} px below {vmin:.1f} m")
    ax.set_title(f"{row['site']} – elevation ({px:g} m pixels)\n"
                 f"min {row['elevation_min_m']:.1f} m | mean {row['elevation_mean_m']:.1f} m | "
                 f"typical max {row['elevation_max_typical_m']:.1f} m | actual max {row['elevation_max_m']:.1f} m"
                 + (f"\n{', '.join(note)}" if note else ""))
    ax.set_xlabel("Easting (m)"); ax.set_ylabel("Northing (m)")
    fig.savefig(path, dpi=150, bbox_inches="tight")
    plt.close(fig)


def process_site(name, coords, catalog, out, make_image):
    geom = Polygon(coords).buffer(0)
    cx, cy = geom.centroid.x, geom.centroid.y
    epsg = (32600 if cy >= 0 else 32700) + int((cx + 180) // 6) + 1     # UTM zone

    dem, x, y = retry(load_dem, catalog, geom, epsg, what=f"{name} elevation download")
    g = shapely.transform(geom, Transformer.from_crs(4326, epsg, always_xy=True).transform, interleaved=False)
    tr = Affine(RESOLUTION, 0, x[0] - RESOLUTION / 2, 0, -RESOLUTION, y[0] + RESOLUTION / 2)
    draw = geometry_mask([g], dem.shape, tr, invert=True, all_touched=True) & np.isfinite(dem)
    inside = geometry_mask([g], dem.shape, tr, invert=True, all_touched=False) & np.isfinite(dem)
    if not inside.any():
        inside = draw                                   # polygon smaller than a pixel
    if not inside.any():
        print(f"{name}: no elevation data inside the polygon.")
        return None

    e = dem[inside]
    tmin, tmax = typical_range(e)
    row = {"site": name, "centre_lon": round(cx, 6), "centre_lat": round(cy, 6),
           "elevation_min_m": round(float(e.min()), 1), "elevation_mean_m": round(float(e.mean()), 1),
           "elevation_max_typical_m": round(tmax, 1), "elevation_max_m": round(float(e.max()), 1)}
    print(f"{name}: min {row['elevation_min_m']} m | mean {row['elevation_mean_m']} m | "
          f"typical max {row['elevation_max_typical_m']} m | actual max {row['elevation_max_m']} m")
    if make_image:
        save_image(dem, draw, x, y, g.exterior.xy, {**row, "typical_min": tmin},
                   out / f"{name}_elevation.png")
    return row


def main():
    ap = argparse.ArgumentParser(description="Elevation min / mean / max for the polygons in source.json.")
    ap.add_argument("--source", required=True, help="JSON saved by the map page")
    ap.add_argument("--out", default="elevation_output", help="output folder")
    ap.add_argument("--onlydata", action="store_true", help="only write the CSV (no images)")
    args = ap.parse_args()

    sites = [f["coords"] for f in json.loads(Path(args.source).read_text(encoding="utf-8"))["features"]]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    catalog = retry(pystac_client.Client.open, STAC_URL, modifier=pc.sign_inplace, what="Planetary Computer")

    def one(i, c):
        try:
            r = process_site(f"site{i}", c, catalog, out, not args.onlydata)
        except Exception as e:                       # one bad site never stops the others
            print(f"!! site{i} elevation: {type(e).__name__}: {str(e)[:200]}", flush=True)
            r = None
        return r or {"site": f"site{i}"}

    # Sites mostly wait on the network, so several run at the same time. Images (matplotlib)
    # can't be drawn from several threads, so with images it stays one site at a time.
    threads = SITE_THREADS if args.onlydata else 1
    with ThreadPoolExecutor(threads) as ex:
        rows = list(ex.map(one, range(1, len(sites) + 1), sites))     # results stay in site order

    if rows:
        with open(out / "elevation.csv", "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=max((list(r) for r in rows), key=len), restval="")
            w.writeheader()
            w.writerows(rows)
    print(f"\nDone: {out / 'elevation.csv'}" + ("" if args.onlydata else " + one image per site"))


if __name__ == "__main__":
    main()