#!/usr/bin/env python3
"""
Soil pH (in water) for the polygons in source.json -> one CSV.

    python soil_ph.py --source source.json
    python soil_ph.py --source source.json --out soil_ph_output

Data: ISRIC SoilGrids 2.0, 250 m grid, pH(H2O) at 0-5, 5-15 and 15-30 cm, combined into one
0-30 cm value (weighted by layer thickness), the same depth as the clay/sand of soil_data.py.

There is no time series of soil pH: no satellite measures it, and SoilGrids is a single map
(published 2020, built from soil profiles of many years). So the value is the same whatever the
end date - soil pH changes slowly (years to decades), so this is still the usual source.
A recent lab soil test of the field is always better, if the farmer has one.

How: the SoilGrids Cloud-Optimised GeoTIFFs are read directly over the internet (only the few
pixels under the polygon are downloaded). If that fails, the SoilGrids REST API is asked for the
polygon's centre point instead (that API is in beta and sometimes paused).

Output: soil_ph_output/soil_ph.csv -> site, ph_0_5cm, ph_5_15cm, ph_15_30cm,
        ph_0_30cm, ph_min, ph_max, pixels, source
        ph_min / ph_max = lowest / highest 0-30 cm pixel inside the polygon.

Needs: python -m pip install numpy rasterio
"""
import argparse
import csv
import json
import os
import time
import urllib.request
from pathlib import Path

import numpy as np

DEPTHS = [("0-5cm", 5), ("5-15cm", 10), ("15-30cm", 15)]          # (layer, thickness in cm)
VRT = "/vsicurl/https://files.isric.org/soilgrids/latest/data/phh2o/phh2o_{depth}_mean.vrt"
REST = ("https://rest.isric.org/soilgrids/v2.0/properties/query?lon={lon}&lat={lat}&property=phh2o"
        + "".join(f"&depth={d}" for d, _ in DEPTHS) + "&value=mean")

# GDAL over HTTP: don't list remote folders, retry short network errors
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "3")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "2")


def from_rasters(coords):
    """pH per depth for every 250 m pixel touching the polygon -> {depth: array}."""
    import rasterio
    from rasterio.features import geometry_mask, geometry_window
    from rasterio.warp import transform_geom

    ring = [list(p) for p in coords] + [list(coords[0])]
    geom = {"type": "Polygon", "coordinates": [ring]}
    layers = {}
    for depth, _ in DEPTHS:
        with rasterio.open(VRT.format(depth=depth)) as src:
            g = transform_geom("EPSG:4326", src.crs, geom)          # lon/lat -> SoilGrids Homolosine
            win = geometry_window(src, [g], pad_x=1, pad_y=1)
            data = src.read(1, window=win).astype(float)
            inside = geometry_mask([g], out_shape=data.shape, transform=src.window_transform(win),
                                   invert=True, all_touched=True)
            if src.nodata is not None:
                data[data == src.nodata] = np.nan
            data[data <= 0] = np.nan                                 # 0 = no data (water, built-up)
            layers[depth] = data[inside] / 10                        # stored as pH x 10
    return layers


def from_rest(coords):
    """pH per depth at the polygon's centre from the REST API -> {depth: array of 1 value}."""
    lon = sum(p[0] for p in coords) / len(coords)
    lat = sum(p[1] for p in coords) / len(coords)
    with urllib.request.urlopen(REST.format(lon=lon, lat=lat), timeout=60) as r:
        reply = json.load(r)
    layer = reply["properties"]["layers"][0]
    factor = layer.get("unit_measure", {}).get("d_factor", 10)
    layers = {}
    for d in layer["depths"]:
        v = d["values"].get("mean")
        layers[d["label"]] = np.array([v / factor if v is not None else np.nan])
    return layers


def summarise(layers):
    """Per-depth means plus the thickness-weighted 0-30 cm value per pixel."""
    total = sum(t for _, t in DEPTHS)
    combined = sum(layers[d] * t for d, t in DEPTHS) / total         # NaN where any layer is missing
    ok = combined[np.isfinite(combined)]
    row = {f"ph_{d.replace('-', '_')}": (round(float(np.nanmean(layers[d])), 2)
                                         if np.isfinite(layers[d]).any() else "")
           for d, _ in DEPTHS}
    row.update({"ph_0_30cm": round(float(ok.mean()), 2) if ok.size else "",
                "ph_min": round(float(ok.min()), 2) if ok.size else "",
                "ph_max": round(float(ok.max()), 2) if ok.size else "",
                "pixels": int(ok.size)})
    return row


def main():
    ap = argparse.ArgumentParser(description="SoilGrids soil pH for the polygons in source.json.")
    ap.add_argument("--source", required=True, help="JSON saved by the map page / build_dataset.py")
    ap.add_argument("--out", default="soil_ph_output", help="output folder")
    args, _ = ap.parse_known_args()                                  # ignore options meant for other scripts

    req = json.loads(Path(args.source).read_text(encoding="utf-8"))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    rows = []
    for i, f in enumerate(req["features"], 1):
        site, coords = f"site{i}", f["coords"]
        row, source = None, ""
        try:
            row, source = summarise(from_rasters(coords)), "SoilGrids 2.0 250 m (polygon)"
            if not row["pixels"]:
                raise ValueError("no valid pixel inside the polygon")
        except Exception as e:
            print(f"  {site}: SoilGrids maps failed ({type(e).__name__}: {str(e)[:150]}) - trying the REST API")
            for attempt in range(3):
                try:
                    row, source = summarise(from_rest(coords)), "SoilGrids 2.0 REST (centre point)"
                    break
                except Exception as e2:
                    print(f"  {site}: REST API failed ({type(e2).__name__}: {str(e2)[:150]})")
                    time.sleep(15)                                   # fair use: 5 calls per minute
        if row is None:
            row = {"ph_0_5cm": "", "ph_5_15cm": "", "ph_15_30cm": "", "ph_0_30cm": "",
                   "ph_min": "", "ph_max": "", "pixels": 0}
            source = "no data"
        rows.append({"site": site, **row, "source": source})
        print(f"{site}: pH {row['ph_0_30cm'] or '-'} (0-30 cm), range {row['ph_min'] or '-'}-{row['ph_max'] or '-'}, "
              f"{row['pixels']} pixel(s) [{source}]")

    with open(out / "soil_ph.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["site", "ph_0_5cm", "ph_5_15cm", "ph_15_30cm", "ph_0_30cm",
                                           "ph_min", "ph_max", "pixels", "source"])
        w.writeheader()
        w.writerows(rows)
    print(f"\nDone: {out / 'soil_ph.csv'}")


if __name__ == "__main__":
    main()