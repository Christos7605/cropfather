#!/usr/bin/env python3
"""
Train and test the salinity model, then save it for predict.py.

    python train.py
    python train.py --data data/finished_dataset_v5.csv --crops data/crops.json

Two models are trained:
  full    every feature (needs the 90-day weather / 60-day satellite data before the date)
  static  soil, terrain, 10-year climate, distance to the sea only (any date, fast)

Testing is SPATIAL: the map is cut into 1 x 1 degree squares and whole squares are held out,
so every score is for places the model has never seen (the honest number for a new field).

Output
  models/salinity_model.joblib    both models + crop limits, loaded by predict.py
  models/training_report.txt      the scores below, kept with the model

Needs: python -m pip install pandas numpy scikit-learn joblib   (+ openpyxl only for an .xlsx crop list)
"""
import argparse
import datetime as dt
import platform
import time
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.metrics import average_precision_score, r2_score, roc_auc_score

import salinity_model as sm
from crops import crop_table, load_crop_limits

HERE = Path(__file__).resolve().parent.parent
DEFAULT_DATA = HERE / "model_data" / "finished_dataset_v5.csv"
DEFAULT_CROPS = HERE / "model_data" / "crops.json"
MODEL_DIR = HERE / "salinity/models"
FOLDS = 5
COAST_KM = 20                   # "coastal" in the report
FULL_MODEL_MONTHS = list(range(4, 11))   # April-October: the season the LUCAS samples were taken in
                                         # (outside it predict.py uses the static model)


def spatial_folds(df, seed=0):
    block = (np.floor(df.latitude).astype(int).astype(str) + "_" +
             np.floor(df.longitude).astype(int).astype(str)).values
    names = np.unique(block)
    rng = np.random.default_rng(seed)
    fold_of = dict(zip(names, rng.permutation(len(names)) % FOLDS))      # equal number of squares per fold
    return np.array([fold_of[b] for b in block])


def verdict_check(crops, df, pred):
    """Per crop: how often the app's verdict from the PREDICTED range agrees with the verdict
    from the MEASURED value (both through the same EC1:5 -> ECe conversion)."""
    ec_true = df[sm.TARGET].values / 100
    lo, mid, hi = (np.exp(pred[k]) / 100 for k in ("low", "mid", "high"))
    clay, ph = df.soil_clay_pct.values, df.soil_ph.values
    stats = {}
    for i in range(len(df)):
        t = {r["crop"]: r for r in crop_table(crops, ec_true[i], ec_true[i], ec_true[i], clay[i], ph[i])["crops"]}
        p = crop_table(crops, lo[i], mid[i], hi[i], clay[i], ph[i])["crops"]
        for r in p:
            if r["verdict"] == "no salinity data":
                continue
            s = stats.setdefault(r["crop"], {"limit": r["salt_limit_ece"], "n": 0, "truly_hurt": 0,
                                             "flagged_when_hurt": 0, "called_safe_when_hurt": 0,
                                             "flagged_when_fine": 0})
            hurt = t[r["crop"]]["verdict"] != "safe"          # measured salinity costs >10 % yield
            s["n"] += 1
            s["truly_hurt"] += hurt
            s["flagged_when_hurt"] += hurt and r["verdict"] != "safe"
            s["called_safe_when_hurt"] += hurt and r["verdict"] == "safe"
            s["flagged_when_fine"] += (not hurt) and r["verdict"] != "safe"
    rows = []
    for crop, s in stats.items():
        fine = s["n"] - s["truly_hurt"]
        rows.append({"crop": crop, "limit_ECe": s["limit"],
                     "fields_hurt_%": round(100 * s["truly_hurt"] / s["n"], 1),
                     "caught_%": round(100 * s["flagged_when_hurt"] / s["truly_hurt"], 1) if s["truly_hurt"] else None,
                     "missed (called safe)": s["called_safe_when_hurt"],
                     "false_alarm_%": round(100 * s["flagged_when_fine"] / fine, 1) if fine else None})
    return pd.DataFrame(rows).sort_values("limit_ECe")


