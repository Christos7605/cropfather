import argparse
import json
import sys
from pathlib import Path

from all_field_data import get_field_data

# File Paths
CROPS_PATH = Path(__file__).parent / "model_data/crops.json"
DEMO_FIELD = Path(__file__).parent / "model_data/website_data/field-coords.json"            # coords + date
DEMO_GENERAL_INFO = Path(__file__).parent / "model_data/website_data/general-info.json"     # farm questionnaire
DEMO_FIELD_INFO = Path(__file__).parent / "model_data/website_data/field-info.json"         # field questionnaire
DEMO_SEASONS = Path(__file__).parent / "model_data/website_data/farmer-seasons.json"        # crop history
SALINITY_DIR = Path(__file__).resolve().parent / "salinity"
sys.path.insert(0, str(SALINITY_DIR))

from predict import predict_field
from scoring import build_recommendations      # the scoring model (scoring.py + model_data/crop_profiles.json)

#---------------------------------------------------------------------------------------------#
#                                       DATA ANALYSIS                                         #
#---------------------------------------------------------------------------------------------#

# Helper function to load Json files
def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


#------------------------------------------------------#  
#                  Load Crop Data                      #
#------------------------------------------------------# 

def load_crops(path=CROPS_PATH):
    """Return a dict of crops keyed by crop name, e.g. crops["Barley"]["ECe_full_yield"]."""
    return {crop["name"]: crop for crop in load_json(path)}

def slope_func(slope, percentage, full_yield):
    return  (100 - percentage) / slope + full_yield

#------------------------------------------------------#  
#                 Load Farmer Data                     #
#------------------------------------------------------# 

def load_farmer(general_path=DEMO_GENERAL_INFO, field_path=DEMO_FIELD_INFO, seasons_path=DEMO_SEASONS):
    """Keep only what pruning needs: excluded crops (farm questionnaire) and max cycle days (field
    questionnaire). The crop history and all answers are kept too, for the scoring."""
    general = load_json(general_path)["answers"]
    field_answers = load_json(field_path)["answers"]
    return {
        "excluded_crops": [c for c in general.get("excludedCrops", []) if c != "none"],   # ["none"] = no exclusions
        "max_days": field_answers.get("maxDays"),
        "seasons": load_json(seasons_path),
        "general": general,            # all farm-questionnaire answers (priorities, risk, machinery ...)
        "field": field_answers,        # all field-questionnaire answers (salinity, drainage, frost ...)
    }

#------------------------------------------------------#  
#         Load Field Data (Location, Date)             #
#------------------------------------------------------# 

def season_from_date(date_str):
    """Meteorological season (northern hemisphere) from a 'YYYY-MM-DD' date."""
    month = int(date_str[5:7])
    return {12: "winter", 1: "winter", 2: "winter",
            3: "spring", 4: "spring", 5: "spring",
            6: "summer", 7: "summer", 8: "summer"}.get(month, "autumn")

# Only two growing seasons: spring counts as summer, autumn as winter (for the run date and the crops)
SEASON_GROUP = {"spring": "summer", "summer": "summer", "autumn": "winter", "winter": "winter"}

def load_field(path=DEMO_FIELD):
    """Return the field boundary as a flat list of [lon, lat] points, plus the date and its coming season."""
    data = load_json(path)
    points = [pt for feature in data["features"] for pt in feature["coords"]]
    return {"points": points, "end": data["end"], "season": SEASON_GROUP[season_from_date(data["end"])]}

def print_values(info, title, prefix):
    """Print every field value whose name starts with prefix."""
    values = {k: v for k, v in info.items() if k.startswith(prefix)}
    print(f"\n--- {title} ---")
    if not values:
        print("  (no data)")
    for key, value in values.items():
        print(f"  {key:<24} {value}")

#----------------------Salinity------------------------#

#----------------------Salinity------------------------#
removed = {}   # crop name -> [reasons]; filled by the salinity step and the pruning algorithm

