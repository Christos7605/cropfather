#!/usr/bin/env python3
"""
Give every column a readable name, and write a short description of each one.

    python rename_columns.py finished_dataset_v4.csv finished_dataset_v5.csv

Also writes column_descriptions.csv next to the output: new name, old name, meaning.

Time windows (as build_dataset.py set them): "90d" = the 90 days before the sampling date,
"60d" = the 60 days before it, "10yr" = the 2009-2018 average.
The app must use the same names: run the new-field features through RENAME too
(from rename_columns import RENAME; df = df.rename(columns={k: v[0] for k, v in RENAME.items()})).
"""
import sys
from pathlib import Path

import pandas as pd

# old name: (new name, description)
RENAME = {
    # --- identity and target ---
    "Depth":            ("sample_depth", "LUCAS sampling depth (0-20 cm for almost all points)"),
    "POINTID":          ("lucas_point_id", "LUCAS 2018 point ID"),
    "EC":               ("target_ec_1to5_mS_per_m", "TARGET: measured soil EC, 1:5 soil:water extract, mS/m (/100 = dS/m)"),
    "TH_LAT":           ("latitude", "Latitude (degrees)"),
    "TH_LONG":          ("longitude", "Longitude (degrees)"),

    # --- terrain ---
    "elevation_mean_m": ("elevation_m", "Mean height above sea level of the square (Copernicus DEM 30 m)"),
    "slope_deg":        ("slope_deg", "Terrain slope in degrees (MERIT DEM)"),
    "hand_m":           ("height_above_drainage_m", "Height above the nearest river/drain; low = wet, shallow groundwater"),
    "tpi_300m":         ("terrain_position_300m", "Height vs. surroundings within 300 m (m); negative = hollow"),
    "tpi_1km":          ("terrain_position_1km", "Height vs. surroundings within 1 km (m); negative = valley/basin"),
    "dist_coast_km":    ("distance_to_coast_km", "Distance to the sea coastline (Natural Earth), km"),

    # --- soil (SoilGrids 2.0, 250 m) ---
    "soil_clay_pct":    ("soil_clay_pct", "Clay content, % (SoilGrids, 0-30 cm)"),
    "soil_sand_pct":    ("soil_sand_pct", "Sand content, % (SoilGrids, 0-30 cm)"),
    "sg_ph":            ("soil_ph", "Soil pH in water (0-20 cm); above ~7.8 = likely limestone soil"),
    "sg_cec":           ("soil_cec_cmol_per_kg", "Cation exchange capacity, cmol(c)/kg (0-20 cm)"),
    "sg_soc":           ("soil_organic_carbon_g_per_kg", "Soil organic carbon, g/kg (0-20 cm)"),
    "sg_bdod":          ("soil_bulk_density_kg_per_dm3", "Bulk density, kg/dm3 (0-20 cm)"),
    "sg_cfvo":          ("soil_coarse_fragments_pct", "Stones/gravel, volume % (0-20 cm)"),

    # --- weather before sampling (90 days) ---
    "rain_mm":          ("rain_90d_mm", "Rainfall, 90 days before sampling (GPM IMERG), mm"),
    "temp_air_min_c":   ("air_temp_min_90d_c", "Coldest daily minimum air temperature, 90 days (NASA POWER), C"),
    "temp_air_mean_c":  ("air_temp_mean_90d_c", "Average daily air temperature, 90 days, C"),
    "temp_air_max_c":   ("air_temp_max_90d_c", "Hottest daily maximum air temperature, 90 days, C"),
    "et_mean_mm":       ("actual_et_90d_mm", "Water actually evaporated + transpired, 90 days (ECOSTRESS/MODIS), mm"),
    "et_et0_mm":        ("reference_et0_90d_mm", "Reference evaporation demand ET0 (FAO-56), 90 days, mm"),
    "et_kc_mean":       ("et_ratio_actual_over_ref_90d", "Actual ET / reference ET0; low = dry or stressed surface"),

    # --- long-term climate (TerraClimate 2009-2018, ~4 km) ---
    "clim_pr_mm":       ("rain_10yr_mm_per_year", "Average yearly rainfall, mm"),
    "clim_pet_mm":      ("potential_et_10yr_mm_per_year", "Average yearly evaporation demand, mm"),
    "clim_aet_mm":      ("actual_et_10yr_mm_per_year", "Average yearly actual evaporation, mm"),
    "clim_def_mm":      ("water_deficit_10yr_mm_per_year", "Average yearly water deficit (demand not met by rain), mm"),
    "clim_tmax_c":      ("air_temp_max_10yr_avg_c", "Average of monthly maximum temperatures, C"),
    "clim_tmin_c":      ("air_temp_min_10yr_avg_c", "Average of monthly minimum temperatures, C"),
    "clim_soil_mm":     ("soil_moisture_10yr_mm", "Average soil moisture, mm"),
    "clim_pdsi":        ("drought_index_10yr", "Palmer drought index; negative = drier than normal"),
    "clim_aridity":     ("aridity_rain_over_pet_10yr", "Rain / evaporation demand; below 0.5 = semi-arid or drier"),

    # --- plant growth ---
    "npp_kgc_m2":       ("plant_growth_npp_kgC_m2_per_year", "Net primary production, MODIS 2014-2018 mean"),
}

# Sentinel-2 indices, 60 days before sampling. avg = average over the clear dates,
# lowest / highest = the clear date with the lowest / highest value.
INDICES = {
    "SI2":  ("si2_salinity_baresoil", "SI2 salinity index, bare-soil pixels only (NDVI < 0.33)"),
    "NDSI": ("ndsi_salinity_baresoil", "NDSI salinity index, bare-soil pixels only (NDVI < 0.33)"),
    "NDVI": ("ndvi_vegetation", "NDVI vegetation greenness, all pixels"),
    "NDMI": ("ndmi_moisture", "NDMI vegetation/surface moisture, all pixels"),
    "CRSI": ("crsi_canopy_salinity", "CRSI canopy response salinity index, all pixels"),
}
for idx, (name, text) in INDICES.items():
    for old, new, what in (("mean", "avg", "average"), ("min", "lowest", "lowest date"),
                           ("max", "highest", "highest date")):
        RENAME[f"index_{idx}_mean_{old}"] = (f"{name}_60d_{new}", f"{text}; 60 days, {what}")


def main():
    src, dst = sys.argv[1], sys.argv[2]
    df = pd.read_csv(src)
    known = {k: v for k, v in RENAME.items() if k in df.columns}
    unknown = [c for c in df.columns if c not in RENAME]
    df = df.rename(columns={k: v[0] for k, v in known.items()})
    df.to_csv(dst, index=False)

    desc = pd.DataFrame([{"column": new, "old_name": old, "description": text}
                         for old, (new, text) in known.items()])
    desc_path = Path(dst).with_name("column_descriptions.csv")
    desc.to_csv(desc_path, index=False)

    print(f"Renamed {len(known)} columns -> {dst}")
    print(f"Descriptions -> {desc_path}")
    if unknown:
        print(f"Kept as they were (not in the list): {', '.join(unknown)}")


if __name__ == "__main__":
    main()