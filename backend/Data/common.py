"""
Shared helpers for the Data scripts (put this file in Data/, next to all_data.py).

  * site_windows(req, days)  - date window of every site in a request JSON
  * retry(fn, ...)           - call something that may fail on a bad connection, up to 3 times
  * weather_daily(lat, lon, start, end)
                             - daily air temperature (min / mean / max) and FAO-56 reference ET0
                               from NASA POWER (free, no account, no daily request limit),
                               cached on disk so each location/year is downloaded once.

Request JSON (from the map page or build_dataset.py):
    {"features": [{"coords": [[lon, lat], ...], "id": "48122730", "date": "2018-06-18"}, ...],
     "start": "...", "end": "...", "max_cloud": 15}
A feature's optional "date" is its sampling date. A script that is given --days N then uses
the N days that END on that date (so training points and new points get the same kind of window).
Features without a "date" (map page) use the request's "start" / "end".
"""
import json
import math
import os
import threading
import time
from datetime import date as Date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEATHER_CACHE = HERE / "weather_cache"
POWER_URL = "https://power.larc.nasa.gov/api/temporal/daily/point"
POWER_PARAMS = "T2M,T2M_MAX,T2M_MIN,RH2M,WS2M,ALLSKY_SFC_SW_DWN"


# ------------------------------------------------------------------ dates --
def parse_date(s):
    """'2018-06-18', '18/06/2018', '06-07-18' (LUCAS: DD-MM-YY) ... -> date."""
    if isinstance(s, Date):
        return s
    s = str(s).strip()[:19]
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%d/%m/%Y", "%d-%m-%Y", "%d-%m-%y", "%d/%m/%y", "%Y%m%d"):
        try:
            return datetime.strptime(s if "T" in fmt else s[:10], fmt).date()
        except ValueError:
            continue
    raise ValueError(f"unknown date format: {s!r}")


def site_windows(req, days=None):
    """[(start, end), ...] as date objects, one per feature.
    With days and a feature 'date': the `days` days ending on that date; otherwise the request's start/end."""
    out = []
    for f in req["features"]:
        if days and f.get("date"):
            end = parse_date(f["date"])
            out.append((end - timedelta(days=int(days) - 1), end))
        else:
            out.append((parse_date(req["start"]), parse_date(req["end"])))
    return out


def days_between(start, end):
    return [start + timedelta(i) for i in range((end - start).days + 1)]


# ----------------------------------------------------------------- retry --
def retry(fn, *args, tries=3, wait=5, what="request", **kwargs):
    """Run fn; on an exception wait and try again (wait doubles each time). Re-raises the last error."""
    for attempt in range(1, tries + 1):
        try:
            return fn(*args, **kwargs)
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception as e:
            if attempt == tries:
                raise
            print(f"   ({what} failed: {str(e)[:120]} - retry {attempt}/{tries - 1} in {wait}s)", flush=True)
            time.sleep(wait)
            wait *= 2


# --------------------------------------------------------------- in order --
def in_order(fn, jobs, ahead=3):
    """fn(*job) for every job, with up to `ahead` of them running at the same time, but the
    results come back in the ORIGINAL order as (job, result, error) - error is the exception
    fn raised, else None. Callers then handle each result exactly as if fn had been called
    one by one; only the waiting (downloads) overlaps. ahead=1: one by one, as before."""
    from concurrent.futures import ThreadPoolExecutor
    jobs = list(jobs)
    with ThreadPoolExecutor(max(1, ahead)) as pool:
        running = {}
        for i in range(len(jobs)):
            for j in range(i, min(i + max(1, ahead), len(jobs))):   # this job + the next ones
                if j not in running:
                    running[j] = pool.submit(fn, *jobs[j])
            try:
                result, error = running.pop(i).result(), None
            except Exception as e:                    # KeyboardInterrupt / SystemExit still stop
                result, error = None, e
            yield jobs[i], result, error