def apply_salinity(crops, result, field=0):
    """Remove the crops that predict_field's strict mode excluded; print them with the reason."""
    excluded = {c["crop"].lower(): c["excluded_because"]
                for c in result["fields"][field]["excluded_crops"]}
    salty = [name for name in crops if name.lower() in excluded]

    print(f"Excluded by salinity ({len(salty)}): {', '.join(salty) or 'none'}")
    for name in salty:
        print(f"  - {name}: {excluded[name.lower()]}")
        removed.setdefault(name, []).append(f"salinity: {excluded[name.lower()]}")
    return {name: crop for name, crop in crops.items() if name.lower() not in excluded}

#------------------------------------------------------#
#             Extract Economic Information             #
#------------------------------------------------------# 


#-----------------------Water--------------------------#
# Irrigation each crop needs in the coming season, after rain, and what it costs:
#   1. Crop water use (ETc): the crop's FAO water-need range, placed by the season's evaporative demand
#      (mean daily ET0: 2 mm/day -> water_need_min, 8 mm/day -> water_need_max), and never more than
#      the season's ET0 itself (a crop can't use more than the reference over a whole season).
#   2. Effective rain: the part of the rain the roots can use (FAO, Irrigation Water Management manual 3):
#      per month 0.8 P - 25 if P > 75 mm, else 0.6 P - 10.
#   3. Net irrigation = ETc - effective rain;  gross = net / IRRIGATION_EFFICIENCY (losses of the method).
#   4. Price per m3: from the farmer's last season (irrigation cost / water that crop needed), kept inside
#      the range of Greek irrigation prices; DEFAULT_WATER_PRICE if there is no history.
SEASON_DAYS = 182                      # the 6-month window of all_field_data.py
IRRIGATION_EFFICIENCY = 0.75           # sprinkler; drip ~0.9, furrow ~0.6
DEFAULT_WATER_PRICE = 0.10             # €/m3
WATER_PRICE_RANGE = (0.054, 0.645)     # €/m3, range of irrigation water prices reported for Greece


def effective_rain(season_rain_mm, months=6):
    """FAO effective rainfall, from the season total (spread evenly over the months)."""
    p = season_rain_mm / months
    per_month = 0.8 * p - 25 if p > 75 else max(0.0, 0.6 * p - 10)
    return per_month * months


def water_price(farmer, crops):
    """(€/m3, how it was found) from the farmer's most recent season with an irrigation cost."""
    history = sorted(farmer.get("seasons") or [], key=lambda s: (s.get("season_year") or 0, s.get("sown_on") or ""))
    for s in reversed(history):
        cost = (s.get("costs") or {}).get("irrigation_eur_ha")
        c = crops.get(s.get("crop_id"))
        if cost and c and c.get("water_need_min") is not None:
            need_mm = (c["water_need_min"] + c["water_need_max"]) / 2          # that season's rain is unknown
            m3 = need_mm * 10 / IRRIGATION_EFFICIENCY                         # 1 mm on 1 ha = 10 m3
            price = min(max(cost / m3, WATER_PRICE_RANGE[0]), WATER_PRICE_RANGE[1])
            return price, f"farmer's {s['season_year']} {s['crop_id']}: {cost} €/ha / {m3:.0f} m3/ha"
    return DEFAULT_WATER_PRICE, "default (no irrigation cost in the history)"


