#!/usr/bin/env python3
"""
ECOSTRESS evapotranspiration (70 m) for the polygons in source.json:
min / mean / max ET per good overpass and a best-estimate per month.
Before ECOSTRESS existed (launched 29 June 2018, data from 9 July 2018) MODIS fills in.

    python evapotranspiration.py --source source.json              # CSVs + images
    python evapotranspiration.py --source source.json --onlydata   # CSVs only
    python evapotranspiration.py --source source.json --no-modis   # ECOSTRESS only
    python evapotranspiration.py --source source.json --days 90    # the 90 days ending on each site's "date"

Data: ECOSTRESS v003 where available, otherwise v002 (archive from July 2018 onwards).
      MODIS MOD16A2GF v061 (500 m, 8-day, gap-filled) for days before 9 July 2018.

Steps
  1. Downloads ETdaily + water + cloud for every ECOSTRESS overpass in the date range.
  2. Keeps an overpass only if it covers the whole polygon and was taken in daylight
     hours that give reliable daily ET (default 9-17 h solar time). Water and clouds are masked.
  3. If the date range starts before 9 July 2018: downloads the MODIS 8-day ET for those days
     and samples it onto the same grid as the ECOSTRESS maps (each 500 m MODIS pixel covers
     roughly 7 x 7 ECOSTRESS pixels, so MODIS maps look blocky). MODIS pixels without ET
     (urban, barren, water) get the polygon's MODIS mean.
  4. Monthly ET per pixel:
       - days before 9 July 2018: MODIS 8-day ET spread evenly over its days;
       - later days: on each good date Kc = ET / ET0 (ET0 = FAO reference ET from Open-Meteo).
         Kc is interpolated day by day for each pixel, multiplied by the daily ET0 and summed
         per month. The last MODIS period also counts as a Kc point, so the days between
         9 July 2018 and the first clear ECOSTRESS pass are bridged rather than held flat.
  5. Writes the CSVs (and images), then deletes the downloaded files.

"Typical max" ignores a few outlier pixels (at most 5% of the polygon, beyond
quartile + 1.5 x spread); if more pixels are that high they are real and typical = actual max.

Output (in --out, default et_output/)
  et_daily.csv     site, date, source, version, time_utc, period_days, clear_pct,
                   et_min, et_mean, et_max_typical, et_max                      (mm/day)
                   ECOSTRESS rows: one overpass (period_days 1).
                   MODIS rows: date = first day of the 8-day period, ET = mean mm/day over it.
  et_window.csv    one row per site: total ET over its whole window (what build_dataset uses)
                   site, start, end, days, source, modis_days, good_dates, et0_mm,
                   et_min_mm, et_mean_mm, et_max_typical_mm, et_max_mm, kc_mean
  et_monthly.csv   site, month, source, days, modis_days, good_dates, et0_mm,
                   et_min_mm, et_mean_mm, et_max_typical_mm, et_max_mm
                   source = ECOSTRESS, MODIS or MODIS+ECOSTRESS (July 2018)
  <site>/<date>_ET.png             daily ET map of each good overpass   (not with --onlydata)
  <site>/<date>_ET_MODIS.png       MODIS 8-day ET map                   (not with --onlydata)
  <site>/<YYYY-MM>_ET_month.png     estimated monthly ET map            (not with --onlydata)

ET0 (reference ET) comes from NASA POWER daily weather (FAO-56 Penman-Monteith), via Data/common.py.
MODIS tiles are kept in modis_cache/ (next to this script) and reused by later runs.

Needs: python -m pip install numpy pillow matplotlib earthaccess requests pyproj pyhdf
       (pyhdf reads the MODIS HDF4 files; GDAL with HDF4 support works instead)
"""
import argparse
import csv
import json
import re
import shutil
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date as Date, timedelta
from pathlib import Path

import numpy as np
from matplotlib.path import Path as PolyPath
from PIL import Image
from pyproj import Transformer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))   # Data/ (common.py)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import fill_daily, parse_date, retry, site_windows, weather_daily  # noqa: E402

# ECOSTRESS L3T JET (70 m tiled ET). v003 is newest but its archive is not complete yet,
# so v002 (July 2018 onwards) fills every pass v003 doesn't have.
COLLECTIONS = [("v003", dict(concept_id="C4057232489-LPCLOUD")),
               ("v002", dict(short_name="ECO_L3T_JET", version="002"))]
W_M2_TO_MM_DAY = 86400 / 2.45e6       # daily-mean latent heat (W/m2) -> mm/day
LAYERS = ("ETdaily", "water", "cloud")
KC_MAX = 1.5                         # cap on ET/ET0 (removes outliers)
OUTLIER_SHARE = 0.05                 # at most 5% of pixels may be outliers on each side
NAME_RE = re.compile(r"_(\w{5})_(\d{8})T(\d{2})(\d{2})\d{2}_")   # ..._34SEH_20261004T081809_...

