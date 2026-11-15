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
    questionnaire). The crop history is loaded too, for the scoring."""
    general = load_json(general_path)["answers"]
    field_answers = load_json(field_path)["answers"]
    return {
        "excluded_crops": [c for c in general.get("excludedCrops", []) if c != "none"],   # ["none"] = no exclusions
        "max_days": field_answers.get("maxDays"),
        "seasons": load_json(seasons_path),
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
#---------------------Economics------------------------#


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
# Demo model, only with the data we already have. Every sub-score is 0..1 (1 = best).
# A sub-score whose field data is missing is left out of the average.
#   suitability : how close the field is to the crop's OPTIMAL ranges (temperature, pH, annual rain)
#                 -> stands in for expected yield
#   water       : share of the crop's water need covered by the season's rain (1 = no irrigation)
#   low_need    : lower total water need than the other candidates
#   rotation    : 1 if different from last season's crop, else 0
# The economic score uses no prices yet: good yield and little irrigation (pumping cost) stand in for profit.

def range_score(value, opt_min, opt_max, abs_min=None, abs_max=None):
    """1 inside [opt_min, opt_max], falling linearly to 0 at the absolute limit (or at 50% of the
    optimal value when no absolute limit is given)."""
    if value is None or opt_min is None or opt_max is None:
        return None
    if opt_min <= value <= opt_max:
        return 1.0
    if value < opt_min:
        floor = abs_min if abs_min is not None and abs_min < opt_min else opt_min * 0.5
        return max(0.0, (value - floor) / (opt_min - floor))
    ceil = abs_max if abs_max is not None and abs_max > opt_max else opt_max * 1.5
    return max(0.0, (ceil - value) / (ceil - opt_max))


def mean(values):
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


def last_crop(farmer):
    """crop_id of the most recent season in the farmer's crop history, or None."""
    seasons = sorted(farmer.get("seasons") or [], key=lambda s: (s.get("season_year") or 0, s.get("sown_on") or ""))
    return seasons[-1]["crop_id"] if seasons else None


def score_crop(c, field_info, previous):
    months = [v for k, v in field_info.items() if k.startswith("temp_month_") and v is not None]
    temp = mean([range_score(t, c.get("temp_opt_min"), c.get("temp_opt_max"), c.get("temp_min"), c.get("temp_max"))
                 for t in months])
    ph = range_score(field_info.get("soil_ph_0_30cm"), c.get("pc_opt_min"), c.get("pc_opt_max"),
                     c.get("pH_min"), c.get("pH_max"))
    rain = range_score(field_info.get("rain_annual_mm"), c.get("annual_rain_opt_min"), c.get("annual_rain_opt_max"))

    need = mean([c.get("water_need_min"), c.get("water_need_max")])        # mm per growing season
    season_rain = field_info.get("rain_mm")
    irrigation = max(0.0, need - season_rain) if need is not None and season_rain is not None else None
    water = 1 - irrigation / need if irrigation is not None and need else None

    return {"suitability": mean([temp, ph, rain]), "water": water, "need_mm": need,
            "irrigation_mm": irrigation, "rotation": 0.0 if c["name"] == previous else 1.0}


def score_crops(crops, field_info, farmer):
    """{crop: sub-scores + economic / environmental / mixed score}"""
    previous = last_crop(farmer)
    scores = {name: score_crop(c, field_info, previous) for name, c in crops.items()}
    needs = [s["need_mm"] for s in scores.values() if s["need_mm"] is not None]
    for s in scores.values():                                                # low_need: 1 = lowest need
        span = (max(needs) - min(needs)) if needs else 0
        s["low_need"] = (1 - (s["need_mm"] - min(needs)) / span) if span and s["need_mm"] is not None else 1.0
        s["economic"] = mean([s["suitability"]] * 2 + [s["water"]])                     # yield 2/3, pumping 1/3
        s["environmental"] = mean([s["water"], s["low_need"], s["rotation"]])
        s["mixed"] = mean([s["economic"], s["environmental"]])
    return scores


