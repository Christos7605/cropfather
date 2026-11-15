import json
from pathlib import Path
from all_field_data import get_field_data
 

# File Paths
CROPS_PATH = Path(__file__).parent / "model_data/crops.json"
DEMO_FIELD = Path(__file__).parent / "model_data/demo-field.json"
DEMO_FARMER = Path(__file__).parent / "model_data/demo-farmer-1.json"


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

crops = load_crops()

crops_to_prune = list(crops.keys())

#------------------------------------------------------#  
#                 Load Farmer Data                     #
#------------------------------------------------------# 

def load_farmer(path=DEMO_FARMER):
    """Keep only what pruning needs: target season, excluded crops, max cycle days."""
    answers = load_json(path)["farm_questionnaire"]["answers"]
    return {
        "target_season": answers.get("target_season"),
        "excluded_crops": answers.get("excluded_crops", []),
        "max_days": answers.get("max_days"),
    }

farmer = load_farmer()

#------------------------------------------------------#  
#         Load Field Data (Location, Date)             #
#------------------------------------------------------# 

def season_from_date(date_str):
    """Meteorological season (northern hemisphere) from a 'YYYY-MM-DD' date."""
    month = int(date_str[5:7])
    return {12: "winter", 1: "winter", 2: "winter",
            3: "spring", 4: "spring", 5: "spring",
            6: "summer", 7: "summer", 8: "summer"}.get(month, "autumn")

def load_field(path=DEMO_FIELD):
    """Return the field boundary as a flat list of [lon, lat] points, plus the date and its season."""
    data = load_json(path)
    points = [pt for feature in data["features"] for pt in feature["coords"]]
    return {"points": points, "end": data["end"], "season": season_from_date(data["end"])}

field = load_field()


#------------------------------------------------------#
#             Extract Field Information                #
#------------------------------------------------------# 
field_info = get_field_data(field["points"], field["end"])   # also saved as field_data/field_data.csv

def print_values(title, prefix):
    """Print every field_info value whose name starts with prefix."""
    values = {k: v for k, v in field_info.items() if k.startswith(prefix)}
    print(f"\n--- {title} ---")
    if not values:
        print("  (no data)")
    for key, value in values.items():
        print(f"  {key:<24} {value}")

print(f"Field centre: {field_info['centre_lat']}, {field_info['centre_lon']}  |  date: {field_info['date']}")

#----------------------Salinity------------------------#
print_values("Salinity", "index_")

#------------------------Rain--------------------------#
print_values("Rain", "rain_")

#---------------------Elevation------------------------#
print_values("Elevation", "elevation_")

#---------------------Soil Data------------------------#
print_values("Soil Data ( Composition, pH)", "soil_")


#--------------------Temperature-----------------------#
print_values("Temperature", "temp_")

#-----------------Evapotranspiration-------------------#
print_values("Evapotranspiration", "et_")

#---------------------GroundWater----------------------#
print_values("GroundWater", "gw_")

#------------------------------------------------------#
#             Extract Economic Information             #
#------------------------------------------------------# 


#-----------------------Water--------------------------#
#---------------------Economics------------------------#


#------------------------------------------------------#  
#                Run Pruning Algorithm                 #
#------------------------------------------------------# 

#------------------------------------------------------#  
#                Extract Pruned Crops                  #
#------------------------------------------------------# 