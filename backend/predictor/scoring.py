"""
Scoring model: ranks the crops that survived pruning and builds the 4 recommendations
(most economic, most environmental, best mix, continue the current crop) as a JSON-ready dict.

Every input can be missing (None / not answered). Then the model either
  - ESTIMATES it from something else (e.g. soil salinity from the farmer's answer), flagged as "estimated", or
  - LEAVES IT OUT of that sub-score (the other parts are averaged), and lowers the confidence.

Scores are 0-100 % (100 = best). Money is € per hectare for the coming season.
"""
import json
from pathlib import Path

PROFILES_PATH = Path(__file__).parent / "model_data/crop_profiles.json"

N_PRICE_EUR_KG = 1.3            # € per kg of nitrogen fertiliser
SEASON_TEMP_MARGIN_C = 5        # a coldest/warmest month closer than this to the absolute limit counts as risky
MARGIN_SCALE_EUR_HA = (-300, 1200)   # margin (without subsidies) that scores 0 % .. 100 % economically

# Farmer answers -> numbers (only used when the measured / modelled value is missing)
SALINITY_ANSWER_ECE = {"never": 1.0, "rarely": 2.0, "sometimes": 3.0, "some": 3.0, "often": 6.0, "always": 10.0}
DRAINAGE_ANSWER = {"hours": 1.0, "day": 0.9, "days": 0.5, "week": 0.2, "never": 0.1}       # 1 = drains well
FROST_ANSWER = {"never": 0.0, "rarely": 0.3, "sometimes": 0.6, "often": 1.0}               # 1 = frequent frost
PRIORITY_TO_PART = {"raiseIncome": "economic", "cutCosts": "economic",
                    "saveWater": "environmental", "soilHealth": "environmental", "lessChemicals": "environmental",
                    "lessWork": "practical", "lessTools": "practical"}


# ------------------------------------------------------------------------------- helpers --
def mean(values, weights=None):
    """Weighted mean that skips None values (and their weights). None if nothing is left."""
    weights = weights or [1] * len(values)
    pairs = [(v, w) for v, w in zip(values, weights) if v is not None]
    total = sum(w for _, w in pairs)
    return sum(v * w for v, w in pairs) / total if total else None


