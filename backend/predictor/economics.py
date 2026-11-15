"""
Gross margin per hectare of each of the 15 crops for ONE field (chapter 6, Economics).

    GM = R_crop + R_sub - C_total                                         (6.1)

    R_crop   yield x price: crops.yield_kg_ha x Yc x crops.price_eur_kg  (6.2)
             Yc is the relative yield from the salinity model (1.0 when not given).
             price_eur_kg is already the midpoint of the observed min-max range.
    R_sub    coupled + decoupled + eco-scheme 31.1, from the crop_subsidies view   (6.3)
             - decoupled (basic, redistributive) is paid for every crop; the young-farmer
               payment (Π1-30) only when young_farmer=True
             - 31.1 only when the field's previous crop is one the scheme replaces
             - agri-environment (Π3-70-5.1) is left out, as in crop_economics: a voluntary
               commitment with costs of its own
    C_total  seed + fertiliser + plant protection + contract work + irrigation   (6.5)
             1. the farmer's own costs, from the latest season of this crop on this field
                (the questionnaire, model_data.seasons[].costs)
             2. a category the farmer did not fill (or a crop never grown here) takes the
                midpoint of the min-max reference ranges (migration 20261045):
                  seed        mid(seed price) x mid(seeding rate)
                  fertiliser  mid(fertiliser price) x mid(fertiliser rate)
                  protection  mid(protection cost)
                contract work and irrigation have no reference range: without the farmer's
                figure they count as 0.

All amounts are EUR per hectare per season.

A crop whose price is a placeholder (price_kind 'mock', e.g. vetch) or missing gets None:
no margin is built on a price without a source.

Usage:

    from economics import gross_margins, load_reference

    reference = load_reference()                     # Supabase (SUPABASE_URL, SUPABASE_KEY)
    seasons = model_data_row["seasons"]              # one field, from the model_data view
    margins = gross_margins(reference, seasons, yield_factors={"cotton": 0.85})
    # {"cotton": 1234.5, "maize": 987.6, ..., "vetch": None}
"""
from __future__ import annotations

import os
from typing import Any, Mapping, Sequence

# Cost categories of model_data.seasons[].costs (season_finance)
FARMER_COST_KEYS = (
    "seed_eur_ha",
    "fertilizer_eur_ha",
    "crop_protection_eur_ha",
    "contract_work_eur_ha",
    "irrigation_eur_ha",
)

YOUNG_FARMER_SCHEME = "Π1-30"
NO_REVENUE_PRICE_KINDS = {"mock"}



# ================================================================================================
#  Reference data
# ================================================================================================
def load_reference(url: str | None = None, key: str | None = None,
                   access_token: str | None = None) -> dict[str, Any]:
    """
    Read the reference tables from Supabase (PostgREST) and return them in the shape
    gross_margins() expects. url / key default to the SUPABASE_URL / SUPABASE_KEY environment
    variables (a .env file is read when python-dotenv is installed). access_token: the user's
    JWT, when the anon key alone is not allowed to read a table.
    """
    import requests

    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass

    url = (url or os.environ["SUPABASE_URL"]).rstrip("/")
    key = key or os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    headers = {"apikey": key, "Authorization": f"Bearer {access_token or key}"}

    def get(table: str, select: str) -> list[dict]:
        r = requests.get(f"{url}/rest/v1/{table}", params={"select": select},
                         headers=headers, timeout=30)
        r.raise_for_status()
        return r.json()

    return {
        "crops": get("crop_group_members",
                     "group_id,crops(id,name_en,yield_kg_ha,price_eur_kg,price_kind)"),
        "subsidies": get("crop_subsidies",
                         "crop_id,scheme_code,scheme_kind,amount,unit,replaces_crop_ids"),
        "seed": get("crop_cost_approaches", "*"),
        "fertilizer": get("crop_fertilizer_approaches", "*"),
        "protection": get("crop_protection_approaches", "*"),
    }


