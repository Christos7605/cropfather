#!/usr/bin/env python3
"""
Topsoil (0-30 cm) clay % and sand % for the polygons in source.json -> one CSV.

    python soil_data.py --source source.json

Data: SoilGrids 2.0 (ISRIC - World Soil Information), 250 m global soil maps, free, no account.
The 0-30 cm value is the thickness-weighted average of the 0-5, 5-15 and 15-30 cm layers.
Only the small window over each polygon is read online; SoilGrids g/kg is divided by 10 to get %.

Output: soil_output/soil.csv  ->  site, clay_pct, sand_pct      (silt % = 100 - clay - sand)

Needs: python -m pip install numpy rasterio
"""
import argparse
import csv
import json
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import geometry_mask
from rasterio.warp import transform as warp
from rasterio.windows import from_bounds

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))   # Data/ (common.py)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import retry  # noqa: E402

BASE = ("/vsicurl?max_retry=3&retry_delay=1&list_dir=no&url="
        "https://files.isric.org/soilgrids/latest/data/{p}/{p}_{d}_mean.vrt")
PROPERTIES = ("clay", "sand")
TOPSOIL = {"0-5cm": 5, "5-15cm": 10, "15-30cm": 15}           # layer -> thickness (cm) for the 0-30 cm average
GDAL_ENV = dict(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_TIMEOUT="60")


def polygon_mean(prop, depth, coords):
    """Mean value (%) of one SoilGrids layer over the polygon, and number of pixels used."""
    with rasterio.Env(**GDAL_ENV), rasterio.open(BASE.format(p=prop, d=depth)) as src:
        return polygon_mean_src(src, coords)


def polygon_mean_src(src, coords):
    """polygon_mean on a layer that is already open (see Layer)."""
    xs, ys = warp("EPSG:4326", src.crs, [c[0] for c in coords], [c[1] for c in coords])
    pad = 2 * src.res[0]
    win = from_bounds(min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad, src.transform)
    win = win.round_offsets().round_lengths()
    a = src.read(1, window=win, boundless=True, fill_value=src.nodata or -32768).astype(float)
    tr = src.window_transform(win)
    nodata = src.nodata if src.nodata is not None else -32768

    a[a == nodata] = np.nan
    ring = {"type": "Polygon", "coordinates": [list(zip(xs, ys)) + [(xs[0], ys[0])]]}
    for touched in (False, True):                  # pixel centres inside, else any pixel touched
        m = geometry_mask([ring], a.shape, tr, invert=True, all_touched=touched) & np.isfinite(a)
        if m.any():
            return float(a[m].mean()) / 10, int(m.sum())   # g/kg -> %
    # polygon smaller than a pixel and on no-data edge: nearest valid pixel to the centre
    col, row = ~tr * (np.mean(xs), np.mean(ys))
    r, c = int(row), int(col)
    v = a[r, c] if 0 <= r < a.shape[0] and 0 <= c < a.shape[1] else np.nan
    return (float(v) / 10, 1) if np.isfinite(v) else (None, 0)


class Layer:
    """One SoilGrids layer (e.g. clay 0-5cm), opened ONCE and then read for every site.
    Opening a layer means fetching its large .vrt index over the internet; before, that was done
    again for every site. Only one thread uses a Layer, and a failed read closes it, so the
    retry opens it afresh - exactly like the old one-open-per-read did."""
    def __init__(self, prop, depth):
        self.url = BASE.format(p=prop, d=depth)
        self.src = None

    def mean(self, coords):
        try:
            if self.src is None:
                self.src = rasterio.open(self.url)
            return polygon_mean_src(self.src, coords)
        except Exception:
            self.close()
            raise

    def close(self):
        if self.src is not None:
            try:
                self.src.close()
            finally:
                self.src = None


def read_layer(prop, depth, sites, futures):
    """Read one layer for every site, in site order; each result goes to that site's future."""
    layer = Layer(prop, depth)
    try:
        with rasterio.Env(**GDAL_ENV):
            try:
                for i, coords in enumerate(sites, 1):
                    try:
                        futures[i - 1].set_result(retry(layer.mean, coords, what=f"site{i} soil {prop} {depth}"))
                    except Exception as e:               # one site failing never stops the others
                        futures[i - 1].set_exception(e)
            finally:
                layer.close()
    except BaseException as e:                           # never leave a site waiting for ever
        for f in futures:
            if not f.done():
                f.set_exception(e if isinstance(e, Exception) else RuntimeError(repr(e)))
        raise


def main():
    ap = argparse.ArgumentParser(description="Clay and sand % (SoilGrids) for the polygons in source.json.")
    ap.add_argument("--source", required=True, help="JSON saved by the map page")
    ap.add_argument("--out", default="soil_output", help="output folder")
    args = ap.parse_args()

    sites = [f["coords"] for f in json.loads(Path(args.source).read_text(encoding="utf-8"))["features"]]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    rows = []
    with ThreadPoolExecutor(len(PROPERTIES) * len(TOPSOIL)) as ex:      # 6 layers read at the same time
        # one reader per layer: it opens its layer once and reads every site from it
        all_jobs = [{(p, d): Future() for p in PROPERTIES for d in TOPSOIL} for _ in sites]
        for p in PROPERTIES:
            for d in TOPSOIL:
                ex.submit(read_layer, p, d, sites, [jobs[(p, d)] for jobs in all_jobs])
        for i, jobs in enumerate(all_jobs, 1):
            row = {"site": f"site{i}"}
            for p in PROPERTIES:
                vals = []
                for d, w in TOPSOIL.items():
                    try:
                        vals.append((jobs[(p, d)].result()[0], w))
                    except Exception as e:                   # one layer failing never stops the site
                        print(f"!! site{i} soil {p} {d}: {type(e).__name__}: {str(e)[:160]}", flush=True)
                vals = [(v, w) for v, w in vals if v is not None]           # skip layers without data
                row[f"{p}_pct"] = round(float(np.average([v for v, _ in vals], weights=[w for _, w in vals])), 1) \
                    if vals else None
            rows.append(row)
            print(f"site{i}: " + (f"clay {row['clay_pct']} %, sand {row['sand_pct']} % (0-30 cm)"
                                  if row["clay_pct"] is not None else "no data (water / urban / outside map)"))

    with open(out / "soil.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows({k: ("" if v is None else v) for k, v in r.items()} for r in rows)
    print(f"\nDone: {out / 'soil.csv'}")


if __name__ == "__main__":
    main()