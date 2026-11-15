#!/usr/bin/env python3
"""
Step 1: add the extra salinity predictors to the existing dataset - no 15-hour rerun.

Every value comes from a point's coordinates only (TH_LAT / TH_LONG), so the SAME script
works later for new fields in the app: give it any CSV with POINTID, TH_LAT, TH_LONG.

    python extra_features.py --csv finished_dataset_v2.csv --out finished_dataset_v3.csv ^
        --project YOUR-GCP-PROJECT --raster EC_15_2018.tif:esdac_ec_2018

    optional, more local GeoTIFFs (e.g. the ESDAC CaCO3 map):
        --raster EC_15_2018.tif:esdac_ec_2018 CaCO3.tif:esdac_caco3

What is added
  1. coast      dist_coast_km              distance to the sea (Natural Earth 10 m coastline)
  2. gee        Google Earth Engine, one call per 500 points:
                sg_ph, sg_cec, sg_soc, sg_bdod, sg_cfvo, sg_clay, sg_sand   SoilGrids 2.0, 0-20 cm
                hand_m                     height above nearest drainage (MERIT Hydro)
                slope_deg                  slope (MERIT DEM)
                tpi_300m, tpi_1km          terrain position: + = ridge, - = hollow/valley
                clim_pr_mm, clim_pet_mm, clim_aet_mm, clim_def_mm,
                clim_tmax_c, clim_tmin_c, clim_soil_mm, clim_pdsi, clim_aridity
                                           TerraClimate 2009-2018 averages (yearly totals for mm)
                npp_kgc_m2                 net primary production, MODIS 2014-2018 mean
  3. rasters    any local GeoTIFF you list (ESDAC EC map, CaCO3 ...); negative values -> empty

Each part is saved in extra_features_cache/ as soon as it is done, so a second run only
redoes what is missing (delete a cache file to redo that part).

Needs: python -m pip install earthengine-api pandas numpy shapely pyproj rasterio requests
First time only: earthengine authenticate   (or the script opens the login itself)
"""
import argparse
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

CACHE = Path(__file__).resolve().parent / "extra_features_cache"
COAST_URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/"
             "geojson/ne_10m_coastline.geojson")
CHUNK = 500             # points per Earth Engine request
GEE_THREADS = 4         # requests at the same time


# ------------------------------------------------------------------ coast --
def coast_distance(df):
    import requests
    from pyproj import Transformer
    from shapely import STRtree, points
    from shapely.geometry import shape
    from shapely.ops import transform

    CACHE.mkdir(exist_ok=True)
    path = CACHE / "ne_10m_coastline.geojson"
    if not path.exists():
        print("  downloading Natural Earth coastline (~10 MB)...")
        r = requests.get(COAST_URL, timeout=120)
        r.raise_for_status()
        path.write_bytes(r.content)
    to_m = Transformer.from_crs(4326, 3035, always_xy=True).transform   # metres, Europe
    lines = [transform(to_m, shape(f["geometry"]))
             for f in json.loads(path.read_text(encoding="utf-8"))["features"]]
    tree = STRtree(lines)
    x, y = to_m(df.TH_LONG.values, df.TH_LAT.values)
    _, dist = tree.query_nearest(points(x, y), return_distance=True, all_matches=False)
    return pd.DataFrame({"POINTID": df.POINTID.values, "dist_coast_km": np.round(dist / 1000, 3)})


# -------------------------------------------------------------------- GEE --
def gee_image(ee):
    """All Earth Engine predictors as one multi-band image."""
    def sg(name, div):                                    # SoilGrids 0-20 cm weighted mean
        img = ee.Image(f"projects/soilgrids-isric/{name}_mean")
        p = f"{name}_"
        return (img.select(p + "0-5cm_mean").multiply(5)
                .add(img.select(p + "5-15cm_mean").multiply(10))
                .add(img.select(p + "15-30cm_mean").multiply(5))
                .divide(20).divide(div))

    soil = ee.Image.cat([
        sg("phh2o", 10).rename("sg_ph"),
        sg("cec", 10).rename("sg_cec"),        # cmol(c)/kg
        sg("soc", 10).rename("sg_soc"),        # g/kg
        sg("bdod", 100).rename("sg_bdod"),     # kg/dm3
        sg("cfvo", 10).rename("sg_cfvo"),      # vol %
        sg("clay", 10).rename("sg_clay"),      # %
        sg("sand", 10).rename("sg_sand"),      # %
    ])

    merit = ee.Image("MERIT/Hydro/v1_0_1")
    elv = merit.select("elv")
    tpi = lambda r: elv.subtract(elv.focalMean(r, "circle", "meters"))
    terrain = ee.Image.cat([
        merit.select("hnd").rename("hand_m"),
        ee.Terrain.slope(elv).rename("slope_deg"),
        tpi(300).rename("tpi_300m"),
        tpi(1000).rename("tpi_1km"),
    ])

    tc = ee.ImageCollection("IDAHO_EPSCOR/TERRACLIMATE").filterDate("2009-01-01", "2019-01-01").mean()
    pr = tc.select("pr").multiply(12)                     # mm/year
    pet = tc.select("pet").multiply(0.1 * 12)
    clim = ee.Image.cat([
        pr.rename("clim_pr_mm"),
        pet.rename("clim_pet_mm"),
        tc.select("aet").multiply(0.1 * 12).rename("clim_aet_mm"),
        tc.select("def").multiply(0.1 * 12).rename("clim_def_mm"),
        tc.select("tmmx").multiply(0.1).rename("clim_tmax_c"),
        tc.select("tmmn").multiply(0.1).rename("clim_tmin_c"),
        tc.select("soil").multiply(0.1).rename("clim_soil_mm"),
        tc.select("pdsi").multiply(0.01).rename("clim_pdsi"),
        pr.divide(pet.max(1)).rename("clim_aridity"),     # < 0.5 = semi-arid or drier
    ])

    npp = (ee.ImageCollection("MODIS/061/MOD17A3HGF").filterDate("2014-01-01", "2019-01-01")
           .select("Npp").mean().multiply(0.0001).rename("npp_kgc_m2"))

    return ee.Image.cat([soil, terrain, clim, npp])