# MODIS: days before ECOSTRESS, and every day of sites with no good ECOSTRESS pass
ECOSTRESS_START = Date(2018, 7, 9)   # first ECOSTRESS data
MODIS_QUERY = dict(short_name="MOD16A2GF", version="061")      # Terra, 500 m, 8-day, gap-filled
MODIS_RE = re.compile(r"\.A(\d{4})(\d{3})\.h(\d{2})v(\d{2})\.")  # MOD16A2GF.A2018001.h19v05.061...
SIN_R = 6371007.181                  # MODIS sinusoidal grid: sphere radius (m)
SIN_PX = 1111950.5196666666 / 2400   # tile = 10 deg = 2400 x 2400 px of ~463 m
SIN_X0, SIN_Y0 = -20015109.355798, 10007554.677899               # upper-left corner of tile h00v00
ECO_GRID_PX = 70.0                   # grid used when no ECOSTRESS pass is available
MODIS_CACHE = Path(__file__).resolve().parent / "modis_cache"   # MODIS tiles kept and reused
PASS_DOWNLOADS = 4                   # ECOSTRESS passes downloading at the same time (1 = one by one)


# ------------------------------------------------------------- statistics --
def typical_range(v, min_spread):
    """Lowest / highest value of the main body of pixels, ignoring a few outliers."""
    q1, q3 = np.percentile(v, [25, 75])
    spread = 1.5 * max(q3 - q1, min_spread)
    low, high = v < q1 - spread, v > q3 + spread
    tmin = v[~low].min() if low.mean() <= OUTLIER_SHARE else v.min()
    tmax = v[~high].max() if high.mean() <= OUTLIER_SHARE else v.max()
    return float(tmin), float(tmax)


def stats(v, min_spread, digits):
    tmin, tmax = typical_range(v, min_spread)
    return {"min": round(float(v.min()), digits), "mean": round(float(v.mean()), digits),
            "max_typical": round(tmax, digits), "max": round(float(v.max()), digits), "_tmin": tmin, "_tmax": tmax}


# --------------------------------------------------------------- reading --
def read_tif(path):
    """Array (NaN = no data) + UTM grid info from an ECOSTRESS GeoTIFF."""
    im = Image.open(path)
    tags = im.tag_v2
    a = np.array(im, dtype="float64")
    try:
        a[a == float(str(tags.get(42113)).strip("\x00"))] = np.nan
    except (TypeError, ValueError):
        pass
    zone = re.search(r"UTM zone (\d+)N", str(tags.get(34737)))
    if not zone:                                     # masks only need the array
        return a, None
    return a, {"px": tags[33550][0], "x0": tags[33922][3], "y0": tags[33922][4],
               "epsg": 32600 + int(zone.group(1))}


def polygon_window(coords, g, shape):
    """Pixel window around the polygon + inside-mask, or None if the polygon leaves the tile."""
    xs, ys = Transformer.from_crs(4326, g["epsg"], always_xy=True).transform(*np.array(coords).T)
    cols, rows = (xs - g["x0"]) / g["px"], (g["y0"] - ys) / g["px"]
    c0, c1 = int(np.floor(cols.min())), int(np.ceil(cols.max()))
    r0, r1 = int(np.floor(rows.min())), int(np.ceil(rows.max()))
    if c0 < 0 or r0 < 0 or c1 > shape[1] or r1 > shape[0]:
        return None
    rr, cc = np.mgrid[r0:r1, c0:c1]
    inside = PolyPath(np.c_[cols, rows]).contains_points(
        np.c_[cc.ravel() + 0.5, rr.ravel() + 0.5]).reshape(rr.shape)
    if not inside.any():                             # polygon smaller than a pixel: use the pixel under its centre
        r, c = int(np.floor(rows.mean())) - r0, int(np.floor(cols.mean())) - c0
        if 0 <= r < inside.shape[0] and 0 <= c < inside.shape[1]:
            inside[r, c] = True
    return (slice(r0, r1), slice(c0, c1)), inside, np.c_[cols - c0, rows - r0]


def read_modis_et(path, window=None):
    """ET_500m of one MOD16A2GF tile in mm per 8-day period (NaN = water, urban, barren, no data).
    window = (row0, row1, col0, col1): read only that part of the 2400 x 2400 tile (same values)."""
    try:
        from pyhdf.SD import SD, SDC
        sd = SD(str(path), SDC.READ)
        sds = sd.select("ET_500m")
        a = (sds[window[0]:window[1], window[2]:window[3]] if window else sds[:]).astype("float64")
        sd.end()
    except ImportError:
        try:
            from osgeo import gdal
        except ImportError:
            raise SystemExit("Reading MODIS needs pyhdf (python -m pip install pyhdf) or GDAL; "
                             "or run with --no-modis.")
        ds = gdal.Open(str(path))
        sub = next(s for s, _ in ds.GetSubDatasets() if s.endswith(":ET_500m"))
        a = (gdal.Open(sub).ReadAsArray(window[2], window[0], window[3] - window[2], window[1] - window[0])
             if window else gdal.Open(sub).ReadAsArray()).astype("float64")
    a[a > 32700] = np.nan                           # 32761-32767 = fill / water / urban / barren ...
    return np.clip(a, 0, None) * 0.1                # scale factor 0.1 -> kg/m2 = mm