# --------------------------------------------------------------- weather --
def _power_year(lat, lon, year):
    """One calendar year of POWER daily data for one location: {date: {...}} (cached on disk)."""
    WEATHER_CACHE.mkdir(exist_ok=True)
    path = WEATHER_CACHE / f"{lat:.3f}_{lon:.3f}_{year}.json"
    today = Date.today()
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        if year < today.year - 1 or data.get("complete"):         # old years never change
            return data

    import requests

    def get():
        r = requests.get(POWER_URL, timeout=90, params={
            "parameters": POWER_PARAMS, "community": "ag", "format": "json",
            "latitude": f"{lat:.4f}", "longitude": f"{lon:.4f}",
            "start": f"{year}0101", "end": f"{min(Date(year, 12, 31), today):%Y%m%d}"})
        if r.status_code == 429:
            raise RuntimeError("NASA POWER: too many requests")
        r.raise_for_status()
        return r.json()

    js = retry(get, what="NASA POWER weather", wait=10)
    p = js["properties"]["parameter"]
    fill = js.get("header", {}).get("fill_value", -999)
    units = str(js.get("parameters", {}).get("ALLSKY_SFC_SW_DWN", {}).get("units", "MJ")).lower()
    to_mj = 3.6 if "kw" in units else 1.0                          # kWh/m2/day -> MJ/m2/day
    elev = (js.get("geometry", {}).get("coordinates") or [0, 0, 0])[-1] or 0
    days = {}
    for key in p["T2M"]:
        vals = {k: p[k].get(key) for k in p}
        if any(v is None or v == fill or v <= -990 for v in vals.values()):
            continue
        days[f"{key[:4]}-{key[4:6]}-{key[6:]}"] = {
            "tmin": vals["T2M_MIN"], "tmax": vals["T2M_MAX"], "tmean": vals["T2M"],
            "rh": vals["RH2M"], "wind": vals["WS2M"], "rs": vals["ALLSKY_SFC_SW_DWN"] * to_mj}
    data = {"elev": elev, "days": days, "complete": year < today.year and len(days) >= 365}
    # Write a temporary file, then swap it in: sites/batches running at the same time never read a
    # half-written cache file. If another one saved the same file at that moment, theirs is kept.
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    try:
        os.replace(tmp, path)
    except OSError:
        tmp.unlink(missing_ok=True)
        if not path.exists():
            raise
    return data


def fao56_et0(day, lat, elev, tmin, tmax, tmean, rh, wind, rs):
    """FAO-56 Penman-Monteith reference evapotranspiration (mm/day) from daily weather."""
    p = 101.3 * ((293 - 0.0065 * elev) / 293) ** 5.26
    gamma = 0.000665 * p
    e0 = lambda t: 0.6108 * math.exp(17.27 * t / (t + 237.3))
    es = (e0(tmax) + e0(tmin)) / 2
    ea = max(min(rh, 100), 0) / 100 * es
    delta = 4098 * e0(tmean) / (tmean + 237.3) ** 2
    j = day.timetuple().tm_yday
    phi = math.radians(lat)
    dr = 1 + 0.033 * math.cos(2 * math.pi * j / 365)
    dec = 0.409 * math.sin(2 * math.pi * j / 365 - 1.39)
    ws = math.acos(max(-1.0, min(1.0, -math.tan(phi) * math.tan(dec))))
    ra = 24 * 60 / math.pi * 0.0820 * dr * (ws * math.sin(phi) * math.sin(dec)
                                            + math.cos(phi) * math.cos(dec) * math.sin(ws))
    rso = (0.75 + 2e-5 * elev) * ra
    rnl = (4.903e-9 * ((tmax + 273.16) ** 4 + (tmin + 273.16) ** 4) / 2 * (0.34 - 0.14 * math.sqrt(ea))
           * (1.35 * min(rs / rso, 1.0) - 0.35)) if rso > 0 else 0.0
    rn = 0.77 * rs - rnl
    et0 = (0.408 * delta * rn + gamma * 900 / (tmean + 273) * wind * (es - ea)) / (delta + gamma * (1 + 0.34 * wind))
    return max(et0, 0.0)


def weather_daily(lat, lon, start, end):
    """{date: {"tmin", "tmax", "tmean", "et0"}} for every available day from start to end (dates)."""
    lat, lon = round(float(lat), 3), round(float(lon), 3)
    out = {}
    for year in range(start.year, end.year + 1):
        data = _power_year(lat, lon, year)
        for d in days_between(max(start, Date(year, 1, 1)), min(end, Date(year, 12, 31))):
            w = data["days"].get(d.isoformat())
            if w:
                out[d] = {"tmin": w["tmin"], "tmax": w["tmax"], "tmean": w["tmean"],
                          "et0": fao56_et0(d, lat, data["elev"], w["tmin"], w["tmax"], w["tmean"],
                                           w["rh"], w["wind"], w["rs"])}
    return out


def fill_daily(values, start, end):
    """Fill missing days of {date: number} by linear interpolation (edges held). None if empty."""
    if not values:
        return None
    known = sorted(values)
    xs = [d.toordinal() for d in known]
    out = {}
    for d in days_between(start, end):
        x = d.toordinal()
        if d in values:
            out[d] = values[d]
        elif x <= xs[0]:
            out[d] = values[known[0]]
        elif x >= xs[-1]:
            out[d] = values[known[-1]]
        else:
            i = next(i for i, k in enumerate(xs) if k > x)
            t = (x - xs[i - 1]) / (xs[i] - xs[i - 1])
            out[d] = values[known[i - 1]] * (1 - t) + values[known[i]] * t
    return out