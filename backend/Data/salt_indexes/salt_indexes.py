#!/usr/bin/env python3
"""
Sentinel-2 index values (min / mean / typical max / max) and images for shapes drawn on a map.

    python salt_indexes.py --source source.json                        # SI2 (default): CSV + images
    python salt_indexes.py --source source.json --mode SI2 NDVI        # several indices, one download
    python salt_indexes.py --source source.json --mode SI2 --onlydata  # CSV only, no images
    python salt_indexes.py --source source.json --days 60              # the 60 days ending on each site's "date"
    python salt_indexes.py --list-indices

Output (in --out, default index_images/)
    index_values.csv              one row per site, index and date:
                                  site, index, centre_lon, centre_lat, date, cloud_pct, usable_pct,
                                  min, mean, max_typical, max
    <site>/<index>_<date>.png     one image per index and date (not with --onlydata)

"max_typical" ignores a few outlier pixels (at most 5% of the shape, beyond
quartile + 1.5 x spread); if more pixels are that high they are real and typical = actual max.
TRUECOLOR is a picture, not a value, so it gets an image but no CSV row.
"""

# --------------------------------------------------#
#                   Imports                         #
# --------------------------------------------------#

import argparse
import csv
import json
import math
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import dask
import numpy as np
import planetary_computer as pc
import pystac_client
import shapely
import stackstac
import xarray as xr
from affine import Affine
from pyproj import Transformer
from rasterio.enums import Resampling
from rasterio.features import geometry_mask
from shapely.geometry import Polygon, shape
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))   # Data/ (common.py)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import in_order, retry, site_windows  # noqa: E402

# --------------------------------------------------#
#                   Defaults                        #
# --------------------------------------------------#

DEFAULT_START = "2026-01-01"
DEFAULT_END = "2026-03-31"
DEFAULT_MAX_CLOUD_IN_AREA = 20
DEFAULT_MODE = "SI2"
OUTPUT_DIR = "index_images"

MAX_NODATA_FRACTION = 0.001         # a date is skipped if more than 0.1% of the shape has no data
MAX_PIXELS = 2500                   # longest side of an image in pixels; coarsened automatically for big shapes (minimum 10 m)
SCENE_CLOUD_PREFILTER = 90          # skip scenes that are >90% cloudy overall before downloading anything
VEG_NDVI = 0.33                      # NDVI above this = vegetation (masked for soil indices)

# Sentinel-2 Scene Classification Layer (SCL) values:
# 1 saturated/defective, 3 cloud shadow, 8 medium cloud, 9 high cloud,
# 10 thin cirrus, 11 snow/ice.  (0 = no data is handled separately.)
BAD_SCL = [1, 3, 8, 9, 10, 11]
# Extra classes masked for bare-soil indices: 6 = water.
# (Class 2 "dark area / topographic shadow" is NOT masked: wet saline soils can be dark.)
SOIL_EXTRA_SCL = [6]

OUTLIER_SHARE = 0.05                # typical max: at most 5% of pixels may be outliers
MIN_SPREAD = 0.01                   # index units; stops very uniform fields from flagging normal variation
SITE_THREADS = 4                    # sites processed at the same time with --onlydata (1 = one by one)
DATE_DOWNLOADS = 3                  # Sentinel-2 dates of one site downloading at the same time (1 = one by one)


# --------------------------------------------------
# Index registry
#
# To add a new index, write one function and decorate it. The name you
# register here is what you pass to --mode. Nothing else needs to change.
# --------------------------------------------------

@dataclass(frozen=True)
class IndexSpec:
    bands: tuple
    func: Callable
    label: str
    cmap: str = "RdYlBu_r"
    soil_only: bool = True
    rgb: bool = False        # True = func returns an (H, W, 3) colour image, not a single index


INDICES = {}


def register(name, bands, label, cmap="RdYlBu_r", soil_only=True, rgb=False):
    def decorator(func):
        INDICES[name] = IndexSpec(tuple(bands), func, label, cmap, soil_only, rgb)
        return func
    return decorator


def norm_diff(a, b):
    """(a - b) / (a + b), with 0/0 giving NaN instead of a warning."""
    with np.errstate(divide="ignore", invalid="ignore"):
        return (a - b) / (a + b)


def typical_max(v):
    """Highest value of the main body of pixels, ignoring a few outliers."""
    q1, q3 = np.percentile(v, [25, 75])
    high = v > q3 + 1.5 * max(q3 - q1, MIN_SPREAD)
    return float(v[~high].max()) if high.mean() <= OUTLIER_SHARE else float(v.max())