def modis_index(lon, lat):
    """MODIS tile h, v and row, col of the 500 m pixel that contains each lon/lat."""
    lon, lat = np.radians(lon), np.radians(lat)
    col = np.floor((SIN_R * lon * np.cos(lat) - SIN_X0) / SIN_PX).astype(int)
    row = np.floor((SIN_Y0 - SIN_R * lat) / SIN_PX).astype(int)
    return col // 2400, row // 2400, row % 2400, col % 2400


def fetch_et0(lat, lon, start, end):
    """Daily FAO-56 reference ET (mm/day) from NASA POWER weather, gaps filled by interpolation."""
    start, end = parse_date(start), parse_date(end)
    w = retry(weather_daily, lat, lon, start, end, what="NASA POWER weather")
    return fill_daily({d: v["et0"] for d, v in w.items()}, start, end)


# ----------------------------------------------------------------- image --
def save_map(arr, poly_px, s, path, title, unit):
    """Smooth map clipped to the polygon; colours span the typical range, outliers in magenta/black."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Polygon as Outline

    vmin, vmax = s["_tmin"], s["_tmax"]          # unrounded, so the actual max isn't flagged
    if vmax - vmin < 1e-6:
        vmin, vmax = vmin - 0.5, vmax + 0.5
    cmap = plt.get_cmap("YlGnBu").copy()
    cmap.set_over("magenta")
    cmap.set_under("black")
    h, w = arr.shape
    fig, ax = plt.subplots(figsize=(8, max(2.5, 7 * h / w) + 1.2))
    im = ax.imshow(arr, cmap=cmap, vmin=vmin, vmax=vmax)
    outline = np.vstack([poly_px, poly_px[:1]]) - 0.5
    im.set_clip_path(Outline(outline, closed=True, transform=ax.transData))   # crisp polygon edge
    ax.plot(*outline.T, color="black", lw=1)
    n_over, n_under = int((arr > vmax).sum()), int((arr < vmin).sum())
    extend = {(0, 0): "neither", (0, 1): "max", (1, 0): "min", (1, 1): "both"}[(n_under > 0, n_over > 0)]
    fig.colorbar(im, ax=ax, shrink=0.7, extend=extend, label=f"ET ({unit})")
    note = ([f"magenta = {n_over} px above {vmax:.2f}"] if n_over else []) + \
           ([f"black = {n_under} px below {vmin:.2f}"] if n_under else [])
    ax.set_title(f"{title}\nmin {s['min']} | mean {s['mean']} | typical max {s['max_typical']} | "
                 f"actual max {s['max']}  ({unit})" + (f"\n{', '.join(note)}" if note else ""), fontsize=10)
    ax.axis("off")
    fig.savefig(path, dpi=120, bbox_inches="tight")
    plt.close(fig)


# ---------------------------------------------------------- one overpass --
def read_overpass(et_path, coords, hours):
    """Masked ET inside the polygon for one overpass, or (info, reason it was skipped)."""
    tile, ymd, hh, mm = NAME_RE.search(et_path.name).groups()
    day = Date(int(ymd[:4]), int(ymd[4:6]), int(ymd[6:]))
    solar = (int(hh) + int(mm) / 60 + np.mean([p[0] for p in coords]) / 15) % 24
    info = {"tile": tile, "date": day, "time": f"{hh}:{mm}",
            "version": "v002" if "ECOv002" in et_path.name else "v003"}
    if not hours[0] <= solar <= hours[1]:
        return info, f"overpass at {solar:.1f} h solar time (too early/late for daily ET)"

    et, g = read_tif(et_path)
    win = polygon_window(coords, g, et.shape)
    if win is None:
        return info, "image does not cover the whole polygon"
    (rs, cs), inside, poly_px = win
    mask = {}
    for layer in ("water", "cloud"):
        p = Path(str(et_path).replace("_ETdaily.tif", f"_{layer}.tif"))
        mask[layer] = read_tif(p)[0][rs, cs] > 0 if p.exists() else np.zeros_like(inside)
    et = et[rs, cs]
    if np.nanmedian(et[inside]) > 20:                # > 20 mm/day is impossible -> file is in W/m2
        et = et * W_M2_TO_MM_DAY

    land = inside & ~mask["water"]
    if not land.any():
        return info, "polygon is all water"
    if (land & np.isnan(et) & ~mask["cloud"]).any():         # no data that isn't cloud = outside swath
        return info, "image does not cover the whole polygon"
    et = np.where(land & ~mask["cloud"], et, np.nan)
    if np.isnan(et).all():
        return info, "fully cloudy"
    info.update(et=et, land=land, poly_px=poly_px, grid=dict(g, rows=rs, cols=cs),
                clear_pct=100 * np.isfinite(et).sum() / land.sum())
    return info, None


# ------------------------------------------------------------ site grid --
def site_grid(coords, good):
    """Grid for the monthly estimate of one site: the ECOSTRESS tile with the most good dates,
    or (no good dates) a 70 m UTM grid around the polygon.
    Returns (good dates on that grid, grid, land mask, polygon outline in pixels) or None."""
    if good:
        # all arrays must share one grid: keep the tile with the most good dates
        tile = max({g["tile"] for g in good}, key=lambda t: sum(g["tile"] == t for g in good))
        good = sorted((g for g in good if g["tile"] == tile), key=lambda g: (g["date"], g["time"]))
        return good, good[0]["grid"], good[0]["land"], good[0]["poly_px"]
    lon, lat = np.mean(np.array(coords, dtype=float), axis=0)
    epsg = (32600 if lat >= 0 else 32700) + int((lon + 180) // 6) % 60 + 1
    xs, ys = Transformer.from_crs(4326, epsg, always_xy=True).transform(*np.array(coords, dtype=float).T)
    px = ECO_GRID_PX
    g = {"px": px, "x0": np.floor(xs.min() / px) * px - px, "y0": np.ceil(ys.max() / px) * px + px,
         "epsg": epsg}
    shape = (int((g["y0"] - ys.min()) / px) + 2, int((xs.max() - g["x0"]) / px) + 2)
    (rs, cs), inside, poly_px = polygon_window(coords, g, shape)
    if not inside.any():
        return None
    return [], dict(g, rows=rs, cols=cs), inside, poly_px


def pixel_lonlat(grid, land):
    """Lon / lat of the centre of every land pixel (same order as array[land])."""
    r, c = np.nonzero(land)
    x = grid["x0"] + (grid["cols"].start + c + 0.5) * grid["px"]
    y = grid["y0"] - (grid["rows"].start + r + 0.5) * grid["px"]
    return Transformer.from_crs(grid["epsg"], 4326, always_xy=True).transform(x, y)


# ------------------------------------------------------- MODIS fallback --
def clear_folder(folder):
    """Delete everything inside a download folder (files and per-pass sub-folders)."""
    for p in folder.glob("*"):
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        else:
            p.unlink(missing_ok=True)


def to_modis_cache(f):
    """Move a downloaded MODIS file into modis_cache/."""
    dest = MODIS_CACHE / f.name
    try:
        f.replace(dest)
    except OSError:                                  # another batch saved the same tile just now
        if not dest.exists():
            raise
        f.unlink(missing_ok=True)


def modis_periods(sites_px, start, end, bbox, tmp):
    """MODIS 8-day ET (mm/day) at the land pixels of every site, for the whole window.
    sites_px: {site: (h, v, row, col) per land pixel}. Returns {site: [period, ...]}."""
    import earthaccess
    last = Date.fromisoformat(end)                   # whole window: MODIS also fills days without ECOSTRESS
    # only the tiles that hold a site pixel: other tiles in the search box give no value to any site
    needed = {(int(th), int(tv)) for h, v, _, _ in sites_px.values() for th, tv in zip(h, v)}
    # per tile: the rows/cols that hold site pixels, so only that part of each tile is read
    windows = {}
    for h, v, r, c in sites_px.values():
        for tile in {(int(th), int(tv)) for th, tv in zip(h, v)}:
            sel = (h == tile[0]) & (v == tile[1])
            w = (int(r[sel].min()), int(r[sel].max()) + 1, int(c[sel].min()), int(c[sel].max()) + 1)
            old = windows.get(tile, w)
            windows[tile] = (min(old[0], w[0]), max(old[1], w[1]), min(old[2], w[2]), max(old[3], w[3]))
    groups = {}
    for g in retry(earthaccess.search_data, temporal=(start, last.isoformat()), bounding_box=bbox,
                   what="MODIS search", **MODIS_QUERY):
        for u in g.data_links():
            m = MODIS_RE.search(u)
            if u.endswith(".hdf") and m:
                key = (int(m[1]), int(m[2]))
                groups.setdefault(key, set())             # the period counts even without a needed tile
                if (int(m[3]), int(m[4])) in needed:
                    groups[key].add(u)
    print(f"\nMODIS: {len(groups)} 8-day periods to download between {start} and {last} "
          f"(cached in modis_cache/).")

    # Every tile not in the cache yet is downloaded in ONE call (earthaccess fetches several files at
    # the same time) instead of one period after another. Anything that fails here is simply
    # downloaded again, period by period with retries, by the loop below - the same as before.
    MODIS_CACHE.mkdir(exist_ok=True)
    missing = sorted(u for urls in groups.values() for u in urls
                     if not (MODIS_CACHE / u.rsplit("/", 1)[-1]).exists())
    if missing:
        print(f"  downloading {len(missing)} MODIS file(s) at the same time...", flush=True)
        try:
            for f in earthaccess.download(missing, local_path=str(tmp)) or []:
                if f:
                    to_modis_cache(Path(f))
        except Exception as e:
            print(f"   (MODIS download together failed: {str(e)[:120]} - one period at a time instead)",
                  flush=True)
        finally:
            clear_folder(tmp)
    out = {name: [] for name in sites_px}
    for k, (year, doy) in enumerate(sorted(groups), 1):
        first = Date(year, 1, 1) + timedelta(doy - 1)
        ndays = min(8, (Date(year, 12, 31) - first).days + 1)     # last period of a year is 5-6 days
        print(f"[MODIS {k}/{len(groups)}] {first} ({ndays} days)")
        try:
            MODIS_CACHE.mkdir(exist_ok=True)
            urls = sorted(groups[(year, doy)])
            todo = [u for u in urls if not (MODIS_CACHE / u.rsplit("/", 1)[-1]).exists()]
            if todo:                                    # download to tmp, then move into the cache
                for f in retry(earthaccess.download, todo, local_path=str(tmp), what=f"MODIS {first}") or []:
                    if f:
                        to_modis_cache(Path(f))
            files = [MODIS_CACHE / u.rsplit("/", 1)[-1] for u in urls
                     if (MODIS_CACHE / u.rsplit("/", 1)[-1]).exists()]
            tiles = {}
            for f in files:
                m = MODIS_RE.search(Path(f).name)
                if m:
                    tile = (int(m[3]), int(m[4]))
                    win = windows.get(tile)                         # only the part with site pixels
                    tiles[tile] = (read_modis_et(f, win) / ndays,  # mm/day
                                   win[0] if win else 0, win[2] if win else 0)
            for name, (h, v, r, c) in sites_px.items():
                vals = np.full(len(r), np.nan)
                for (th, tv), (a, r0, c0) in tiles.items():
                    sel = (h == th) & (v == tv)
                    vals[sel] = a[r[sel] - r0, c[sel] - c0]
                out[name].append({"date": first, "ndays": ndays, "et": vals})
        finally:
            clear_folder(tmp)
    return out


def handle_modis(name, periods, land, poly_px, site_dir, make_images, daily_rows, window):
    """Daily-CSV rows (and maps) of the MODIS periods of one site; returns the usable periods."""
    usable = []
    for p in periods:
        if p["date"] > window[1] or p["date"] + timedelta(p["ndays"] - 1) < window[0]:
            continue                                     # period outside this site's window
        v = p["et"][np.isfinite(p["et"])]
        last = p["date"] + timedelta(p["ndays"] - 1)
        tag = f"MODIS {p['date']}..{last}"
        if not v.size:
            print(f"  {name} {tag}: skipped (no MODIS ET in the polygon)")
            continue
        clear = 100 * v.size / p["et"].size
        s = stats(v, min_spread=0.3, digits=2)                                       # mm/day
        print(f"  {name} {tag}: min {s['min']} | mean {s['mean']} | typical max {s['max_typical']} | "
              f"max {s['max']} mm/day, {clear:.0f}% with ET")
        daily_rows.append({"site": name, "date": p["date"], "source": "MODIS MOD16A2GF", "version": "061",
                           "time_utc": "", "period_days": p["ndays"], "clear_pct": round(clear, 1),
                           "et_min": s["min"], "et_mean": s["mean"],
                           "et_max_typical": s["max_typical"], "et_max": s["max"]})
        if make_images:
            site_dir.mkdir(parents=True, exist_ok=True)
            et_map = np.full(land.shape, np.nan)
            et_map[land] = p["et"]
            save_map(et_map, poly_px, s, site_dir / f"{p['date']}_ET_MODIS.png",
                     f"{name} – {tag} (500 m, 8-day mean) – {clear:.0f}% with ET", "mm/day")
        usable.append(p)
    return usable


# ------------------------------------------------------- monthly estimate --
def monthly_et(good, modis, et0, land, group=lambda d: d.strftime("%Y-%m")):
    """Per-pixel monthly ET (mm).
    Days before ECOSTRESS (or every day, if the site has no good ECOSTRESS pass): MODIS 8-day ET. Other days: Kc = ET/ET0 interpolated between
    good ECOSTRESS dates (MODIS periods count as extra Kc points)."""
    days = sorted(et0)
    col = {d: i for i, d in enumerate(days)}
    e0 = np.array([et0[d] for d in days])
    x_all = np.array([d.toordinal() for d in days], dtype=float)
    daily_et = np.full((int(land.sum()), len(days)), np.nan)
    from_modis = np.zeros(len(days), bool)

    anchors = [(g["date"].toordinal(), np.clip(g["et"][land] / et0[g["date"]], 0, KC_MAX)) for g in good]
    site_kc = np.nanmedian(np.stack([a[1] for a in anchors])) if anchors else np.nan  # pixels never clear

    for p in modis:
        vals = np.where(np.isfinite(p["et"]), p["et"], np.nanmean(p["et"]))   # no-ET pixels: polygon mean
        in_range = [p["date"] + timedelta(k) for k in range(p["ndays"])]
        in_range = [d for d in in_range if d in col]
        for d in in_range:
            if d < ECOSTRESS_START or not good:          # no ECOSTRESS for this site: MODIS directly
                daily_et[:, col[d]] = vals
                from_modis[col[d]] = True
        if in_range:                                    # Kc point in the middle of the period
            mid = p["date"].toordinal() + (p["ndays"] - 1) / 2
            ref = max(np.mean([et0[d] for d in in_range]), 0.1)
            anchors.append((mid, np.clip(vals / ref, 0, KC_MAX)))

    need = ~from_modis                                  # ECOSTRESS days (and MODIS gaps)
    if anchors and need.any():
        anchors.sort(key=lambda a: a[0])
        x_kc = np.array([a[0] for a in anchors], dtype=float)
        kc = np.stack([a[1] for a in anchors])          # (dates, pixels)
        for p in range(kc.shape[1]):                    # each pixel uses its own clear dates
            ok = np.isfinite(kc[:, p])
            pk = np.interp(x_all[need], x_kc[ok], kc[ok, p]) if ok.any() else site_kc
            daily_et[p, need] = pk * e0[need]

    months = {}
    for i, d in enumerate(days):
        months.setdefault(group(d), []).append(i)
    out = {}
    for month, idx in months.items():
        n_modis = int(from_modis[idx].sum())
        missing = int(np.isnan(daily_et[:, idx]).all(axis=0).sum())
        et_map = np.full(land.shape, np.nan)
        et_map[land] = daily_et[:, idx].sum(axis=1)
        out[month] = {"et": et_map, "et0": sum(et0[days[i]] for i in idx), "days": len(idx),
                      "modis_days": n_modis, "missing": missing,
                      "source": "MODIS" if n_modis == len(idx) else "MODIS+ECOSTRESS" if n_modis else "ECOSTRESS",
                      "good_dates": sum(group(g["date"]) == month for g in good if g["date"] in col)}
    return out


# ------------------------------------------------------------------ site --
def handle_pass(name, coords, et_path, hours, site_dir, make_images, good, daily_rows, window):
    """Read one overpass for one site; record it if it's good."""
    m = NAME_RE.search(et_path.name)
    day = Date(int(m[2][:4]), int(m[2][4:6]), int(m[2][6:]))
    if not window[0] <= day <= window[1]:
        return                                           # pass outside this site's window
    info, skip = read_overpass(et_path, coords, hours)
    tag = f"{info['date']} {info['time']} UTC"
    if skip:
        print(f"  {name} {tag}: skipped ({skip})")
        return
    s = stats(info["et"][np.isfinite(info["et"])], min_spread=0.3, digits=2)    # mm/day
    print(f"  {name} {tag} ({info['version']}): min {s['min']} | mean {s['mean']} | "
          f"typical max {s['max_typical']} | max {s['max']} mm/day, {info['clear_pct']:.0f}% clear")
    daily_rows.append({"site": name, "date": info["date"], "source": "ECOSTRESS", "version": info["version"],
                       "time_utc": info["time"], "period_days": 1, "clear_pct": round(info["clear_pct"], 1),
                       "et_min": s["min"], "et_mean": s["mean"],
                       "et_max_typical": s["max_typical"], "et_max": s["max"]})
    if make_images:
        site_dir.mkdir(parents=True, exist_ok=True)
        n = sum(g["date"] == info["date"] for g in good)
        save_map(info["et"], info["poly_px"], s,
                 site_dir / f"{info['date']}_ET{'_' + str(n + 1) if n else ''}.png",
                 f"{name} – {tag} – {info['clear_pct']:.0f}% clear", "mm/day")
    good.append(info)


