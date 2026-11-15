#!/usr/bin/env python3
"""
Salinity -> expected yield of every crop in the crop workbook.

    from crops import load_crop_limits, crop_table
    crops = load_crop_limits("data/Crop_water_salinity_limits_cropshift_v4.xlsx")
    rows  = crop_table(crops, ec15_low=0.12, ec15_mid=0.18, ec15_high=0.30, clay_pct=28, soil_ph=7.4)

Steps
  1. EC1:5 (what LUCAS measures and the model predicts) -> ECe (what the crop limits use).
     There is no universal factor (Zarif et al. 2026: roughly 5-12 x, depending on soil), so:
       * texture factor from clay %  (sandy soils get the highest factor)
       * limestone soils (pH >= 7.5): about 0.2 dS/m of the reading is dissolved lime that is the
         same at any dilution, so only the part above it is multiplied
       * likely gypsum (pH >= 7.5 and EC1:5 >= 1.5 dS/m): FAO 29 notes that crops tolerate about
         2 dS/m more ECe in gypsum soils, so 2 dS/m is taken off
  2. FAO yield formula: yield % = 100 - b x (ECe - a), with a = ECe at 100 % yield and
     b = 50 / (ECe at 50 % - a), both from the workbook's Summary sheet.
  3. Verdict per crop, using the model's range:
       safe          yield >= 90 % even at the HIGH end of the salinity range
       not suitable  yield < 75 % already at the MOST LIKELY salinity
       risky         everything in between -> a soil test is worth it
"""
import math

import pandas as pd

LIME_PH = 7.5            # pH from which a soil is treated as calcareous
LIME_BASE = 0.2          # dS/m of EC1:5 explained by dissolved lime (Zarif et al. 2026: ~0.2, up to 0.5)
GYPSUM_EC15 = 1.5        # dS/m EC1:5 from which a calcareous soil is flagged as likely gypsum
GYPSUM_BONUS = 2.0       # dS/m extra ECe tolerated in gypsum soils (FAO 29)
SAFE_YIELD, UNSUITABLE_YIELD = 90, 75