# ---- natural colour (what the fields look like) ----
@register("TRUECOLOR", ["B04", "B03", "B02"], "True colour (Red, Green, Blue)", soil_only=False, rgb=True)
def truecolor(b):
    # Raise the 0.3 for a darker image, lower it for a brighter one.
    rgb = np.dstack([b["B04"], b["B03"], b["B02"]]) / 0.3
    return np.clip(rgb, 0, 1)


# ---- soil salinity / brightness indices (bare soil) ----
@register("SI1", ["B03", "B04"], "SI1 = sqrt(Green x Red)")
def si1(b):
    return np.sqrt(b["B03"] * b["B04"])


@register("SI2", ["B03", "B04", "B08"], "SI2 = sqrt(Green² + Red² + NIR²)")
def si2(b):
    return np.sqrt(b["B03"] ** 2 + b["B04"] ** 2 + b["B08"] ** 2)


@register("SI3", ["B03", "B04"], "SI3 = sqrt(Green² + Red²)")
def si3(b):
    return np.sqrt(b["B03"] ** 2 + b["B04"] ** 2)


@register("BI", ["B04", "B08"], "Brightness index = sqrt(Red² + NIR²)")
def bi(b):
    return np.sqrt(b["B04"] ** 2 + b["B08"] ** 2)


@register("NDSI", ["B04", "B08"], "Normalized Difference Salinity Index = (Red - NIR) / (Red + NIR)")
def ndsi(b):
    return norm_diff(b["B04"], b["B08"])


@register("NDTI", ["B11", "B12"], "SWIR ratio = (SWIR1 - SWIR2) / (SWIR1 + SWIR2)", cmap="viridis")
def ndti(b):
    return norm_diff(b["B11"], b["B12"])


# ---- vegetation / crop / water indices (any surface) ----
@register("NDVI", ["B04", "B08"], "NDVI = (NIR - Red) / (NIR + Red)", cmap="RdYlGn", soil_only=False)
def ndvi(b):
    return norm_diff(b["B08"], b["B04"])


@register("NDWI", ["B03", "B08"], "NDWI (open water) = (Green - NIR) / (Green + NIR)", cmap="BrBG", soil_only=False)
def ndwi(b):
    return norm_diff(b["B03"], b["B08"])


@register("NDMI", ["B8A", "B11"], "NDMI (moisture) = (NIR - SWIR1) / (NIR + SWIR1)", cmap="BrBG", soil_only=False)
def ndmi(b):
    return norm_diff(b["B8A"], b["B11"])


@register("CRSI", ["B02", "B03", "B04", "B08"], "CRSI (canopy response salinity index)", cmap="RdYlGn", soil_only=False)
def crsi(b):
    nr = b["B08"] * b["B04"]
    gb = b["B03"] * b["B02"]
    ratio = norm_diff(nr, gb)
    with np.errstate(invalid="ignore"):
        return np.sqrt(np.where(ratio >= 0, ratio, np.nan))


# --------------------------------------------------#
#                  Geometry helpers                 #
# --------------------------------------------------#

def wrap_lon(lon):
    """Leaflet can return longitudes outside -180..180 if the map was panned around the globe."""
    return ((lon + 180) % 360) - 180


def build_sites(features):
    """Turn the drawn features into a list of {'name', 'kind', 'geom'} (geom in lon/lat).
    The index (mode) is chosen on the command line, not in the JSON."""
    sites = []
    for n, f in enumerate(features, 1):
        ring = [(wrap_lon(lon), lat) for lon, lat in f["coords"]]
        geom = Polygon(ring).buffer(0)   # buffer(0) repairs self-crossing outlines
        kind = "polygon"
        if geom.is_empty or geom.area == 0:
            print("Ignoring an empty shape.")
            continue
        sites.append({
            "name": f"site{n}_{kind}",                 # numbered like the JSON, even if a shape is skipped
            "index": n - 1,
            "kind": kind,
            "geom": geom,
        })
    return sites