def finish_site(name, coords, good, modis, land, poly_px, start, end, site_dir, make_images):
    """Monthly estimate and whole-window total from all good overpasses (and MODIS periods) of one site.
    Returns (month rows, window row or None)."""
    print(f"\n=== {name}: monthly estimate ({start}..{end}) ===")
    if not good and not modis:
        print("  No good dates - no monthly estimate.")
        return [], None

    et0 = fetch_et0(np.mean([c[1] for c in coords]), np.mean([c[0] for c in coords]), start, end)
    if et0 is None:
        print("  Could not get ET0 - no monthly estimate.")
        return [], None

    month_rows = []
    for month, m in monthly_et(good, modis, et0, land).items():
        if m["missing"]:
            print(f"  {month}: no data for {m['missing']} of {m['days']} days - no estimate")
            continue
        s = stats(m["et"][np.isfinite(m["et"])], min_spread=5.0, digits=1)           # mm/month
        if m["source"] == "MODIS":
            note = "MODIS 500 m"
        else:
            note = f"{m['good_dates']} good dates" if m["good_dates"] else "no good dates - from nearest dates"
            if m["modis_days"]:
                note += f", {m['modis_days']} days from MODIS"
        print(f"  {month}: min {s['min']} | mean {s['mean']} | typical max {s['max_typical']} | "
              f"max {s['max']} mm | ET0 {m['et0']:.0f} mm | {note}")
        month_rows.append({"site": name, "month": month, "source": m["source"], "days": m["days"],
                           "modis_days": m["modis_days"], "good_dates": m["good_dates"],
                           "et0_mm": round(m["et0"], 1), "et_min_mm": s["min"], "et_mean_mm": s["mean"],
                           "et_max_typical_mm": s["max_typical"], "et_max_mm": s["max"]})
        if make_images:
            site_dir.mkdir(parents=True, exist_ok=True)
            save_map(m["et"], poly_px, s, site_dir / f"{month}_ET_month.png",
                     f"{name} – {month} estimated ET – ET0 {m['et0']:.0f} mm – {note}", "mm/month")

    w = monthly_et(good, modis, et0, land, group=lambda d: "window")["window"]
    window_row = None
    if not w["missing"]:
        s = stats(w["et"][np.isfinite(w["et"])], min_spread=5.0, digits=1)
        window_row = {"site": name, "start": start, "end": end, "days": w["days"], "source": w["source"],
                      "modis_days": w["modis_days"], "good_dates": w["good_dates"], "et0_mm": round(w["et0"], 1),
                      "et_min_mm": s["min"], "et_mean_mm": s["mean"], "et_max_typical_mm": s["max_typical"],
                      "et_max_mm": s["max"], "kc_mean": round(s["mean"] / w["et0"], 3) if w["et0"] else ""}
        print(f"  whole window: {s['mean']} mm (ET0 {w['et0']:.0f} mm, {w['source']})")
    else:
        print(f"  whole window: no data for {w['missing']} of {w['days']} days - no total")
    return month_rows, window_row