# ------------------------------------------------------------- workbook --
def _num(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def load_crop_limits(path):
    """Crop list from crops.json (preferred) or the workbook's Summary sheet (.xlsx)."""
    if str(path).lower().endswith(".json"):
        return _from_json(path)
    return _from_xlsx(path)


def _from_json(path):
    """crops.json: [{"name", "season", "ECe_full_yield", "ECe_half_yield", "ECe_slope",
    "pH_min", "pH_max", "pc_opt_min" / "pH_opt_min", "pc_opt_max" / "pH_opt_max", ...}, ...]"""
    import json
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    crops = []
    for c in data:
        a, half, slope = _num(c.get("ECe_full_yield")), _num(c.get("ECe_half_yield")), _num(c.get("ECe_slope"))
        if slope is None and a is not None and half is not None and half > a:
            slope = round(50 / (half - a), 3)                      # from the 50 % point if no slope given
        crops.append({
            "crop": str(c["name"]).strip(),
            "season": c.get("season", ""),
            "ece_100": a,
            "slope": slope,
            "ph_min": _num(c.get("pH_min")),
            "ph_max": _num(c.get("pH_max")),
            "ph_opt_min": _num(c.get("pH_opt_min", c.get("pc_opt_min"))),
            "ph_opt_max": _num(c.get("pH_opt_max", c.get("pc_opt_max"))),
        })
    return crops


def _from_xlsx(xlsx_path):
    """Crop list from the workbook's Summary sheet (header on row 4). Needs openpyxl."""
    s = pd.read_excel(xlsx_path, sheet_name="Summary", header=3)
    crops = []
    for _, r in s.iterrows():
        name = r.get("Crop")
        if not isinstance(name, str) or len(name) > 60:           # skip blank and note rows
            continue
        a, e50 = _num(r.get("Soil ECe at 100% yield (dS/m)")), _num(r.get("Soil ECe at 50% yield (dS/m)"))
        crops.append({
            "crop": name.strip(),
            "season": str(r.get("Crop-shift group", "") or ""),
            "ece_100": a,                                          # ECe at full yield
            "slope": round(50 / (e50 - a), 3) if a is not None and e50 is not None and e50 > a else None,
            "tolerance_class": str(r.get("Salt tolerance class, FAO 29", "") or ""),
            "ph_min": _num(r.get("Soil pH absolute min")),
            "ph_max": _num(r.get("Soil pH absolute max")),
        })
    return crops


# ------------------------------------------------------------ conversion --
def texture_factor(clay_pct):
    """ECe / EC1:5 by texture (typical published values; sandy soils have the largest factor)."""
    if clay_pct is None or not math.isfinite(clay_pct):
        clay_pct = 28.0                                            # dataset median
    if clay_pct < 10:
        return 14.0
    if clay_pct < 20:
        return 9.5
    if clay_pct < 35:
        return 8.6
    return 7.5


def soil_flags(ec15_mid, soil_ph):
    calcareous = soil_ph is not None and math.isfinite(soil_ph) and soil_ph >= LIME_PH
    gypsum = calcareous and ec15_mid >= GYPSUM_EC15
    return {"calcareous": bool(calcareous), "likely_gypsum": bool(gypsum)}


def ec15_to_ece(ec15, clay_pct, soil_ph, gypsum=False):
    """EC1:5 (dS/m) -> effective ECe (dS/m) for the crop limits."""
    f = texture_factor(clay_pct)
    if soil_ph is not None and math.isfinite(soil_ph) and soil_ph >= LIME_PH:
        base = min(ec15, LIME_BASE)
        ece = base + f * max(ec15 - LIME_BASE, 0.0)
    else:
        ece = f * ec15
    if gypsum:
        ece = max(ece - GYPSUM_BONUS, 0.0)
    return ece


def salinity_class(ece):
    """FAO-style soil salinity class from ECe (dS/m)."""
    if ece < 2:
        return "non-saline"
    if ece < 4:
        return "slightly saline"
    if ece < 8:
        return "moderately saline"
    if ece < 16:
        return "strongly saline"
    return "very strongly saline"


def ph_status(soil_ph, c):
    """'optimal', 'tolerated', 'outside' (crop's absolute range) or None if unknown."""
    if soil_ph is None or not math.isfinite(soil_ph) or c.get("ph_min") is None or c.get("ph_max") is None:
        return None
    if not c["ph_min"] <= soil_ph <= c["ph_max"]:
        return "outside"
    lo, hi = c.get("ph_opt_min"), c.get("ph_opt_max")
    if lo is not None and hi is not None and lo <= soil_ph <= hi:
        return "optimal"
    return "tolerated"


# ----------------------------------------------------------------- yield --
def yield_pct(ece, a, b):
    return max(0.0, min(100.0, 100.0 - b * max(ece - a, 0.0)))


def crop_table(crops, ec15_low=None, ec15_mid=None, ec15_high=None, clay_pct=None, soil_ph=None, ece=None):
    """One row per crop: expected yield (most likely salinity), best / worst case, verdict.
    ec15_* are EC1:5 in dS/m (low / most likely / high end of the range).
    ece=(low, mid, high) in dS/m skips the conversion (e.g. a lab ECe measurement)."""
    if ece is not None:
        flags = {"calcareous": None, "likely_gypsum": None}
        ece = dict(zip(("low", "mid", "high"), ece))
    else:
        flags = soil_flags(ec15_mid, soil_ph)
        ece = {k: ec15_to_ece(v, clay_pct, soil_ph, flags["likely_gypsum"])
               for k, v in (("low", ec15_low), ("mid", ec15_mid), ("high", ec15_high))}
    rows = []
    for c in crops:
        row = {"crop": c["crop"], "season": c.get("season", ""),
               "salt_limit_ece": c["ece_100"], "yield_loss_per_dS_m": c["slope"]}
        if c["ece_100"] is None or c["slope"] is None:
            row.update(yield_expected=None, yield_best=None, yield_worst=None,
                       verdict="no salinity data")
        else:
            y_mid = yield_pct(ece["mid"], c["ece_100"], c["slope"])
            y_low = yield_pct(ece["low"], c["ece_100"], c["slope"])
            y_high = yield_pct(ece["high"], c["ece_100"], c["slope"])
            verdict = ("safe" if y_high >= SAFE_YIELD else
                       "not suitable" if y_mid < UNSUITABLE_YIELD else "risky")
            row.update(yield_expected=round(y_mid, 1), yield_best=round(y_low, 1),
                       yield_worst=round(y_high, 1), verdict=verdict)
        row["soil_ph"] = ph_status(soil_ph, c)
        rows.append(row)
    order = {"safe": 0, "risky": 1, "not suitable": 2, "no salinity data": 3}
    rows.sort(key=lambda r: (order[r["verdict"]], -(r["yield_expected"] or 0)))
    return {"ece_low": round(ece["low"], 2), "ece_mid": round(ece["mid"], 2), "ece_high": round(ece["high"], 2),
            "salinity_class": salinity_class(ece["mid"]), **flags, "crops": rows}