def water_use(crops, field_info, price):
    """{crop: ETc, effective rain, net / gross irrigation (mm, m3/ha) and cost (€/ha)}. None if data is missing."""
    et0, rain = field_info.get("et_et0_mm"), field_info.get("rain_mm")
    out = {}
    for name, c in crops.items():
        row = dict.fromkeys(["etc_mm", "eff_rain_mm", "net_mm", "gross_m3_ha", "cost_eur_ha"])
        if et0 is not None and c.get("water_need_min") is not None:
            pos = min(max((et0 / SEASON_DAYS - 2) / (8 - 2), 0), 1)
            etc = c["water_need_min"] + pos * (c["water_need_max"] - c["water_need_min"])
            row["etc_mm"] = round(min(etc, et0), 1)
        if rain is not None:
            row["eff_rain_mm"] = round(effective_rain(rain), 1)
        if row["etc_mm"] is not None and row["eff_rain_mm"] is not None:
            row["net_mm"] = round(max(0.0, row["etc_mm"] - row["eff_rain_mm"]), 1)
            row["gross_m3_ha"] = round(row["net_mm"] * 10 / IRRIGATION_EFFICIENCY)
            row["cost_eur_ha"] = round(row["gross_m3_ha"] * price, 2)
        out[name] = row
    return out


def print_water(water, price, price_source):
    print(f"\n--- Water (irrigation after rain) ---  price {price:.3f} €/m3 [{price_source}]")
    for name, w in water.items():
        print(f"  {name:<14} ETc {w['etc_mm']} mm | effective rain {w['eff_rain_mm']} mm | "
              f"irrigation {w['net_mm']} mm = {w['gross_m3_ha']} m3/ha | {w['cost_eur_ha']} €/ha")

#---------------------Economics------------------------#
# Prices, yields and costs per crop: model_data/crop_profiles.json (the farmer's own figures override them,
# inside scoring.py)


#---------------------------------------------------------------------------------------------#
#                                    PRUNING ALGORITHM                                        #
#---------------------------------------------------------------------------------------------#

def prune_crops(crops, field_info, farmer, season):
    """Hard checks only (absolute limits). A check whose field data is missing (None) is skipped.
    Returns the crops that pass; every reason a crop fails is added to `removed`."""
    excluded = {c.lower() for c in farmer.get("excluded_crops") or []}
    max_days = farmer.get("max_days")
    ph = field_info.get("soil_ph_0_30cm")
    coldest = field_info.get("temp_coldest_month_c")
    warmest = field_info.get("temp_warmest_month_c")

    kept = {}
    for name, c in crops.items():
        reasons = []

        # 1. Farmer's exclusions
        if name.lower() in excluded:
            reasons.append("excluded by the farmer")

        # 2. Season (spring -> summer, autumn -> winter)
        crop_season = SEASON_GROUP.get(c.get("season"), c.get("season"))
        if crop_season != season:
            reasons.append(f"season {crop_season} ≠ coming season {season}")

        # 3. Cycle length: even the shortest cycle is longer than the farmer allows
        if max_days is not None and c.get("cycle_days_min") is not None and c["cycle_days_min"] > max_days:
            reasons.append(f"shortest cycle {c['cycle_days_min']} days > farmer's max {max_days} days")

        # 4. Soil pH, absolute limits
        if ph is not None:
            if c.get("pH_min") is not None and ph < c["pH_min"]:
                reasons.append(f"soil pH {ph} < absolute min {c['pH_min']}")
            if c.get("pH_max") is not None and ph > c["pH_max"]:
                reasons.append(f"soil pH {ph} > absolute max {c['pH_max']}")

        # 5. Temperature, absolute limits (monthly means of the coming season)
        if coldest is not None and c.get("temp_min") is not None and coldest < c["temp_min"]:
            reasons.append(f"coldest month {coldest} °C < absolute min {c['temp_min']} °C")
        if warmest is not None and c.get("temp_max") is not None and warmest > c["temp_max"]:
            reasons.append(f"warmest month {warmest} °C > absolute max {c['temp_max']} °C")

        if reasons:
            removed.setdefault(name, []).extend(reasons)
        else:
            kept[name] = c
    return kept

#---------------------------------------------------------------------------------------------#
#                                    SCORING ALGORITHM                                        #
#---------------------------------------------------------------------------------------------#
# The model is in scoring.py: expected yield, economics (crop_profiles.json / the farmer's own figures),
# risk, environment, practicality and the farmer's priorities -> the 4 options with % scores and comments.

