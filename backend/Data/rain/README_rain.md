# Rain

Gets the **rainfall (mm)** of each polygon over a time window and saves it to one CSV.

**Data:** NASA GPM IMERG, monthly, version 07 (Final Run). It's the same data as NASA Giovanni: a satellite estimate corrected with rain gauges, on a 0.1° grid (~10 km).

---

## Setup

```Shell
python -m pip install numpy matplotlib earthaccess h5py
```

You need a free **NASA Earthdata** account (https://urs.earthdata.nasa.gov). The first run asks for your username and password, then remembers them.

**One-time step:** in your Earthdata account go to **Applications → Authorized Apps**, approve **"NASA GESDISC DATA ARCHIVE"** and accept its terms. Without this, NASA refuses the download.

`common.py` must be in the folder above this script (`Data/`).

## Run

```Shell
python rain.py --source "path/to/source.json"              # window = the JSON's start..end
python rain.py --source "path/to/source.json" --days 90    # window = the 90 days ending on each polygon's "date"
```

| Option | What it does | Default |
|---|---|---|
| `--source` | JSON from the map page or build_dataset.py | required |
| `--days N` | Use the N days ending on each polygon's `"date"` (polygons without a date use start..end) | off |
| `--out` | Output folder | `rain_output` |

---

## Output

`rain_output/rain.csv`, one row per site:

| Column | Meaning |
|---|---|
| `site` | site1, site2, … in the order of the polygons |
| `start`, `end`, `days` | The window used |
| `rain_mm` | Total rainfall in the window (mm). Empty if a month of it isn't published yet |

---

## Notes

- **Partial months:** a window rarely covers whole months, so each month counts for the share of its days inside the window. For example, 10 days of a 30-day month counts a third of that month's rain.
- **Units:** GPM stores a rain *rate* (mm/hr). The script converts it to totals (rate × 24 × days).
- **Detail:** each grid cell is ~10 km wide, so a field usually falls in one cell. Rain changes smoothly, so neighbouring fields get similar values.
- **Delay:** the Final Run is published ~3–4 months after a month ends, so the most recent months aren't available yet.
- **Cache:** each monthly file (~30 MB) is downloaded once into `gpm_cache/` (next to the script) and reused by every later run.