def best(scores, key):
    candidates = {n: s for n, s in scores.items() if s[key] is not None}
    return max(candidates, key=lambda n: candidates[n][key]) if candidates else None


def describe(name, s):
    fmt = lambda v: "-" if v is None else f"{v:.2f}"
    irr = "-" if s["irrigation_mm"] is None else f"{s['irrigation_mm']:.0f} mm"
    return (f"{name}  | economic {fmt(s['economic'])}, environmental {fmt(s['environmental'])}, "
            f"mixed {fmt(s['mixed'])} | suitability {fmt(s['suitability'])}, irrigation {irr}")

def run_prediction(general_path, field_path, seasons_path, coords_path):
    """Run one field and return the four choices. Names are whatever the model returns."""
    global removed
    removed = {}
    crops = load_crops()
    farmer = load_farmer(general_path, field_path, seasons_path)
    field = load_field(coords_path)
    field_info = get_field_data(field["points"], field["end"])
    print(f"Field centre: {field_info['centre_lat']}, {field_info['centre_lon']}  |  date: {field_info['date']}")

    request = {"features": [{"coords": field["points"]}], "end": field["end"], "max_cloud": 15}
    result = predict_field(request, gee_project="firld-512718", min_yield=90)
    crops = apply_salinity(crops, result)
    print(len(crops))
    print_values(field_info, "Rain", "rain_")
    print_values(field_info, "Elevation", "elevation_")
    print_values(field_info, "Soil Data ( Composition, pH)", "soil_")
    print_values(field_info, "Temperature", "temp_")
    print_values(field_info, "Evapotranspiration", "et_")
    print_values(field_info, "GroundWater", "gw_")

    pruned_crops = prune_crops(crops, field_info, farmer, field["season"])
    print(f"\n=== Pruning result (coming season: {field['season']}) ===")
    print(f"Kept ({len(pruned_crops)}): {', '.join(pruned_crops) or 'none'}")
    print(f"Removed ({len(removed)}):")
    for name, reasons in removed.items():
        print(f"  - {name}: {'; '.join(reasons)}")

    scores = score_crops(pruned_crops, field_info, farmer)
    current = last_crop(farmer)
    catalogue = load_crops()
    current_score = score_crops({current: catalogue[current]}, field_info, farmer)[current] \
        if current in catalogue else None
    options = {
        "economic": best(scores, "economic"),
        "environmental": best(scores, "environmental"),
        "mixed": best(scores, "mixed"),
        "current": current,
    }

    print("\n=== Scores (pruned crops) ===")
    for name in sorted(scores, key=lambda n: scores[n]["mixed"] or 0, reverse=True):
        print("  " + describe(name, scores[name]))
    print("\n=== Options ===")
    labels = {"economic": "Most economic", "environmental": "Most environmental", "mixed": "Best mix"}
    for key, label in labels.items():
        print(f"  {label:<20} {describe(options[key], scores[options[key]]) if options[key] else 'none'}")
    if current is None:
        print(f"  {'Continue current':<20} no crop history")
    elif current_score is None:
        print(f"  {'Continue current':<20} {current} (not in crops.json)")
    else:
        note = f"   !! removed by pruning: {'; '.join(removed[current])}" if current in removed else ""
        print(f"  {'Continue current':<20} {describe(current, current_score)}{note}")
    return options


def main():
    parser = argparse.ArgumentParser(description="Score one field and write the four crop choices.")
    parser.add_argument("--general", required=True, help="general-info.json")
    parser.add_argument("--field", required=True, help="field-info.json")
    parser.add_argument("--seasons", required=True, help="farmer-seasons.json")
    parser.add_argument("--coords", required=True, help="field-coords.json")
    parser.add_argument("--out", required=True, help="results JSON")
    args = parser.parse_args()
    options = run_prediction(args.general, args.field, args.seasons, args.coords)
    Path(args.out).write_text(json.dumps(options, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main() 