def _crop_rows(reference: Mapping[str, Any]) -> list[dict]:
    """The 15 crops: either plain crop rows, or crop_group_members rows with embedded crops."""
    rows = []
    for r in reference["crops"]:
        if "crops" in r:                       # crop_group_members?select=group_id,crops(...)
            if r.get("group_id") == "crop_shift" and r["crops"]:
                rows.append(r["crops"])
        else:
            rows.append(r)
    return rows


def _by_crop(rows: Sequence[Mapping[str, Any]] | None) -> dict[str, Mapping[str, Any]]:
    return {r["crop_id"]: r for r in rows or []}


def _mid(row: Mapping[str, Any] | None, low: str, high: str) -> float | None:
    if not row or row.get(low) is None or row.get(high) is None:
        return None
    return (float(row[low]) + float(row[high])) / 2


# ================================================================================================
#  Costs
# ================================================================================================
def reference_costs(crop_id: str, reference: Mapping[str, Any]) -> dict[str, float | None]:
    """Midpoint costs (EUR/ha) of the min-max reference tables; None where there is no range."""
    seed = _by_crop(reference.get("seed")).get(crop_id)
    fert = _by_crop(reference.get("fertilizer")).get(crop_id)
    prot = _by_crop(reference.get("protection")).get(crop_id)

    seed_price = _mid(seed, "seed_price_min_eur_kg", "seed_price_max_eur_kg")
    seed_rate = _mid(seed, "seeding_rate_min_kg_ha", "seeding_rate_max_kg_ha")
    fert_price = _mid(fert, "fertilizer_price_min_eur_kg", "fertilizer_price_max_eur_kg")
    fert_rate = _mid(fert, "fertilizer_rate_min_kg_ha", "fertilizer_rate_max_kg_ha")

    return {
        "seed_eur_ha": seed_price * seed_rate if seed_price is not None and seed_rate is not None else None,
        "fertilizer_eur_ha": fert_price * fert_rate if fert_price is not None and fert_rate is not None else None,
        "crop_protection_eur_ha": _mid(prot, "protection_cost_min_eur_ha", "protection_cost_max_eur_ha"),
        "contract_work_eur_ha": None,
        "irrigation_eur_ha": None,
    }


def _season_order(season: Mapping[str, Any]) -> tuple:
    return (season.get("harvested_on") or season.get("sown_on") or "",
            season.get("season_year") or 0,
            season.get("season_id") or 0)


def latest_season(seasons: Sequence[Mapping[str, Any]], crop_id: str | None = None,
                  with_costs: bool = False) -> Mapping[str, Any] | None:
    """The most recent season (of crop_id, if given; with at least one cost, if with_costs)."""
    found = [s for s in seasons
             if (crop_id is None or s.get("crop_id") == crop_id)
             and (not with_costs or any((s.get("costs") or {}).get(k) is not None
                                        for k in FARMER_COST_KEYS))]
    return max(found, key=_season_order) if found else None


def crop_costs(crop_id: str, seasons: Sequence[Mapping[str, Any]],
               reference: Mapping[str, Any]) -> tuple[dict[str, float], str]:
    """
    Costs (EUR/ha) of one crop: the farmer's latest season of this crop first, the reference
    midpoints for whatever the farmer did not fill. Returns (costs, basis) where basis is
    'farmer', 'mixed' or 'reference'.
    """
    ref = reference_costs(crop_id, reference)
    season = latest_season(seasons, crop_id, with_costs=True)
    farmer = (season or {}).get("costs") or {}

    costs, from_farmer, from_reference = {}, 0, 0
    for k in FARMER_COST_KEYS:
        if farmer.get(k) is not None:
            costs[k] = float(farmer[k])
            from_farmer += 1
        elif ref[k] is not None:
            costs[k] = ref[k]
            from_reference += 1
        else:
            costs[k] = 0.0
    basis = "farmer" if from_reference == 0 and from_farmer else "reference" if not from_farmer else "mixed"
    return costs, basis