def print_recommendations(rec):
    print(f"\n=== Recommendations (confidence {rec['confidence_pct']}%) ===")
    for o in rec["options"]:
        if not o.get("crop") or "scores_pct" not in o:
            print(f"  {o['title']:<34} {o.get('crop') or '-'}: {o.get('comment', '')}")
            continue
        s, e = o["scores_pct"], o["economics_eur_ha"] or {}
        print(f"  {o['title']:<34} {o['crop']:<12} overall {s['overall']}% | economic {s['economic']}% | "
              f"environmental {s['environmental']}% | margin {e.get('margin_eur_ha')} €/ha")
        for w in o["warnings"]:
            print(f"      !! {w}")


def run_prediction(general_path, field_path, seasons_path, coords_path):
    """Run one field and return the recommendations (the four options + details)."""
    global removed
    removed = {}
    crops = load_crops()
    catalogue = load_crops()                     # every crop, also the ones removed later
    farmer = load_farmer(general_path, field_path, seasons_path)
    field = load_field(coords_path)
    field_info = get_field_data(field["points"], field["end"])
    print(f"Field centre: {field_info['centre_lat']}, {field_info['centre_lon']}  |  date: {field_info['date']}")

    # salinity
    request = {"features": [{"coords": field["points"]}], "end": field["end"], "max_cloud": 15}
    result = predict_field(request, gee_project="firld-512718", min_yield=90)
    crops = apply_salinity(crops, result)
    print_values(field_info, "Rain", "rain_")
    print_values(field_info, "Elevation", "elevation_")
    print_values(field_info, "Soil Data ( Composition, pH)", "soil_")
    print_values(field_info, "Temperature", "temp_")
    print_values(field_info, "Evapotranspiration", "et_")
    print_values(field_info, "GroundWater", "gw_")

    # water (every crop, so the current crop can be compared too)
    price, price_source = water_price(farmer, catalogue)
    water = water_use(catalogue, field_info, price)
    print_water(water, price, price_source)

    # pruning
    pruned_crops = prune_crops(crops, field_info, farmer, field["season"])
    print(f"\n=== Pruning result (coming season: {field['season']}) ===")
    print(f"Kept ({len(pruned_crops)}): {', '.join(pruned_crops) or 'none'}")
    print(f"Removed ({len(removed)}):")
    for name, reasons in removed.items():
        print(f"  - {name}: {'; '.join(reasons)}")

    # scoring
    rec = build_recommendations(pruned_crops, catalogue, field_info, farmer, water, price, result, removed, field)
    # the four crop names at the top level as well, as the earlier output had them
    by_type = {o["type"]: o.get("crop") for o in rec["options"]}
    rec = {"economic": by_type.get("economic"), "environmental": by_type.get("environmental"),
           "mixed": by_type.get("mix"), "current": by_type.get("current"), **rec}
    print_recommendations(rec)
    return rec


def main():
    parser = argparse.ArgumentParser(description="Score one field and write the four crop choices.")
    # All optional: without them the demo files in model_data/website_data/ are used
    parser.add_argument("--general", default=str(DEMO_GENERAL_INFO), help="general-info.json")
    parser.add_argument("--field", default=str(DEMO_FIELD_INFO), help="field-info.json")
    parser.add_argument("--seasons", default=str(DEMO_SEASONS), help="farmer-seasons.json")
    parser.add_argument("--coords", default=str(DEMO_FIELD), help="field-coords.json")
    parser.add_argument("--out", default=str(Path(__file__).parent / "field_data/recommendations.json"),
                        help="results JSON")
    args = parser.parse_args()
    rec = run_prediction(args.general, args.field, args.seasons, args.coords)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(rec, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"-> {args.out}")


if __name__ == "__main__":
    main()