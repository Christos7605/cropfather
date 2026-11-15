#!/usr/bin/env python3
"""
Salinity + crop yield verdicts for the fields a farmer draws.

From another file:
    from predict import predict_field
    result = predict_field(request)                       # request = dict or path to the JSON
    result = predict_field(request, measured={"value": 3.2, "unit": "ECe"})   # lab result wins

From the command line:
    python predict.py request.json
    python predict.py request.json --project my-gee-project --out result.json

Request (as the map page saves it):
    {"features": [{"coords": [[lon, lat], ...]}, ...], "start": "2025-11-01", "end": "2025-11-30",
     "max_cloud": 15}

What happens, per request (several fields are processed together):
  1. The model is chosen from the END date: April-October -> "full" model (uses the 90 days of
     weather and 60 days of satellite data before the end date, like the training points);
     other months -> "static" model (soil, terrain, 10-year climate only), because the LUCAS
     samples were never taken in winter. Too much missing satellite/weather data -> static.
  2. backend/Data/all_data.py collects the field data exactly as for the training points
     (static model: only elevation + soil, which takes seconds).
  3. extra_features.py adds distance to the sea, SoilGrids, terrain, climate and plant growth
     for the field's centre (Google Earth Engine).
  4. The model gives EC1:5 as a range (low / most likely / high, 80 % range) and the chance
     that the field is elevated (> 0.6 dS/m).
  5. crops.py turns that into expected yield and a verdict for every crop.

Settings: Earth Engine project from --project, gee_project=..., or the SALINITY_GEE_PROJECT
environment variable.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import date as Date
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import salinity_model as sm  # noqa: E402
from crops import crop_table  # noqa: E402
from rename_columns import RENAME  # noqa: E402

MODEL_PATH = HERE / "models" / "salinity_model.joblib"
MAX_MISSING_WINDOW = 0.5        # full model only if at least half of its 90/60-day features arrived
STATIC_SCRIPTS = ["elevation", "soil"]
TO_NEW = {old: new for old, (new, _) in RENAME.items()}

_BUNDLE = None


# ----------------------------------------------------------------- setup --
def load_bundle(path=MODEL_PATH):
    global _BUNDLE
    if _BUNDLE is None:
        if not Path(path).exists():
            raise FileNotFoundError(f"{path} not found - run train.py first")
        _BUNDLE = joblib.load(path)
    return _BUNDLE


def find_data_dir():
    """backend/Data (with all_data.py), searched upwards from this folder."""
    env = os.environ.get("SALINITY_DATA_DIR")
    candidates = [Path(env)] if env else []
    for parent in HERE.parents:
        candidates += [parent / "Data", parent / "data"]
    for c in candidates:
        if (c / "all_data.py").exists():
            return c
    raise FileNotFoundError("all_data.py not found (set SALINITY_DATA_DIR to the backend/Data folder)")


def parse_date(s):
    return Date.fromisoformat(str(s)[:10])


# ------------------------------------------------------------ data steps --
def window_features(request, only=None, log=print):
    """Run all_data.py once for every field of the request (windows END on the request's end date,
    exactly like the training points ended on their sampling date). Returns one dict per field."""
    data_dir = find_data_dir()
    end = parse_date(request["end"]).isoformat()
    source = {"features": [{"coords": f["coords"], "id": f"field{i + 1}", "date": end}
                           for i, f in enumerate(request["features"])],
              "start": request.get("start", end), "end": end,
              "max_cloud": request.get("max_cloud", 20)}
    tmp = Path(tempfile.mkdtemp(prefix="salinity_"))
    try:
        (tmp / "source.json").write_text(json.dumps(source), encoding="utf-8")
        cmd = [sys.executable, str(data_dir / "all_data.py"), "--source", str(tmp / "source.json"),
               "--out", str(tmp / "out")] + (["--only", *only] if only else [])
        log(f"Collecting field data ({'only ' + ', '.join(only) if only else 'all scripts'})...")
        proc = subprocess.run(cmd, cwd=data_dir, stdin=subprocess.DEVNULL, capture_output=True,
                              text=True, encoding="utf-8", errors="replace")
        result = tmp / "out" / "all_data.csv"
        if not result.exists():
            raise RuntimeError(f"all_data.py produced no result (exit {proc.returncode}):\n{proc.stdout[-2000:]}")
        rows = pd.read_csv(result).set_index("site")
        problems = [l.strip() for l in proc.stdout.splitlines() if l.startswith("!!")]
        return [rows.loc[f"site{i + 1}"].to_dict() if f"site{i + 1}" in rows.index else {}
                for i in range(len(request["features"]))], problems
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def extra(lat, lon, gee_project, log=print):
    """Distance to the sea + Earth Engine features for the field centres (no cache: always fresh)."""
    import extra_features as ef
    pts = pd.DataFrame({"POINTID": range(len(lat)), "TH_LAT": lat, "TH_LONG": lon})
    log("Distance to the sea...")
    out = ef.coast_distance(pts)
    log("Earth Engine features (soil, terrain, climate, plant growth)...")
    out = out.merge(ef.gee_features(pts, gee_project), on="POINTID", how="left")
    return out.drop(columns="POINTID").to_dict("records")


# ------------------------------------------------------------ prediction --
def choose_model(bundle, end, requested):
    if requested in ("full", "static"):
        return requested, f"{requested} model (asked for)"
    if end.month in bundle["full_model_months"]:
        return "full", "full model (end date in the April-October sampling season)"
    return "static", "static model (end date outside the April-October season the training samples come from)"


def to_feature_row(raw, feats):
    renamed = {TO_NEW.get(k, k): v for k, v in raw.items()}
    row = {f: pd.to_numeric(renamed.get(f), errors="coerce") for f in feats}
    return pd.DataFrame([row], columns=feats).astype(float)


def model_range(bundle, name, X):
    part = bundle["models"][name]
    p = sm.predict(part["models"], X, part["conformal"])
    ms = {k: float(np.exp(p[k][0])) for k in ("low", "mid", "high")}          # mS/m
    return {k: v / 100 for k, v in ms.items()}, float(p["prob_elevated"][0])   # dS/m


def measured_range(measured):
    """A lab / meter value replaces the model. Units: 'ECe' (dS/m), 'EC1:5' (dS/m), 'EC1:5_mS_m'."""
    v, unit = float(measured["value"]), measured.get("unit", "ECe")
    spread = float(measured.get("uncertainty", 0.10))                       # +-10 % by default
    if unit == "EC1:5_mS_m":
        v, unit = v / 100, "EC1:5"
    rng = (v * (1 - spread), v, v * (1 + spread))
    return unit, rng


def predict_field(request, gee_project=None, model="auto", measured=None, include_features=False,
                  model_path=MODEL_PATH, verbose=True):
    """Salinity range and crop verdicts for every field in the request.

    request   dict or path to the JSON (features[].coords, end, optional start / max_cloud)
    model     "auto" (by end date), "full" or "static"
    measured  optional {"value": 3.2, "unit": "ECe" | "EC1:5" | "EC1:5_mS_m"} - a soil test of
              the field; it replaces the model for every field of the request
    Returns {"model": ..., "fields": [ {...}, ... ]}
    """
    log = print if verbose else (lambda *a, **k: None)
    if not isinstance(request, dict):
        request = json.loads(Path(request).read_text(encoding="utf-8"))
    bundle = load_bundle(model_path)
    end = parse_date(request["end"])
    fields = request["features"]
    lon = [float(np.mean([p[0] for p in f["coords"]])) for f in fields]     # same centre as all_data.py
    lat = [float(np.mean([p[1] for p in f["coords"]])) for f in fields]
    name, why = choose_model(bundle, end, model)
    log(f"{len(fields)} field(s), end date {end}: {why}")

    gee_project = gee_project or os.environ.get("SALINITY_GEE_PROJECT")
    if not gee_project:
        raise ValueError("Earth Engine project needed: gee_project=... or SALINITY_GEE_PROJECT")

    notes_all = []
    raw, problems = window_features(request, None if name == "full" else STATIC_SCRIPTS, log)
    notes_all += [f"data script: {p}" for p in problems[:5]]
    extras = extra(lat, lon, gee_project, log)

    results = []
    for i, f in enumerate(fields):
        notes = list(notes_all)
        this = name
        features = {**raw[i], **extras[i]}
        X = to_feature_row(features, bundle["models"][this]["features"])
        if this == "full":
            window = [c for c in X.columns if any(t in c for t in sm.WINDOW_TAGS)]
            missing = float(X[window].isna().mean().mean())
            if missing > MAX_MISSING_WINDOW:
                this = "static"
                notes.append(f"{missing:.0%} of the weather/satellite data was missing: static model used")
                X = to_feature_row(features, bundle["models"][this]["features"])
        n_missing = int(X.isna().sum().sum())
        if n_missing:
            notes.append(f"{n_missing} of {X.shape[1]} inputs missing (the model works around them)")

        row = X.iloc[0]
        clay, ph = row.get("soil_clay_pct"), row.get("soil_ph")
        area = bundle["training_area"]
        if not (area["lat"][0] <= lat[i] <= area["lat"][1] and area["lon"][0] <= lon[i] <= area["lon"][1]):
            notes.append("field is outside the area the model was trained on (southern Europe): use with care")

        if measured:
            unit, rng = measured_range(measured)
            used = "soil test"
            prob = None
            if unit == "ECe":
                table = crop_table(bundle["crops"] or [], ece=rng)
                ec15 = None
            else:
                ec15 = dict(zip(("low", "mid", "high"), rng))
                table = crop_table(bundle["crops"] or [], *rng, clay_pct=clay, soil_ph=ph)
        else:
            ec15, prob = model_range(bundle, this, X)
            used = f"{this} model"
            table = crop_table(bundle["crops"] or [], ec15["low"], ec15["mid"], ec15["high"],
                               clay_pct=clay, soil_ph=ph)

        dist = row.get("distance_to_coast_km")
        if table.get("likely_gypsum"):
            notes.append("likely gypsum soil: part of the reading is gypsum, which crops tolerate better "
                         "(2 dS/m taken off, FAO 29)")
        elif table.get("calcareous"):
            notes.append("limestone (calcareous) soil: about 0.2 dS/m of the reading is dissolved lime, not salt")
        if prob is not None and prob >= 0.5:
            notes.append(f"HIGH chance ({prob:.0%}) that this field is saline (EC1:5 > 0.6 dS/m). The model "
                         "underestimates very salty fields, so the real value may be well above the range: "
                         "treat the 'safe' verdicts of sensitive crops with caution and get a soil test")
        elif prob is not None and prob >= 0.2:
            notes.append(f"raised chance ({prob:.0%}) that this field is saline (EC1:5 > 0.6 dS/m)")
        risky = [r["crop"] for r in table["crops"] if r["verdict"] == "risky"]
        if not measured and (risky or (prob or 0) > 0.2 or (dist is not None and dist <= 5)):
            notes.append("a soil salinity test (ECe) would settle the risky crops - pass it as measured=...")

        results.append({
            "field": i + 1,
            "centre": {"lon": round(lon[i], 6), "lat": round(lat[i], 6)},
            "end_date": end.isoformat(),
            "salinity_from": used,
            "salinity": {
                "ec_1to5_dS_m": None if ec15 is None else {k: round(v, 3) for k, v in
                                                           zip(("low", "most_likely", "high"),
                                                               (ec15["low"], ec15["mid"], ec15["high"]))},
                "ece_dS_m": {"low": table["ece_low"], "most_likely": table["ece_mid"], "high": table["ece_high"]},
                "class": table["salinity_class"],
                "chance_elevated": None if prob is None else round(prob, 3),
                "calcareous_soil": table.get("calcareous"),
                "likely_gypsum": table.get("likely_gypsum"),
                "distance_to_coast_km": None if dist is None or pd.isna(dist) else round(float(dist), 2),
            },
            "crops": table["crops"],
            "notes": notes,
            **({"features": {k: (None if pd.isna(v) else float(v)) for k, v in row.items()}}
               if include_features else {}),
        })
    return {"model_trained": bundle["created"], "fields": results}


# ------------------------------------------------------------------- CLI --
def print_result(result):
    for f in result["fields"]:
        s = f["salinity"]
        print(f"\n=== Field {f['field']} ({f['centre']['lat']}, {f['centre']['lon']}) - {f['salinity_from']} ===")
        if s["ec_1to5_dS_m"]:
            e = s["ec_1to5_dS_m"]
            print(f"EC1:5 {e['low']}-{e['high']} dS/m (most likely {e['most_likely']}), "
                  f"chance elevated {s['chance_elevated']:.0%}")
        e = s["ece_dS_m"]
        print(f"ECe   {e['low']}-{e['high']} dS/m (most likely {e['most_likely']}) -> {s['class']}")
        print(f"\n{'crop':<38}{'verdict':<16}{'yield %':>8}{'worst %':>9}")
        for r in f["crops"]:
            y = "-" if r["yield_expected"] is None else f"{r['yield_expected']:.0f}"
            w = "-" if r["yield_worst"] is None else f"{r['yield_worst']:.0f}"
            print(f"{r['crop'][:37]:<38}{r['verdict']:<16}{y:>8}{w:>9}")
        for n in f["notes"]:
            print(f"  * {n}")


def main():
    ap = argparse.ArgumentParser(description="Salinity and crop verdicts for a request JSON.")
    ap.add_argument("request")
    ap.add_argument("--project", help="Google Earth Engine project (else SALINITY_GEE_PROJECT)")
    ap.add_argument("--model", default="auto", choices=["auto", "full", "static"])
    ap.add_argument("--measured", type=float, help="a measured ECe in dS/m (soil test)")
    ap.add_argument("--out", help="also save the full result as JSON")
    args = ap.parse_args()
    result = predict_field(args.request, gee_project=args.project, model=args.model,
                           measured={"value": args.measured, "unit": "ECe"} if args.measured else None)
    print_result(result)
    if args.out:
        Path(args.out).write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"\nSaved {args.out}")


if __name__ == "__main__":
    main()