def gee_features(df, project):
    import ee
    try:
        ee.Initialize(project=project)
    except Exception:
        ee.Authenticate()
        ee.Initialize(project=project)
    img = gee_image(ee)
    bands = img.bandNames().getInfo()
    print(f"  {len(bands)} bands: {', '.join(bands)}")

    def chunk(i):
        part = df.iloc[i:i + CHUNK]
        fc = ee.FeatureCollection([ee.Feature(ee.Geometry.Point([float(lon), float(lat)]), {"POINTID": str(pid)})
                                   for pid, lat, lon in zip(part.POINTID, part.TH_LAT, part.TH_LONG)])
        for attempt in range(3):
            try:
                res = img.reduceRegions(collection=fc, reducer=ee.Reducer.first(), scale=90,
                                        crs="EPSG:4326").getInfo()
                break
            except Exception as e:
                if attempt == 2:
                    raise
                print(f"   (points {i}-{i + len(part)}: {str(e)[:100]} - retrying)")
        rows = [{"POINTID": f["properties"]["POINTID"], **{b: f["properties"].get(b) for b in bands}}
                for f in res["features"]]
        print(f"  points {i + 1}-{i + len(part)} done")
        return rows

    with ThreadPoolExecutor(GEE_THREADS) as ex:
        rows = [r for part in ex.map(chunk, range(0, len(df), CHUNK)) for r in part]
    out = pd.DataFrame(rows, columns=["POINTID", *bands])
    out["POINTID"] = out.POINTID.astype(df.POINTID.dtype)
    return out


# --------------------------------------------------------------- rasters --
def raster_values(df, specs):
    import rasterio
    from pyproj import Transformer
    out = pd.DataFrame({"POINTID": df.POINTID.values})
    for spec in specs:
        path, _, name = spec.rpartition(":")
        if not path:                                      # no ":name" given -> file name
            path, name = spec, Path(spec).stem
        with rasterio.open(path) as src:
            x, y = Transformer.from_crs(4326, src.crs, always_xy=True).transform(df.TH_LONG.values, df.TH_LAT.values)
            v = np.array([s[0] for s in src.sample(zip(x, y))], dtype=float)
            if src.nodata is not None:
                v[v == src.nodata] = np.nan
        v[v < 0] = np.nan                                 # model artefacts (EC can't be negative)
        out[name] = v
        print(f"  {name}: {np.isnan(v).mean():.1%} empty, median {np.nanmedian(v):.3f}")
    return out


# ------------------------------------------------------------------ main --
def cached(name, fn, *a):
    CACHE.mkdir(exist_ok=True)
    path = CACHE / f"{name}.csv"
    if path.exists():
        print(f"[{name}] from cache ({path.name})")
        return pd.read_csv(path)
    print(f"[{name}]")
    part = fn(*a)
    part.to_csv(path, index=False)
    return part


def main():
    ap = argparse.ArgumentParser(description="Add salinity predictors to a CSV with POINTID, TH_LAT, TH_LONG.")
    ap.add_argument("--csv", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--project", help="Google Cloud project registered for Earth Engine")
    ap.add_argument("--raster", nargs="*", default=[], metavar="FILE.tif:column")
    ap.add_argument("--skip", nargs="*", default=[], choices=["coast", "gee", "rasters"])
    args = ap.parse_args()

    df = pd.read_csv(args.csv)
    print(f"{len(df):,} points from {args.csv}")
    parts = []
    if "coast" not in args.skip:
        parts.append(cached("coast", coast_distance, df))
    if "gee" not in args.skip:
        if not args.project:
            ap.error("--project is needed for Earth Engine (or use --skip gee)")
        parts.append(cached("gee", gee_features, df, args.project))
    if args.raster and "rasters" not in args.skip:
        parts.append(raster_values(df, args.raster))     # local and fast: never cached

    out = df
    for p in parts:
        p = p.drop_duplicates("POINTID")
        p["POINTID"] = p.POINTID.astype(df.POINTID.dtype)
        out = out.merge(p, on="POINTID", how="left", suffixes=("", "_new"))
    out.to_csv(args.out, index=False)

    new = [c for c in out.columns if c not in df.columns]
    print(f"\nSaved {args.out}: {len(out):,} rows, {len(new)} new columns")
    print(out[new].describe().T[["count", "mean", "min", "max"]].round(3).to_string())


if __name__ == "__main__":
    main()