def clip(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def range_score(value, opt_min, opt_max, abs_min=None, abs_max=None):
    """1 inside the optimal range, falling linearly to 0 at the absolute limit
    (or at 50 % / 150 % of the optimal bound when there is no absolute limit)."""
    if value is None or opt_min is None or opt_max is None:
        return None
    if opt_min <= value <= opt_max:
        return 1.0
    if value < opt_min:
        floor = abs_min if abs_min is not None and abs_min < opt_min else opt_min * 0.5
        return clip((value - floor) / (opt_min - floor))
    ceil = abs_max if abs_max is not None and abs_max > opt_max else opt_max * 1.5
    return clip((ceil - value) / (ceil - opt_max))


def pct(x):
    return None if x is None else round(100 * x, 1)


def normalise(values):
    """{name: value} -> {name: 0..1} (best = 1). Equal values -> all 1."""
    known = {k: v for k, v in values.items() if v is not None}
    if not known:
        return dict.fromkeys(values)
    lo, hi = min(known.values()), max(known.values())
    return {k: (None if v is None else (1.0 if hi == lo else (v - lo) / (hi - lo))) for k, v in values.items()}


def find_ece(result, field=0):
    """Soil salinity ECe (dS/m) from the salinity model's result, if it reports one (any numeric key with 'ece')."""
    try:
        data = result["fields"][field]
    except (TypeError, KeyError, IndexError):
        return None
    for key, value in data.items():
        if "ece" in key.lower() and isinstance(value, (int, float)):
            return float(value)
    return None


# ----------------------------------------------------------------------- field context --
def field_context(field_info, farmer, salinity_result):
    """Everything the scoring needs about the field and farmer, with estimates for missing values.
    Each value is (value, source) with source 'measured', 'farmer', 'estimated' or None (missing)."""
    fa = farmer.get("field") or {}
    ga = farmer.get("general") or {}
    ctx = {}

    def put(key, value, source):
        ctx[key] = (value, source if value is not None else None)

    # salinity: the model's ECe > the farmer's answer (only when the model gave no result at all,
    # because a model that ran has already removed the crops that can't stand this field's salt)
    ece = find_ece(salinity_result)
    model_ran = bool(salinity_result and salinity_result.get("fields"))
    if ece is not None:
        put("ece", ece, "measured")
    elif not model_ran:
        put("ece", SALINITY_ANSWER_ECE.get(fa.get("salinity")), "farmer")
    else:
        put("ece", None, None)
    put("salinity_answer", SALINITY_ANSWER_ECE.get(fa.get("salinity")), "farmer")   # used as a risk signal
    put("salinity_model", model_ran or None, "measured")

    put("ph", field_info.get("soil_ph_0_30cm"), "measured")
    put("months", [v for k, v in sorted(field_info.items()) if k.startswith("temp_month_") and v is not None] or None,
        "measured")
    put("coldest", field_info.get("temp_coldest_month_c"), "measured")
    put("warmest", field_info.get("temp_warmest_month_c"), "measured")
    put("rain_annual", field_info.get("rain_annual_mm"), "measured")
    put("clay", field_info.get("soil_clay_pct"), "measured")

    # drainage: farmer's answer, else estimated from clay % and elevation (low, clayey fields drain slowly)
    drainage = DRAINAGE_ANSWER.get(fa.get("drainage"))
    if drainage is not None:
        put("drainage", drainage, "farmer")
    else:
        clay, elev = field_info.get("soil_clay_pct"), field_info.get("elevation_mean_m")
        est = mean([None if clay is None else clip(1 - (clay - 20) / 40),
                    None if elev is None else (0.5 if elev < 1 else 1.0)])
        put("drainage", est, "estimated")

    put("frost", FROST_ANSWER.get(fa.get("frost")), "farmer")
    put("stony", (fa.get("soilTexture") == "stony") if fa.get("soilTexture") else None, "farmer")
    put("water_shortage", fa.get("waterShortage"), "farmer")                    # 1 (none) .. 5 (severe)
    put("risk_attitude", ga.get("riskAttitude"), "farmer")                      # 1 (careful) .. 5 (bold)
    put("priorities", [p for p in ga.get("priorities") or [] if p != "none"] or None, "farmer")
    put("machinery", ga.get("machinery"), "farmer")
    put("labour", ga.get("labour"), "farmer")
    put("soil_test", None if fa.get("lastSoilTest") is None else fa["lastSoilTest"] not in ("none", "never"), "farmer")
    return ctx


# ------------------------------------------------------------------------ crop economics --
def history_for(farmer, crop):
    """The farmer's most recent season of this crop that has disclosed income, or None."""
    rows = [s for s in farmer.get("seasons") or []
            if s.get("crop_id") == crop and (s.get("income") or {}).get("disclosed")]
    return sorted(rows, key=lambda s: (s.get("season_year") or 0, s.get("sown_on") or ""))[-1] if rows else None


def economics(name, crop, profile, rel_yield, water_row, farmer):
    """Expected €/ha. Farmer's own figures (if this crop is in the history) > crop_profiles.json."""
    hist = history_for(farmer, name)
    notes = []
    if hist:                                                     # the farmer's real numbers, as reported
        inc, cost = hist["income"], hist.get("costs") or {}
        revenue = inc.get("revenue_eur_ha")
        if revenue is None and inc.get("yield_kg_ha") and inc.get("price_eur_kg"):
            revenue = inc["yield_kg_ha"] * inc["price_eur_kg"] + (inc.get("other_eur_ha") or 0) \
                + (inc.get("subsidy_eur_ha") or 0)
        costs = cost.get("total_eur_ha")
        subsidy = inc.get("subsidy_eur_ha") or 0
        if revenue is not None and costs is not None:
            notes.append(f"uses your own {hist['season_year']} figures for {name}")
            revenue -= subsidy                    # subsidies left out of every margin, so all crops compare fairly
            return {"yield_kg_ha": inc.get("yield_kg_ha"), "price_eur_kg": inc.get("price_eur_kg"),
                    "revenue_eur_ha": round(revenue), "fertiliser_eur_ha": cost.get("fertilizer_eur_ha"),
                    "water_cost_eur_ha": cost.get("irrigation_eur_ha"), "costs_eur_ha": round(costs),
                    "margin_eur_ha": round(revenue - costs), "subsidy_eur_ha_not_included": subsidy,
                    "source": "farmer"}, notes
    if not profile:
        return None, [f"no price / yield data for {name}"]

    yield_kg = profile["yield_kg_ha"] * (rel_yield if rel_yield is not None else 1.0)
    revenue = yield_kg * profile["price_eur_kg"] + profile.get("other_income_eur_ha", 0)
    fert = profile.get("n_kg_ha", 0) * N_PRICE_EUR_KG
    water_cost = (water_row or {}).get("cost_eur_ha") or 0
    costs = profile["costs_eur_ha"] + fert + water_cost
    return {"yield_kg_ha": round(yield_kg), "price_eur_kg": profile["price_eur_kg"], "revenue_eur_ha": round(revenue),
            "fertiliser_eur_ha": round(fert), "water_cost_eur_ha": round(water_cost), "costs_eur_ha": round(costs),
            "margin_eur_ha": round(revenue - costs), "source": "estimate"}, notes


# ----------------------------------------------------------------------- score one crop --
def assess(name, crop, profile, ctx, water_row, farmer, previous):
    """All sub-scores (0..1) of one crop, plus the reasons behind them as short comments."""
    v = {k: val for k, (val, _) in ctx.items()}
    comments, warnings = [], []
    profile = profile or {}

    # --- growing conditions -> relative yield
    temp = mean([range_score(t, crop.get("temp_opt_min"), crop.get("temp_opt_max"), crop.get("temp_min"),
                             crop.get("temp_max")) for t in v["months"]]) if v["months"] else None
    ph = range_score(v["ph"], crop.get("pc_opt_min"), crop.get("pc_opt_max"), crop.get("pH_min"), crop.get("pH_max"))
    rain = range_score(v["rain_annual"], crop.get("annual_rain_opt_min"), crop.get("annual_rain_opt_max"))
    drainage = None if v["drainage"] is None else (1.0 if profile.get("waterlogging_tolerant") else v["drainage"])
    soil = None
    if v["stony"] is not None or v["clay"] is not None:            # stony or heavy clay soil hurts root crops
        soil = 0.5 if profile.get("root_crop") and (v["stony"] or (v["clay"] or 0) > 40) else 1.0

    salinity = None                                                 # Maas-Hoffman: 100 - b (ECe - a)
    if v["ece"] is not None and crop.get("ECe_full_yield") is not None:
        salinity = clip((100 - crop["ECe_slope"] * max(0.0, v["ece"] - crop["ECe_full_yield"])) / 100)

    climate = mean([temp, ph, rain, drainage, soil], [0.35, 0.25, 0.1, 0.15, 0.15])
    rel_yield = (salinity if salinity is not None else 1.0) * (0.5 + 0.5 * climate if climate is not None else 1.0)

    if temp is not None:
        comments.append(f"temperature {'fits the optimal range' if temp > 0.95 else f'is {pct(temp):.0f}% of optimal'}"
                        f" ({crop['temp_opt_min']}-{crop['temp_opt_max']} °C)")
    if ph is not None and ph < 1:
        comments.append(f"soil pH {v['ph']} is outside the optimal {crop['pc_opt_min']}-{crop['pc_opt_max']}")
    if salinity is not None:
        comments.append(f"salinity ECe {v['ece']} dS/m -> about {pct(salinity):.0f}% of full yield"
                        + (" (estimated from your answer)" if ctx["ece"][1] == "farmer" else ""))
    if drainage is not None and drainage < 0.7:
        warnings.append("slow drainage: risk of waterlogging")

    # --- water
    w = water_row or {}
    irrigation_share = (w["net_mm"] / w["etc_mm"]) if w.get("net_mm") is not None and w.get("etc_mm") else None
    if w.get("net_mm") is not None:
        comments.append("rain covers the crop's water need" if w["net_mm"] < 10 else
                        f"needs about {w['gross_m3_ha']} m3/ha of irrigation ({100 * irrigation_share:.0f}% of its water)")

    # --- rotation (with last season's crop)
    last_family = (farmer.get("_profiles", {}).get(previous) or {}).get("family")
    if previous is None:
        rotation = None
    elif name == previous:
        rotation = 0.0
        warnings.append("same crop as last season: higher pest / disease and soil-fatigue risk")
    elif last_family and profile.get("family") == last_family:
        rotation = 0.4
        comments.append(f"same crop family as last season's {previous}")
    else:
        rotation = 1.0
        comments.append(f"good rotation after {previous}")
    if profile.get("family") == "legume":
        comments.append("legume: fixes its own nitrogen and leaves some for the next crop")

    # --- risk (0 = safe .. 1 = risky)
    margins = []
    if v["coldest"] is not None and crop.get("temp_min") is not None:
        margins.append(clip(1 - (v["coldest"] - crop["temp_min"]) / SEASON_TEMP_MARGIN_C))
    if v["warmest"] is not None and crop.get("temp_max") is not None:
        margins.append(clip(1 - (crop["temp_max"] - v["warmest"]) / SEASON_TEMP_MARGIN_C))
    temp_risk = max(margins) if margins else None
    if temp_risk and temp_risk > 0.5:
        warnings.append("monthly temperatures come close to the crop's absolute limit")
    frost_risk = None if v["frost"] is None else v["frost"] * (1.0 if (crop.get("temp_min") or 0) >= 8 else 0.3)
    water_risk = None
    if v["water_shortage"] is not None and irrigation_share is not None:
        water_risk = clip((v["water_shortage"] - 1) / 4) * irrigation_share
        if water_risk > 0.3:
            warnings.append("depends on irrigation, and you reported water shortages")
    salt_risk = None if salinity is None else 1 - salinity
    if v["salinity_answer"] is not None and crop.get("ECe_full_yield") is not None:
        # farmer reports salty patches: riskier for salt-sensitive crops (low ECe at full yield)
        answer_risk = clip(v["salinity_answer"] / 10) * clip(1 - crop["ECe_full_yield"] / 10)
        salt_risk = answer_risk if salt_risk is None else max(salt_risk, answer_risk)
        if answer_risk > 0.25:
            warnings.append(f"you report salinity '{farmer['field'].get('salinity')}', and this crop is salt-sensitive"
                            f" (full yield only up to ECe {crop['ECe_full_yield']} dS/m)")
    risk = mean([temp_risk, frost_risk, water_risk, salt_risk])

    # --- environment
    n = profile.get("n_kg_ha")
    environment = {
        "water": None if irrigation_share is None else 1 - irrigation_share,
        "nitrogen": None if n is None else clip(1 - n / 250),
        "rotation": rotation,
    }

    # --- practicality (work and machinery)
    work = None if profile.get("work") is None else 1 - (profile["work"] - 1) / 2
    machinery = None
    if profile.get("special_machinery") is not None:
        machinery = 0.4 if profile["special_machinery"] else 1.0
        if profile["special_machinery"]:
            comments.append("needs a special harvester (own or contractor)")

    return {"rel_yield": rel_yield, "climate": climate, "salinity": salinity, "risk": risk,
            "environment": environment, "work": work, "machinery": machinery,
            "comments": comments, "warnings": warnings}


# --------------------------------------------------------------------- the whole model --
def build_recommendations(pruned_crops, all_crops, field_info, farmer, water, water_price, salinity_result,
                          removed, field, profiles_path=PROFILES_PATH):
    """Score the pruned crops (+ the current crop) and return the recommendations as a dict."""
    profiles = {k: v for k, v in json.loads(Path(profiles_path).read_text(encoding="utf-8")).items()
                if not k.startswith("_")}
    farmer = {**farmer, "_profiles": profiles}
    ctx = field_context(field_info, farmer, salinity_result)
    v = {k: val for k, (val, _) in ctx.items()}

    history = sorted(farmer.get("seasons") or [], key=lambda s: (s.get("season_year") or 0, s.get("sown_on") or ""))
    current = history[-1]["crop_id"] if history else None

    # weights of the three parts, shifted by the farmer's priorities
    weights = {"economic": 1.0, "environmental": 1.0, "practical": 0.5}
    for p in v["priorities"] or []:
        if p in PRIORITY_TO_PART:
            weights[PRIORITY_TO_PART[p]] += 0.5
    env_w = {"water": 1.0 + (0.5 * (v["water_shortage"] - 1) / 4 if v["water_shortage"] else 0)
             + (0.5 if "saveWater" in (v["priorities"] or []) else 0),
             "nitrogen": 1.0, "rotation": 0.8}
    risk_weight = 0.4 - 0.1 * ((v["risk_attitude"] or 3) - 1)          # careful farmers weigh risk more
    risk_weight = clip(risk_weight, 0.0, 0.4)
    if v["machinery"] in ("none", "rent", "contractor"):
        weights["practical"] += 0.25

    # assess every candidate (pruned crops + the current crop)
    names = list(pruned_crops) + ([current] if current in all_crops and current not in pruned_crops else [])
    rows = {}
    for name in names:
        a = assess(name, all_crops[name], profiles.get(name), ctx, water.get(name), farmer, current)
        econ, notes = economics(name, all_crops[name], profiles.get(name), a["rel_yield"], water.get(name), farmer)
        a["comments"] += notes
        a["economics"] = econ
        a["environmental"] = mean(list(a["environment"].values()), [env_w[k] for k in a["environment"]])
        a["practical"] = mean([a["work"], a["machinery"]])
        rows[name] = a

    # economic score: margin on a fixed € scale (MARGIN_SCALE_EUR_HA), lowered by risk;
    # without economics data, the expected yield stands in
    for n, r in rows.items():
        m = (r["economics"] or {}).get("margin_eur_ha")
        lo, hi = MARGIN_SCALE_EUR_HA
        base = clip((m - lo) / (hi - lo)) if m is not None else r["rel_yield"]
        r["economic"] = None if base is None else base * (1 - risk_weight * (r["risk"] or 0))
        r["overall"] = mean([r["economic"], r["environmental"], r["practical"]],
                            [weights["economic"], weights["environmental"], weights["practical"]])

    # confidence: share of the field inputs that were measured or answered (estimates count half)
    used = ["salinity_model", "ph", "months", "rain_annual", "drainage", "frost", "water_shortage"]
    confidence = mean([1.0 if ctx[k][1] in ("measured", "farmer") else 0.5 if ctx[k][1] == "estimated" else 0.0
                       for k in used])
    if ctx["ph"][1] == "measured" and not v["soil_test"]:
        confidence -= 0.05                                               # pH from a map, no soil test

    candidates = [n for n in pruned_crops if n in rows]
    pick = lambda key: max(candidates, key=lambda n: rows[n][key] if rows[n][key] is not None else -1) \
        if candidates else None
    choice = {"economic": pick("economic"), "environmental": pick("environmental"), "mix": pick("overall")}

    def option(kind, name, title, why):
        if name is None:
            return {"type": kind, "title": title, "crop": None, "comment": "no crop passed the pruning"}
        r = rows[name]
        same = [k for k, c in choice.items() if c == name and k != kind]
        out = {
            "type": kind, "title": title, "crop": name, "why": why,
            "scores_pct": {"overall": pct(r["overall"]), "economic": pct(r["economic"]),
                           "environmental": pct(r["environmental"]), "practical": pct(r["practical"]),
                           "expected_yield_of_potential": pct(r["rel_yield"]), "risk": pct(r["risk"])},
            "economics_eur_ha": r["economics"],
            "water": {k: (water.get(name) or {}).get(k) for k in ("etc_mm", "eff_rain_mm", "net_mm", "gross_m3_ha",
                                                                    "cost_eur_ha")},
            "nitrogen_kg_ha": (profiles.get(name) or {}).get("n_kg_ha"),
            "comments": r["comments"], "warnings": r["warnings"],
        }
        if same:
            out["also_best_for"] = same
        if name in removed:
            out["warnings"] = [f"would be removed by pruning: {'; '.join(removed[name])}"] + out["warnings"]
        return out

    options = [
        option("economic", choice["economic"], "Most economically beneficial",
               "highest expected margin per hectare, adjusted for risk"),
        option("environmental", choice["environmental"], "Most environmentally beneficial",
               "least irrigation and nitrogen, and the best rotation"),
        option("mix", choice["mix"], "Best mix of both",
               "best weighted balance of economics, environment and practicality (your priorities included)"),
    ]
    if current in rows:
        options.append(option("current", current, "Continue the current crop",
                              f"what you grew last season ({history[-1].get('season_year')})"))
    else:
        options.append({"type": "current", "title": "Continue the current crop", "crop": current,
                        "comment": "no crop history" if current is None else f"{current} is not in crops.json"})

    return {
        "field": {"centre": [field_info.get("centre_lat"), field_info.get("centre_lon")], "run_date": field["end"],
                  "coming_season": field["season"], "climate_window": field_info.get("climate_window"),
                  "climate_years": field_info.get("climate_years")},
        "confidence_pct": pct(clip(confidence or 0)),
        "inputs": {k: {"value": val, "source": src or "missing"} for k, (val, src) in ctx.items()},
        "weights": {"parts": weights, "environment": env_w, "risk_weight": round(risk_weight, 2),
                    "water_price_eur_m3": round(water_price, 3)},
        "options": options,
        "ranking": [{"crop": n, "overall_pct": pct(rows[n]["overall"]), "economic_pct": pct(rows[n]["economic"]),
                     "environmental_pct": pct(rows[n]["environmental"]),
                     "margin_eur_ha": (rows[n]["economics"] or {}).get("margin_eur_ha")}
                    for n in sorted(candidates, key=lambda n: rows[n]["overall"] or 0, reverse=True)],
        "removed_by_pruning": removed,
        "notes": ["Prices, yields and costs of crops you haven't grown are rough estimates (model_data/crop_profiles.json).",
                  "Margins leave out subsidies, so all crops are compared on the same basis.",
                  "Scores compare the crops with each other; they are not absolute grades.",
                  "The current crop is scored on the coming season's conditions, even if it would normally grow in another season."],
    }