def utm_epsg(lon, lat):
    """UTM zone of the shape centre (Greece spans zones 34N and 35N)."""
    zone = int((lon + 180) // 6) + 1
    return (32600 if lat >= 0 else 32700) + zone


def choose_resolution(bbox, max_pixels):
    """10 m if the shape is small enough, otherwise coarser (multiples of 10 m)."""
    west, south, east, north = bbox
    mid_lat = (south + north) / 2
    width_m = (east - west) * 111320 * math.cos(math.radians(mid_lat))
    height_m = (north - south) * 110540
    res = math.ceil(max(width_m, height_m) / max_pixels)
    return max(10, 10 * math.ceil(res / 10))


def grid_transform(x, y):
    """Affine transform of the pixel grid (x, y are pixel centres, y runs north to south)."""
    px = abs(float(x[1] - x[0])) if len(x) > 1 else 10.0
    return Affine(px, 0, x[0] - px / 2, 0, -px, y[0] + px / 2)


def inside_mask(geom, x, y, epsg, all_touched):
    """Boolean grid: True where the pixel is inside the drawn shape.
    all_touched=True  -> every pixel the outline touches (used for the picture and coverage check)
    all_touched=False -> only pixels whose centre is inside (used for statistics and ML data)"""
    to_utm = Transformer.from_crs(4326, epsg, always_xy=True).transform
    g = shapely.transform(geom, to_utm, interleaved=False)   # Shapely 2.1+
    return geometry_mask([g], out_shape=(len(y), len(x)), transform=grid_transform(x, y),
                         invert=True, all_touched=all_touched)


# --------------------------------------------------#
#                  Sentinel-2 helpers               #
# --------------------------------------------------#

def find_full_coverage_dates(catalog, geom, start, end):
    """
    Return {date: [items]} for dates whose Sentinel-2 footprints, combined,
    cover the whole shape. Combining footprints handles a shape that lies
    across two neighbouring tiles acquired on the same day.
    """
    items = catalog.search(
        collections=["sentinel-2-l2a"],
        bbox=list(geom.bounds),
        datetime=f"{start}/{end}",
        query={"eo:cloud_cover": {"lt": SCENE_CLOUD_PREFILTER}},
    ).item_collection()

    by_date = {}
    for item in sorted(items, key=lambda i: i.datetime):
        by_date.setdefault(item.datetime.date(), []).append(item)

    full, partial = {}, []
    for date, group in by_date.items():
        footprint = unary_union([shape(i.geometry) for i in group])
        # tiny tolerance (~10 m); the real pixel-level check happens after loading
        if footprint.buffer(1e-4).contains(geom):
            full[date] = group
        else:
            partial.append(date)

    print(f"  Dates with a usable scene over the site: {len(by_date)} "
          f"(scenes >{SCENE_CLOUD_PREFILTER}% cloudy not downloaded)")
    print(f"  Dates whose footprint covers the whole shape: {len(full)}")
    if partial:
        print("  Skipped (partial footprint): " + ", ".join(str(d) for d in partial))
    return full


def _baseline(item):
    try:
        return float(item.properties.get("s2:processing_baseline", "5.0"))
    except (TypeError, ValueError):
        return 5.0


def load_date(items, bbox, epsg, resolution, bands):
    """
    Load the requested bands (reflectance 0-1) and SCL for one date,
    mosaicking same-day tiles. Returns ({band: array}, scl, x, y).
    """
    common = dict(
        bounds_latlon=bbox,
        epsg=epsg,
        resolution=resolution,
        dtype="float64",
        fill_value=np.nan,
        xy_coords="center",
        rescale=False,            # raw digital numbers; scaled manually below
    )
    refl = stackstac.stack(items, assets=list(bands), resampling=Resampling.bilinear, **common)
    # SCL holds classes, not reflectance: nearest-neighbour, no rescaling
    scl = stackstac.stack(items, assets=["SCL"], resampling=Resampling.nearest, **common)

    # Raw value 0 = "no data". Turn it into NaN BEFORE mosaicking, so the
    # mosaic takes the real value from the other same-day tile instead.
    refl = refl.where(refl != 0)
    scl = scl.where(scl != 0)

    # Processing baseline >= 04.00 (since Jan 2022) adds +1000 to every value.
    # Decide it per scene, in the same order as the stack's time axis.
    if "s2:processing_baseline" in refl.coords:
        bl = np.atleast_1d(refl.coords["s2:processing_baseline"].values).astype(float)
        if bl.size == 1:
            bl = np.repeat(bl, refl.sizes["time"])
    else:
        bl = np.array([_baseline(i) for i in sorted(items, key=lambda i: i.datetime)])
    offset = xr.DataArray(np.where(bl >= 4.0, 1000.0, 0.0), dims="time")
    refl = (refl - offset) / 10000.0

    # both computed in one go, so the band and SCL downloads run at the same time (same values)
    refl, scl = dask.compute(stackstac.mosaic(refl, dim="time"), stackstac.mosaic(scl, dim="time"))

    refl_bands = {name: np.clip(refl.sel(band=name).values, 0, None) for name in bands}
    return refl_bands, scl.sel(band="SCL").values, refl.x.values, refl.y.values


# --------------------------------------------------#
#                 Output: images                    #
# --------------------------------------------------#

def save_image(values, inside, x, y, date, site, mode, spec, resolution, vmin, vmax, path):
    import matplotlib
    matplotlib.use("Agg")  # no GUI backend needed, avoids Tkinter errors
    import matplotlib.pyplot as plt
    from matplotlib.colors import ListedColormap

    cmap = plt.get_cmap(spec.cmap).copy()
    cmap.set_bad("lightgrey")                # clouds / masked pixels inside the shape

    px = abs(float(x[1] - x[0])) if len(x) > 1 else float(resolution)
    extent = [x[0] - px / 2, x[-1] + px / 2, y[-1] - px / 2, y[0] + px / 2]

    fig, ax = plt.subplots(figsize=(10, 8))
    if spec.rgb:
        valid = np.isfinite(values).all(axis=-1)
        img = np.where(valid[..., None], values, 0.83)   # light grey for clouds/masked pixels
        ax.imshow(img, extent=extent, origin="upper", interpolation="nearest")
        im = None
    else:
        im = ax.imshow(
            np.ma.masked_invalid(values), cmap=cmap, vmin=vmin, vmax=vmax,
            extent=extent, origin="upper", interpolation="nearest",
        )
    # white overlay for everything outside the drawn shape
    ax.imshow(
        (~inside).astype(float),
        cmap=ListedColormap([(1, 1, 1, 0), (1, 1, 1, 1)]), vmin=0, vmax=1,
        extent=extent, origin="upper", interpolation="nearest",
    )
    if im is not None:
        fig.colorbar(im, ax=ax, label=spec.label)

    w, s, e, n = site["geom"].bounds
    ax.set_title(
        f"{mode} - {date} - {site['name']}  ({resolution} m pixels)\n"
        f"lon {w:.4f} to {e:.4f}, lat {s:.4f} to {n:.4f}"
    )
    ax.set_xlabel("Easting (m)")
    ax.set_ylabel("Northing (m)")
    fig.savefig(path, dpi=200, bbox_inches="tight")
    plt.close(fig)


# -------------------------------------------------#
#                  Process Site                    #
# -------------------------------------------------#

def process_site(site, modes, catalog, start, end, max_cloud, keep_vegetation, make_images, out_dir, csv_writer):
    """Download each usable date once, then make the images for every chosen index (mode)."""
    geom = site["geom"]
    bbox = list(geom.bounds)
    cx, cy = geom.centroid.x, geom.centroid.y
    epsg = utm_epsg(cx, cy)
    resolution = choose_resolution(bbox, MAX_PIXELS)
    specs = {m: INDICES[m] for m in modes}

    # Vegetation masking: ON by default for bare-soil indices
    veg_mask = {m: spec.soil_only and not keep_vegetation for m, spec in specs.items()}
    needed = set().union(*(spec.bands for spec in specs.values()))
    if any(veg_mask.values()):
        needed |= {"B04", "B08"}
    bands = sorted(needed)

    print(f"\n=== {site['name']} ({', '.join(modes)}; {resolution} m pixels) ===")
    soil = [m for m in modes if veg_mask[m]]
    if soil:
        print(f"  {', '.join(soil)}: vegetation (NDVI > {VEG_NDVI}) and water are masked (bare-soil indices).")

    full_dates = retry(find_full_coverage_dates, catalog, geom, start, end, what=f"{site['name']} Sentinel-2 search")
    if not full_dates:
        print("  No date has data covering the whole shape. Skipping this site.")
        return 0

    site_dir = Path(out_dir) / site["name"]
    if make_images:
        site_dir.mkdir(parents=True, exist_ok=True)

    kept = {m: [] for m in modes}   # mode -> [(date, values, x, y, inside_draw, cloud_pct, stats)]
    # The next dates download while the current one is handled; dates are still handled one by
    # one in date order, so everything below sees exactly what it saw before.
    load = lambda date, items: retry(load_date, items, bbox, epsg, resolution, bands,
                                     what=f"{site['name']} Sentinel-2 {date}")
    for (date, items), loaded, error in in_order(load, full_dates.items(), DATE_DOWNLOADS):
        print(f"  {date}: loading {len(items)} scene(s)...")
        if error is not None:                        # one bad date never stops the site
            e = error
            print(f"!! {site['name']} salt_indexes {date}: {type(e).__name__}: {str(e)[:160]}", flush=True)
            continue
        refl, scl_v, x, y = loaded
        inside_draw = inside_mask(geom, x, y, epsg, all_touched=True)    # picture + coverage
        inside = inside_mask(geom, x, y, epsg, all_touched=False)        # statistics + ML data
        if not inside_draw.any():
            print("    skipped: shape is smaller than one pixel")
            continue
        if not inside.any():
            inside = inside_draw                                         # very thin shapes

        nodata = np.isnan(scl_v)
        for arr in refl.values():
            nodata |= np.isnan(arr)

        nodata_frac = nodata[inside_draw].mean()
        if nodata_frac > MAX_NODATA_FRACTION:
            print(f"    skipped: {nodata_frac:.1%} of the shape has no data")
            continue

        cloudy = np.isin(scl_v, BAD_SCL) & ~nodata
        cloud_pct = 100 * cloudy[inside].mean()
        if cloud_pct > max_cloud:
            print(f"    skipped: {cloud_pct:.1f}% cloud/shadow in the shape (limit {max_cloud}%)")
            continue

        # ---- values (and picture) per chosen index ----
        ndvi_v = norm_diff(refl["B08"], refl["B04"]) if any(veg_mask.values()) else None
        for mode, spec in specs.items():
            values = spec.func(refl)
            finite = np.isfinite(values).all(axis=-1) if spec.rgb else np.isfinite(values)
            bad_scl = BAD_SCL + (SOIL_EXTRA_SCL if spec.soil_only else [])
            invalid = nodata | np.isin(scl_v, bad_scl) | ~finite
            if veg_mask[mode]:
                invalid |= ndvi_v > VEG_NDVI
            drop = invalid | ~inside_draw
            if spec.rgb:
                drop = drop[..., None]          # broadcast over the 3 colour channels
            values = np.where(drop, np.nan, values).astype("float32")

            stat_mask = inside & ~invalid
            if not stat_mask.any():
                print(f"    {mode}: no valid pixels left after masking (all cloud, water or vegetation)")
                continue
            usable = 100 * float(stat_mask.sum()) / float(inside.sum())
            if spec.rgb:
                stats = {"usable": usable}                      # a picture: no values for the CSV
            else:
                sv = values[stat_mask]
                stats = {"usable": usable, "min": float(sv.min()), "mean": float(sv.mean()),
                         "max_typical": typical_max(sv), "max": float(sv.max())}
            print(f"    {mode}: kept ({cloud_pct:.1f}% cloud/shadow, {usable:.0f}% of the shape usable)"
                  + ("" if spec.rgb else f"  min {stats['min']:.4f} | mean {stats['mean']:.4f} | "
                                         f"typical max {stats['max_typical']:.4f} | max {stats['max']:.4f}"))
            kept[mode].append((date, values, x, y, inside_draw, cloud_pct, stats))

    n_out = 0
    for mode, spec in specs.items():
        if not kept[mode]:
            print(f"  {mode}: all dates were skipped.")
            continue
        # one colour scale for all dates of this site and index, so the images are comparable
        if spec.rgb or not make_images:
            vmin = vmax = None
        else:
            all_vals = np.concatenate([v[np.isfinite(v)] for _, v, *_ in kept[mode]])
            vmin, vmax = np.percentile(all_vals, [2, 98])
            print(f"  {mode} colour scale (2nd-98th percentile over all dates): {vmin:.3f} to {vmax:.3f}")

        for date, values, x, y, inside_draw, cloud_pct, st in kept[mode]:
            if not spec.rgb:
                csv_writer.writerow([
                    site["name"], mode, f"{cx:.6f}", f"{cy:.6f}", date, f"{cloud_pct:.1f}", f"{st['usable']:.1f}",
                    f"{st['min']:.5f}", f"{st['mean']:.5f}", f"{st['max_typical']:.5f}", f"{st['max']:.5f}",
                ])
                n_out += 1
            if make_images:
                path = site_dir / f"{mode.lower()}_{date}.png"
                save_image(values, inside_draw, x, y, date, site, mode, spec, resolution, vmin, vmax, path)
                print(f"  Saved {path}")
                n_out += spec.rgb                               # count TRUECOLOR images as output too
    return n_out


class RowCollector:
    """Stands in for csv.writer while a site runs in parallel: keeps its rows for later."""
    def __init__(self):
        self.rows = []

    def writerow(self, row):
        self.rows.append(row)


# -------------------------------------------------#
#                     Main                         #
# -------------------------------------------------#

def main():
    parser = argparse.ArgumentParser(description="Index values and images for sites picked on a map.")
    parser.add_argument("--source", help="path to the JSON file with the sites (required)")
    parser.add_argument("--mode", nargs="+", default=[DEFAULT_MODE], metavar="INDEX",
                        help=f"index/indices to make, e.g. --mode SI2 NDVI (default {DEFAULT_MODE}; see --list-indices)")
    parser.add_argument("--list-indices", action="store_true", help="show the available modes and exit")
    parser.add_argument("--keep-vegetation", action="store_true",
                        help="do NOT mask vegetation for soil indices (masked by default)")
    parser.add_argument("--onlydata", action="store_true", help="only write the CSV (no images)")
    parser.add_argument("--days", type=int, help="use the N days ending on each site's 'date' (else start..end)")
    parser.add_argument("--out", default=OUTPUT_DIR, help="output directory for the CSV and images")
    args = parser.parse_args()

    # Print the indices in a table, then exit.
    if args.list_indices:
        for name, spec in INDICES.items():
            kind = "bare soil" if spec.soil_only else "any"
            print(f"{name:<10} {kind:<10} bands {', '.join(spec.bands):<22} {spec.label}")
        return

    # Error if no source is given
    if not args.source:
        parser.error("--source is required (path to the JSON file with the sites)")

    # Get the requested modes for returning 
    modes = list(dict.fromkeys(m.upper() for m in args.mode))
    unknown = [m for m in modes if m not in INDICES]
    if unknown:
        parser.error(f"unknown index {', '.join(unknown)}. Available: {', '.join(INDICES)}")

    # Get the rest of the data 
    sel = json.loads(Path(args.source).read_text(encoding="utf-8"))
    features = sel["features"]
    start = sel.get("start", DEFAULT_START)
    end = sel.get("end", DEFAULT_END)
    max_cloud = float(sel.get("max_cloud", DEFAULT_MAX_CLOUD_IN_AREA))

    # Builds the sites from the coordinates (each with its own date window)
    windows = site_windows(sel, args.days)
    sites = build_sites(features)
    for site in sites:
        w_start, w_end = windows[site["index"]]
        site["start"], site["end"] = w_start.isoformat(), w_end.isoformat()
    if not sites:
        raise SystemExit("No valid sites to process.")

    print(f"\n{len(sites)} site(s), indices {', '.join(modes)}, dates {start} to {end}, "
          f"max cloud {max_cloud}%" + (", CSV only" if args.onlydata else ""))
    os.makedirs(args.out, exist_ok=True)

    catalog = retry(pystac_client.Client.open, "https://planetarycomputer.microsoft.com/api/stac/v1",
                    modifier=pc.sign_inplace, what="Planetary Computer")

    csv_path = os.path.join(args.out, "index_values.csv")
    total_images = 0

    def one(site):
        """One site; its CSV rows are collected and written in site order afterwards."""
        rows = RowCollector()
        try:
            n = process_site(
                site, modes, catalog, site["start"], site["end"], max_cloud, args.keep_vegetation,
                not args.onlydata, args.out, rows
            )
        except Exception as e:                       # one bad site never stops the others
            print(f"!! {site['name']} salt_indexes: {type(e).__name__}: {str(e)[:200]}", flush=True)
            n = 0
        return n, rows.rows

    # Sites mostly wait on the network, so several run at the same time. Images (matplotlib)
    # can't be drawn from several threads, so with images it stays one site at a time.
    threads = SITE_THREADS if args.onlydata else 1
    with open(csv_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["site", "index", "centre_lon", "centre_lat", "date", "cloud_pct", "usable_pct",
                         "min", "mean", "max_typical", "max"])
        with ThreadPoolExecutor(threads) as ex:
            for n, rows in ex.map(one, sites):          # results stay in site order
                writer.writerows(rows)
                total_images += n
                fh.flush()

    if total_images == 0:
        print("\nNothing was produced (no clear dates). Try a longer date range, a higher cloud limit, "
              "or larger shapes.")
    print(f"\nFinished. Values in {csv_path}" + ("" if args.onlydata else f", images in '{args.out}'"))


if __name__ == "__main__":
    main()