# ================================================================================================
#  Subsidies
# ================================================================================================
def crop_subsidy(crop_id: str, reference: Mapping[str, Any], previous_crop_id: str | None,
                 young_farmer: bool = False) -> float:
    """Coupled + decoupled + 31.1 (EUR/ha) for one crop on this field."""
    total, eco_31_1 = 0.0, 0.0
    for s in reference.get("subsidies") or []:
        if s["crop_id"] != crop_id or s.get("amount") is None:
            continue
        if s.get("unit") not in (None, "EUR/ha"):
            continue                                    # only per-hectare amounts add up here
        amount = float(s["amount"])
        kind = s.get("scheme_kind")
        replaces = s.get("replaces_crop_ids") or []
        if replaces:                                    # 31.1: only after a crop it replaces
            if previous_crop_id in replaces:
                eco_31_1 = max(eco_31_1, amount)
        elif kind in ("coupled", "eco_scheme"):
            total += amount
        elif kind == "decoupled":
            if s.get("scheme_code") == YOUNG_FARMER_SCHEME and not young_farmer:
                continue
            total += amount
        # agri_environment and conditionality: left out (see the module docstring)
    return total + eco_31_1


# ================================================================================================
#  Gross margin
# ================================================================================================
def margin_breakdown(reference: Mapping[str, Any], seasons: Sequence[Mapping[str, Any]] = (),
                     yield_factors: Mapping[str, float] | None = None,
                     young_farmer: bool = False) -> dict[str, dict[str, Any]]:
    """Revenue, subsidies, costs and margin of every crop, for checking the numbers."""
    previous = latest_season(seasons)
    previous_crop_id = previous.get("crop_id") if previous else None
    yield_factors = yield_factors or {}

    out = {}
    for crop in _crop_rows(reference):
        crop_id = crop["id"]
        price, yld = crop.get("price_eur_kg"), crop.get("yield_kg_ha")
        yc = float(yield_factors.get(crop_id, 1.0))
        costs, basis = crop_costs(crop_id, seasons, reference)
        subsidy = crop_subsidy(crop_id, reference, previous_crop_id, young_farmer)

        if price is None or yld is None or crop.get("price_kind") in NO_REVENUE_PRICE_KINDS:
            revenue, margin = None, None
        else:
            revenue = float(yld) * yc * float(price)
            margin = revenue + subsidy - sum(costs.values())

        out[crop_id] = {
            "revenue_eur_ha": revenue,
            "subsidy_eur_ha": subsidy,
            "costs_eur_ha": costs,
            "cost_total_eur_ha": sum(costs.values()),
            "cost_basis": basis,
            "margin_eur_ha": None if margin is None else round(margin, 2),
        }
    return out


def gross_margins(reference: Mapping[str, Any], seasons: Sequence[Mapping[str, Any]] = (),
                  yield_factors: Mapping[str, float] | None = None,
                  young_farmer: bool = False) -> dict[str, float | None]:
    """
    {crop_id: gross margin in EUR/ha} for the 15 crops on one field.

    reference      load_reference() output
    seasons        the field's seasons (model_data.seasons): crop_id, dates, costs
    yield_factors  {crop_id: Yc} from the salinity model; 1.0 for a crop not given
    young_farmer   add the young-farmer payment (Π1-30)
    """
    return {crop_id: row["margin_eur_ha"]
            for crop_id, row in margin_breakdown(reference, seasons, yield_factors,
                                                 young_farmer).items()}


if __name__ == "__main__":
    import json
    import sys

    seasons = json.load(open(sys.argv[1], encoding="utf-8")) if len(sys.argv) > 1 else []
    if isinstance(seasons, dict):
        seasons = seasons.get("seasons", [])
    print(json.dumps(gross_margins(load_reference(), seasons), ensure_ascii=False, indent=2))