def write_csv(path, rows):
    if rows:
        with open(path, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)


# ------------------------------------------------------------------ main --
def main():
    ap = argparse.ArgumentParser(description="ECOSTRESS ET (daily + monthly + window total) for map polygons.")
    ap.add_argument("--source", required=True, help="JSON saved by the map page / build_dataset.py")
    ap.add_argument("--days", type=int, help="use the N days ending on each site's 'date' (else start..end)")
    ap.add_argument("--onlydata", action="store_true", help="only write the CSVs (no images)")
    ap.add_argument("--out", default="et_output", help="output folder")
    ap.add_argument("--min-hour", type=float, default=9, help="earliest usable overpass, solar time")
    ap.add_argument("--max-hour", type=float, default=17, help="latest usable overpass, solar time")
    ap.add_argument("--no-modis", action="store_true",
                    help="don't use MODIS (days without ECOSTRESS stay empty)")
    args = ap.parse_args()

    req = json.loads(Path(args.source).read_text(encoding="utf-8"))
    sites = [f["coords"] for f in req["features"]]
    windows = site_windows(req, args.days)
    start = min(w[0] for w in windows).isoformat()          # one search covers every site's window
    end = max(w[1] for w in windows).isoformat()
    out_dir, tmp = Path(args.out), Path(args.out) / "tmp_download"
    tmp.mkdir(parents=True, exist_ok=True)

    lons = [p[0] for c in sites for p in c]
    lats = [p[1] for c in sites for p in c]
    import earthaccess
    retry(earthaccess.login, persist=True, what="NASA Earthdata login")
    bbox = (min(lons), min(lats), max(lons), max(lats))
    hours = (args.min_hour, args.max_hour)
    lon_c = float(np.mean(lons))
    names = [f"site{i}" for i in range(1, len(sites) + 1)]
    win = dict(zip(names, windows))
    good = {n: [] for n in names}
    daily = []
    grids = {}
    modis = {name: [] for name in names}
    use_modis = not args.no_modis
    print(f"{len(sites)} site(s), windows {start}..{end}")

    def safe(name, step, fn, *a, **k):
        """Run one step for one site; an error is reported and the site just gets no value."""
        try:
            return fn(*a, **k)
        except Exception as e:
            print(f"!! {name} evapotranspiration ({step}): {type(e).__name__}: {str(e)[:200]}", flush=True)
            return None

    try:
        if Date.fromisoformat(end) >= ECOSTRESS_START:
            passes, skipped_time = {}, 0
            eco_start = max(Date.fromisoformat(start), ECOSTRESS_START).isoformat()
            for version, query in COLLECTIONS:            # newest version first; skip passes already found
                n = 0
                found = safe("all", f"ECOSTRESS {version} search", retry, earthaccess.search_data,
                             temporal=(eco_start, end), bounding_box=bbox, what=f"ECOSTRESS {version} search",
                             **query) or []
                for g in found:
                    links = [u for u in g.data_links() if u.endswith(tuple(f"_{l}.tif" for l in LAYERS))]
                    m = next((NAME_RE.search(u) for u in links if NAME_RE.search(u)), None)
                    key = m.group(2, 3, 4, 1) if m else None   # date, hour, minute, tile
                    if key is None or key in passes:
                        continue
                    day = Date(int(key[0][:4]), int(key[0][4:6]), int(key[0][6:]))
                    if not any(w[0] <= day <= w[1] for w in windows):    # in nobody's window
                        continue
                    solar = (int(key[1]) + int(key[2]) / 60 + lon_c / 15) % 24
                    if not hours[0] - 0.5 <= solar <= hours[1] + 0.5:     # useless pass: don't download it
                        skipped_time += 1
                        continue
                    passes[key] = links
                    n += 1
                print(f"  {version}: {n} usable overpasses")
            print(f"{len(passes)} ECOSTRESS overpasses to download between {eco_start} and {end} "
                  f"({skipped_time} skipped: too early/late in the day). Up to {PASS_DOWNLOADS} downloading "
                  f"at a time, read in date order, deleted after reading.")

            order = sorted(passes)

            def fetch(j):
                """Download pass j (1-based) into its own folder."""
                key = order[j - 1]
                folder = tmp / f"pass_{j:05d}"
                folder.mkdir(parents=True, exist_ok=True)
                safe("all", f"download {key[0]}", retry, earthaccess.download, passes[key],
                     local_path=str(folder), what=f"ECOSTRESS {key[0]} download")
                return folder

            # The next passes download in the background while the current one is read. Passes are
            # still read one by one in date order, so the results are the same as before.
            with ThreadPoolExecutor(PASS_DOWNLOADS) as pool:
                ahead = {}
                for k, key in enumerate(order, 1):
                    for j in range(k, min(k + PASS_DOWNLOADS, len(order) + 1)):   # this pass + the next ones
                        if j not in ahead:
                            ahead[j] = pool.submit(fetch, j)
                    print(f"[{k}/{len(passes)}] {key[0]} {key[1]}:{key[2]} UTC")
                    folder = ahead.pop(k).result()
                    et_path = next(folder.glob("*_ETdaily.tif"), None)       # None if the download failed
                    if et_path:
                        for name, coords in zip(names, sites):
                            safe(name, f"pass {key[0]}", handle_pass, name, coords, et_path, hours,
                                 out_dir / name, not args.onlydata, good[name], daily, win[name])
                    shutil.rmtree(folder, ignore_errors=True)
        if use_modis:
            print(f"\nMODIS fills the days before {ECOSTRESS_START} and sites without a good ECOSTRESS pass.")

        # one grid per site: ECOSTRESS tile with most good dates, or a 70 m grid around the polygon
        for name, coords in zip(names, sites):
            gr = safe(name, "grid", site_grid, coords, good[name])
            if gr is None:
                print(f"  {name}: no grid (polygon smaller than one pixel?) - skipped")
            else:
                grids[name] = gr

        if use_modis and grids:
            sites_px = {name: modis_index(*pixel_lonlat(gr[1], gr[2])) for name, gr in grids.items()}
            raw = safe("all", "MODIS", modis_periods, sites_px, start, end, bbox, tmp) or {}
            for name, periods in raw.items():
                _, _, land, poly_px = grids[name]
                modis[name] = safe(name, "MODIS", handle_modis, name, periods, land, poly_px, out_dir / name,
                                   not args.onlydata, daily, win[name]) or []
    finally:
        clear_folder(tmp)
        try:
            tmp.rmdir()
        except OSError:                                  # a file still locked (Windows): leave the folder
            pass

    monthly, window_rows = [], []
    for name, coords in zip(names, sites):
        row = None
        if name in grids:
            site_good, _, land, poly_px = grids[name]
            res = safe(name, "monthly estimate", finish_site, name, coords, site_good, modis[name], land, poly_px,
                       win[name][0].isoformat(), win[name][1].isoformat(), out_dir / name, not args.onlydata)
            if res:
                monthly += res[0]
                row = res[1]
        window_rows.append(row or {"site": name, "start": win[name][0], "end": win[name][1]})

    daily.sort(key=lambda r: (int(r["site"][4:]), r["date"], r["time_utc"]))
    write_csv(out_dir / "et_daily.csv", daily)
    write_csv(out_dir / "et_monthly.csv", monthly)
    cols = ["site", "start", "end", "days", "source", "modis_days", "good_dates", "et0_mm", "et_min_mm",
            "et_mean_mm", "et_max_typical_mm", "et_max_mm", "kc_mean"]
    with open(out_dir / "et_window.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, restval="")
        w.writeheader()
        w.writerows(window_rows)
    n_eco = sum(r["source"] == "ECOSTRESS" for r in daily)
    print(f"\nDone: {n_eco} good ECOSTRESS overpasses, {len(daily) - n_eco} MODIS 8-day periods, "
          f"{len(monthly)} monthly estimates, {sum(bool(r.get('et_mean_mm')) for r in window_rows)} window totals "
          f"in {out_dir}/" + ("" if args.onlydata else " (+ images)") + " - downloaded files deleted.")


if __name__ == "__main__":
    main()