def evaluate(name, df, feats, crops, folds):
    X, y = df[feats], np.log(df[sm.TARGET].values)
    elevated = (df[sm.TARGET].values > sm.ELEVATED_MS).astype(int)
    oof = {k: np.zeros(len(df)) for k in ("mid", "low", "high", "prob_elevated")}
    for k in range(FOLDS):
        tr, te = folds != k, folds == k
        m = sm.fit(X[tr], y[tr], elevated[tr])
        p = sm.predict(m, X[te])
        for key in oof:
            oof[key][te] = p[key]
        print(f"  [{name}] fold {k + 1}/{FOLDS} done", flush=True)

    # range widening, checked honestly: each fold is widened by what the OTHER folds needed
    scores = sm.conformity(y, oof["low"], oof["high"])
    raw_cov = float(np.mean(scores <= 0))
    inside = np.zeros(len(df), bool)
    for k in range(FOLDS):
        q = sm.conformal_margin(scores[folds != k])
        inside[folds == k] = scores[folds == k] <= q
    margin = sm.conformal_margin(scores)
    cal = {"mid": oof["mid"], "low": oof["low"] - margin, "high": oof["high"] + margin}

    coast = df.distance_to_coast_km.values <= COAST_KM
    ratio = np.exp(np.abs(y - oof["mid"]))
    metrics = {
        "R2 (log EC), all": r2_score(y, oof["mid"]),
        f"R2 (log EC), fields <= {COAST_KM} km from the sea (n={coast.sum()})": r2_score(y[coast], oof["mid"][coast]),
        "typical error (median factor, 1.25 = 25 % off)": float(np.median(ratio)),
        "AUC elevated (EC1:5 > 0.6 dS/m)": roc_auc_score(elevated, oof["prob_elevated"]),
        "PR-AUC elevated (base rate %.3f)" % elevated.mean(): average_precision_score(elevated, oof["prob_elevated"]),
        f"AUC elevated, <= {COAST_KM} km from the sea": (roc_auc_score(elevated[coast], oof["prob_elevated"][coast])
                                                         if elevated[coast].min() != elevated[coast].max() else float("nan")),
        "80% range: coverage before widening": raw_cov,
        "80% range: coverage after widening (held-out)": float(inside.mean()),
        "80% range: typical width (high / low)": float(np.median(np.exp(cal["high"] - cal["low"]))),
    }
    checks = verdict_check(crops, df, cal) if crops else None
    return metrics, margin, checks


def main():
    ap = argparse.ArgumentParser(description="Train the salinity model.")
    ap.add_argument("--data", default=str(DEFAULT_DATA))
    ap.add_argument("--crops", default=str(DEFAULT_CROPS))
    ap.add_argument("--out", default=str(MODEL_DIR / "salinity_model.joblib"))
    ap.add_argument("--no-cv", action="store_true", help="skip testing, only train the final models")
    args = ap.parse_args()
    t0 = time.time()

    df = pd.read_csv(args.data)
    df = df[df.sample_depth == "0-20 cm"].reset_index(drop=True)       # one depth only
    df = df[df[sm.TARGET] > 0].reset_index(drop=True)
    sets = sm.feature_sets(df.columns)
    print(f"{len(df):,} points | full model {len(sets['full'])} features | static model {len(sets['static'])} features")

    crops = None
    if Path(args.crops).exists():
        crops = load_crop_limits(args.crops)
        print(f"{len(crops)} crops from {Path(args.crops).name}")
    else:
        print(f"!! crop workbook not found at {args.crops}: no crop check, and predict.py will have no crops")

    folds = spatial_folds(df)
    y = np.log(df[sm.TARGET].values)
    elevated = (df[sm.TARGET].values > sm.ELEVATED_MS).astype(int)
    bundle = {"created": dt.datetime.now().isoformat(timespec="seconds"),
              "sklearn_version": sklearn.__version__, "python": platform.python_version(),
              "n_points": len(df), "elevated_mS_per_m": sm.ELEVATED_MS,
              "full_model_months": FULL_MODEL_MONTHS, "crops": crops,
              "training_area": {"lat": [float(df.latitude.min()), float(df.latitude.max())],
                                "lon": [float(df.longitude.min()), float(df.longitude.max())]},
              "models": {}}
    report = [f"Salinity model - trained {bundle['created']} on {len(df):,} LUCAS 2018 points",
              "All scores: spatial cross-validation (whole 1x1 degree squares held out).", ""]

    for name in ("full", "static"):
        feats = sets[name]
        margin, metrics, checks = 0.0, {}, None
        if not args.no_cv:
            print(f"\nTesting the {name} model ({FOLDS} folds)...")
            metrics, margin, checks = evaluate(name, df, feats, crops, folds)
        print(f"Training the final {name} model on all points...")
        models = sm.fit(df[feats], y, elevated)
        bundle["models"][name] = {"features": feats, "models": models, "conformal": margin, "cv": metrics}

        report += [f"=== {name.upper()} model ({len(feats)} features) ==="]
        report += [f"  {k:<62}{v:.3f}" for k, v in metrics.items()]
        if checks is not None:
            report += ["", "  Crop verdicts vs. measured salinity (hurt = measured salinity costs > 10 % yield):",
                       "  " + checks.to_string(index=False).replace("\n", "\n  ")]
        report += [""]

    importance = permutation_note(bundle["models"]["full"]["models"]["hgb"], df[sets["full"]], y)
    report += ["Most useful features (full model, permutation importance on the training data):"] + importance

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, out, compress=3)
    (out.parent / "training_report.txt").write_text("\n".join(report) + "\n", encoding="utf-8")
    print("\n" + "\n".join(report))
    print(f"Saved {out} ({out.stat().st_size / 1e6:.1f} MB) and training_report.txt in {time.time() - t0:.0f}s")


def permutation_note(model, X, y, top=12):
    from sklearn.inspection import permutation_importance
    r = permutation_importance(model, X, y, n_repeats=3, random_state=0, scoring="r2", n_jobs=-1)
    s = pd.Series(r.importances_mean, index=X.columns).sort_values(ascending=False).head(top)
    return [f"  {k:<45}{v:.3f}" for k, v in s.items()]


if __name__ == "__main__":
    main()