#!/usr/bin/env python3
"""
Build the training dataset: every LUCAS point + all the data gathered for its square,
with every time window ending on the point's SAMPLING DATE (as all_data.py sets them:
90 days for rain / air temperature / ET, 60 days for satellite indexes / surface temperature).

    python build_dataset.py --limit 200              # test on the first 200 points
    python build_dataset.py                          # all points (resumes where it stopped)
    python build_dataset.py --workers 4              # 4 batches at the same time
    python build_dataset.py --skip evapotranspiration    # passed on to all_data.py
    python build_dataset.py --rebuild                # only rebuild the CSV from what's already collected
    python build_dataset.py --patch                  # no new points: fill characteristics still missing
                                                     #   on points already in the cache, then update the CSV
    python build_dataset.py --limit 10 --time        # + time of every part of each batch and a full
                                                     #   time report at the end (_dataset_work/time_report.txt)

Fast: nearby points are processed TOGETHER (batches of up to --batch-size points from the same
--cell x --cell degree square), so logins, searches and downloads (rain months, MODIS tiles,
ECOSTRESS passes) are shared instead of repeated for every point.

Layout (found automatically):
    base_folder/
      pipeline/config.py               (SQUARES_CSV)
      pipeline/output/01_lucas_points.csv
      backend/[Data/]build_dataset.py  <- this file, in backend/ or backend/Data/
      backend/Data/all_data.py, common.py, elevation/, soil/, rain/, ...
      backend/Data/finished_dataset.csv   <- result

Sampling date: SURVEY_DATE of 01_lucas_points.csv (LUCAS format DD-MM-YY), or the square's
end_date if that column is missing.

Resumable: every finished point is saved at once in features_cache.jsonl; start again and
finished points are skipped. Points that got no data at all are retried. A point that got
some scripts but not others (rain failed, soil succeeded) is skipped by a normal run;
--patch goes back over the cached points only and fetches just the scripts still missing.
"""
import argparse
import csv
import fnmatch
import json
import math
import os
import re
import shutil
import subprocess
import sys
import textwrap
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from pathlib import Path

_FILE_DIR = Path(__file__).resolve().parent
HERE = next((d for d in (_FILE_DIR, _FILE_DIR / "Data", _FILE_DIR / "data") if (d / "all_data.py").exists()),
            _FILE_DIR)                                 # base_folder/backend/Data
BASE = next((d for d in _FILE_DIR.parents if (d / "pipeline" / "config.py").exists()),
            _FILE_DIR.parents[1])                      # base_folder
PIPELINE = BASE / "pipeline"
LUCAS_CSV = PIPELINE / "output" / "01_lucas_points.csv"
ALL_DATA = HERE / "all_data.py"
CACHE = HERE / "features_cache.jsonl"
FINAL_CSV = HERE / "finished_dataset.csv"
WORK = HERE / "_dataset_work"                          # batch requests, outputs (deleted) and logs

sys.path.insert(0, str(HERE))
from common import parse_date  # noqa: E402

SQUARE_COLUMNS = ["square_coords", "start_date", "end_date", "max_cloud", "EC_LABEL"]   # copied to the result
DATE_COLUMNS = ["SURVEY_DATE", "survey_date", "DATE", "date"]                            # sampling date in LUCAS
BASIC_COLUMNS = {"centre_lon", "centre_lat", "start", "end", "date"}                    # not real data

# Columns left OUT of finished_dataset.csv (* = any text). They're still in features_cache.jsonl,
# so after editing this list run:  python build_dataset.py --rebuild
DROP_COLUMNS = [
    "EC_LABEL",                                        # exact copy of EC (the target)
    "SURVEY_DATE", "SURVEY_DATE_ISO", "date", "start", "end",
    "square_coords", "start_date", "end_date", "max_cloud",    # request settings, not data
    "centre_lon", "centre_lat",                        # same as TH_LONG / TH_LAT
    "elevation_min_m", "elevation_max_typical_m", "elevation_max_m",   # = mean on a 50 m square
    "et_min_mm", "et_max_mm",                          # = et_mean_mm (one pixel)
    "et_good_dates", "et_modis_days", "et_source",     # how ET was made, not ET
    "temp_lst_passes",                                 # number of Landsat passes
    "index_*_count",                                   # number of Sentinel-2 dates
]


# ----------------------------------------------------------------- input --
def pipeline_squares_csv():
    if not (PIPELINE / "config.py").exists():
        raise SystemExit(f"Can't find pipeline/config.py above {_FILE_DIR}. Expected it at {PIPELINE / 'config.py'}")
    sys.path.insert(0, str(PIPELINE))
    import config                                      # pipeline/config.py
    p = Path(config.SQUARES_CSV)
    return (p if p.is_absolute() else PIPELINE / p).resolve()


def read_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as fh:
        first = fh.readline()
        fh.seek(0)
        return list(csv.DictReader(fh, delimiter="\t" if first.count("\t") > first.count(",") else ","))


def pid_of(row):
    return str(row["POINTID"]).split(".")[0]


def sampling_date(lucas_row, square):
    for c in DATE_COLUMNS:
        if lucas_row and lucas_row.get(c):
            try:
                return parse_date(lucas_row[c])
            except ValueError:
                pass
    return parse_date(square["end_date"])


def has_data(feats):
    """True if at least one script delivered a value (not just the site centre and date)."""
    return bool(feats) and any(v not in ("", None) for c, v in feats.items() if c not in BASIC_COLUMNS)


def load_cache():
    done = {}
    if CACHE.exists():
        for line in CACHE.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rec = json.loads(line)
                if rec.get("ok") and has_data(rec.get("features")):     # empty results are retried
                    done[str(rec["POINTID"])] = rec["features"]
    return done


def load_cache_records():
    """Latest cache line for every POINTID, including points that came back empty."""
    latest = {}
    if CACHE.exists():
        for line in CACHE.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rec = json.loads(line)
                latest[str(rec["POINTID"])] = rec
    return latest


def script_catalog():
    """(name, column prefixes) for each data script, in all_data.py's order.
    A point has that characteristic when any stored column starts with '<prefix>_'."""
    import all_data
    catalog = []
    for entry in all_data.SCRIPTS:
        prefixes = []
        for spec in entry["csvs"].values():
            prefix = spec.get("prefix")
            if prefix and prefix not in prefixes:
                prefixes.append(prefix)
        catalog.append((entry["name"], tuple(prefixes)))
    return catalog


def has_prefix(feats, prefix):
    head = prefix + "_"
    return any(str(k).startswith(head) and v not in ("", None) for k, v in (feats or {}).items())


def missing_scripts(feats, catalog):
    """Script names with nothing stored. No features at all means every script is missing."""
    if not has_data(feats):
        return [name for name, _prefixes in catalog]
    return [name for name, prefixes in catalog if not any(has_prefix(feats, p) for p in prefixes)]


def merge_gap(old, new):
    """Keep values already stored. Fill only columns that were empty."""
    out = dict(old or {})
    for k, v in (new or {}).items():
        if k in BASIC_COLUMNS or v in ("", None):
            continue
        if out.get(k) in ("", None):
            out[k] = v
    return out


# --------------------------------------------------------------- batches --
def make_batches(pids, squares, cell, size):
    """Group points by cell x cell degree squares, then split into batches of at most `size`."""
    groups = {}
    for pid in pids:
        coords = json.loads(squares[pid]["square_coords"])
        lon = sum(c[0] for c in coords) / len(coords)
        lat = sum(c[1] for c in coords) / len(coords)
        groups.setdefault((math.floor(lat / cell), math.floor(lon / cell)), []).append(pid)
    batches = []
    for key in sorted(groups):
        g = groups[key]
        n = math.ceil(len(g) / size)                   # equal-sized pieces
        for k in range(n):
            batches.append((key, g[k::n]))
    return batches


def write_request(k, pids, squares, dates):
    """One request JSON for a whole batch: every square with its id and sampling date."""
    feats = [{"coords": json.loads(squares[p]["square_coords"]), "id": p, "date": dates[p].isoformat()}
             for p in pids]
    clouds = [float(squares[p].get("max_cloud") or 20) for p in pids]
    cloud = max(set(clouds), key=clouds.count)
    body = {"features": feats,
            "start": min(dates[p] for p in pids).replace(day=1).isoformat(),   # only for sites without a date
            "end": max(dates[p] for p in pids).isoformat(),
            "max_cloud": int(cloud) if cloud.is_integer() else cloud}
    path = WORK / "requests" / f"batch_{k:05d}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body), encoding="utf-8")
    return path


RETRY_RE = re.compile(r"retry \d+/\d+ in (\d+)s")      # common.retry: "(... failed: ... - retry 1/2 in 5s)"
START_PART = "all_data.py start-up"                   # Python start + imports, before the first script
MERGE_PART = "merging CSVs"                           # all_data.py after its last script
RESULT_PART = "reading results"                       # this script reads the batch's all_data.csv


def run_batch(k, pids, req_path, passthrough, label=None):
    """Run all_data.py for one batch (label: how the batch is named on screen).
    Returns (k, {pid: features or None}, problems, seconds, timing).
    timing = {"parts": {part: seconds}, "retries": {part: [retries, seconds waited]}}, where a part is
    a data script (timed from the '>> name' line all_data.py prints when it starts it) or one of the
    *_PART steps above."""
    out = WORK / f"batch_{k:05d}"
    log = WORK / f"batch_{k:05d}.log"
    names = {f"site{i}": p for i, p in enumerate(pids, 1)}
    to_pid = lambda text: re.sub(r"\bsite(\d+)(?:_polygon)?\b", lambda m: names.get(f"site{m[1]}", m[0]), text)
    cmd = [sys.executable, str(ALL_DATA), "--source", str(req_path), "--out", str(out), *passthrough]
    # UTF-8 output: this script reads it as UTF-8 (Windows would otherwise use the Greek code page).
    env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}
    t0 = time.time()
    problems = []
    step, recent = None, []
    parts, retries = {}, {}                            # timing of this batch
    part, part_t0 = START_PART, t0

    def next_part(name):
        nonlocal part, part_t0
        now = time.time()
        parts[part] = parts.get(part, 0.0) + now - part_t0
        if part not in (START_PART, MERGE_PART, RESULT_PART):     # a data script just finished
            event(label or f"#{k}", f"{part:<20}{C.dim(f'{fmt_s(now - part_t0):>8}')}")
        part, part_t0 = name, now

    event(label or f"#{k}", C.dim(f"started  ({len(pids)} point{'s' * (len(pids) != 1)})"))

    # buffering=1: every line reaches the log at once, so it can be watched while the batch runs.
    # stdin=DEVNULL: a script that asks for input (e.g. an Earthdata login prompt, invisible here
    # because its output goes to the log) fails at once instead of waiting forever.
    with open(log, "w", encoding="utf-8", buffering=1) as fh:
        proc = subprocess.Popen(cmd, cwd=HERE, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                                env=env)
        for line in proc.stdout:
            fh.write(line)
            if (m := RETRY_RE.search(line)):                   # a network call is retried
                r = retries.setdefault(part, [0, 0])
                r[0] += 1
                r[1] += int(m[1])
            if line.startswith(">> "):                         # all_data.py starts the next script
                step, recent = line[3:].split(":")[0].strip(), []
                next_part(step)
            elif line.strip() == "Summary" and part != MERGE_PART:   # all_data.py: last script done
                next_part(MERGE_PART)
            elif line.startswith("!!"):                        # a site or a whole script failed
                msg = line[2:].strip()
                if msg.startswith(f"{step} failed") and recent:   # whole script: add its last error
                    reason = next((l for l in reversed(recent) if "Error" in l or "error" in l), recent[-1])
                    msg += f" - {reason[:160]}"
                problems.append(to_pid(msg))
            elif line.strip() and not line.startswith("="):
                recent = (recent + [line.strip()])[-15:]
        rc = proc.wait()
    next_part(RESULT_PART)

    results = {p: None for p in pids}
    try:
        result = out / "all_data.csv"
        if result.exists():
            for row in read_csv(result):
                pid = names.get(row.pop("site", ""))
                if pid:
                    results[pid] = row if has_data(row) else None
        elif rc != 0:
            problems.append(f"all_data.py failed (exit {rc})")
    finally:
        shutil.rmtree(out, ignore_errors=True)
    if not problems:
        log.unlink(missing_ok=True)
    next_part(None)                                    # closes "reading results"
    return k, results, problems, time.time() - t0, {"parts": parts, "retries": retries}


# ---------------------------------------------------------------- output --
def build_csv(lucas_rows, squares, done):
    """Write finished_dataset.csv from the cache (only points that have data)."""
    lucas_cols = list(lucas_rows[0].keys())
    sq_cols = [c for c in SQUARE_COLUMNS if c not in lucas_cols]
    data_cols = list(dict.fromkeys(c for f in done.values() for c in f))
    taken = set(lucas_cols) | set(sq_cols)
    rename = {c: (f"sq_{c}" if c in taken else c) for c in data_cols}     # avoid name clashes
    columns = [c for c in lucas_cols + sq_cols + [rename[c] for c in data_cols]
               if not any(fnmatch.fnmatchcase(c, d) for d in DROP_COLUMNS)]
    n = 0
    tmp = FINAL_CSV.with_suffix(".tmp")
    with open(tmp, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=columns, restval="", extrasaction="ignore")
        w.writeheader()
        for row in lucas_rows:
            pid = pid_of(row)
            if pid in done:
                sq = squares.get(pid, {})
                w.writerow({**row, **{c: sq.get(c, "") for c in sq_cols},
                            **{rename[c]: v for c, v in done[pid].items()}})
                n += 1
    os.replace(tmp, FINAL_CSV)                         # never leaves a half-written file
    return n, len(columns)


def earthdata_login():
    """Log in to NASA Earthdata once, HERE, where a username/password prompt can be seen and
    answered. persist=True saves the login (.netrc / _netrc in your home folder), so the data
    scripts that run in the background (rain, evapotranspiration) log in from it without asking.
    Returns (ok, text for the screen)."""
    try:
        import earthaccess
    except ImportError:
        return False, "earthaccess is not installed: rain and evapotranspiration will fail"
    try:
        earthaccess.login(persist=True)
        return True, "logged in"
    except Exception as e:                               # the scripts will report their own errors
        return False, f"login failed: {type(e).__name__}: {e}"


def fmt_time(sec):
    h, m = divmod(int(sec) // 60, 60)
    return f"{h}h {m:02d}m" if h else f"{m}m {int(sec) % 60:02d}s"


def fmt_s(sec):
    """Like fmt_time, but with tenths of a second for short times."""
    return f"{sec:.1f}s" if sec < 60 else fmt_time(sec)


# ---------------------------------------------------------------- screen --
WIDTH = 100                                            # width of the rules and tables
LABEL = 16                                             # width of the batch column, e.g. "#12  48°N 14°E"
_PRINT = threading.Lock()                              # batches print from several threads
RUN_T0 = [None]                                        # when the batches started (the "elapsed" column)


class C:
    """Colours on the screen. Off when the output goes to a file or NO_COLOR is set."""
    on = False

    @classmethod
    def setup(cls):
        enc = (getattr(sys.stdout, "encoding", "") or "").lower().replace("-", "")
        if enc != "utf8":                              # e.g. output sent to a file on Windows
            try:
                sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            except (AttributeError, ValueError):
                pass
        cls.on = sys.stdout.isatty() and not os.environ.get("NO_COLOR")
        if cls.on and os.name == "nt":
            os.system("")                              # turns colour codes on in the Windows console

    @classmethod
    def paint(cls, code, text):
        return f"\033[{code}m{text}\033[0m" if cls.on else str(text)

    @classmethod
    def bold(cls, t): return cls.paint("1", t)
    @classmethod
    def dim(cls, t): return cls.paint("2", t)
    @classmethod
    def green(cls, t): return cls.paint("32", t)
    @classmethod
    def yellow(cls, t): return cls.paint("33", t)
    @classmethod
    def red(cls, t): return cls.paint("31", t)
    @classmethod
    def cyan(cls, t): return cls.paint("36", t)


def say(text=""):
    with _PRINT:
        print(text, flush=True)


def banner(text, right=""):
    gap = max(WIDTH - 2 - len(text) - len(right), 1)
    say(C.cyan("═" * WIDTH))
    say(" " + C.bold(text) + " " * gap + C.dim(right))
    say(C.cyan("═" * WIDTH))


def section(text):
    return C.cyan("── ") + C.bold(text.upper()) + " " + C.cyan("─" * max(WIDTH - 4 - len(text), 1))


def row2(k1, v1, k2="", v2=""):
    """Two label/value pairs on one line."""
    left = f"  {k1:<16}{v1:>10}"
    return left + (f"      {k2:<14}{v2}" if k2 else "")


def wrap(text, first, rest):
    return textwrap.fill(text, WIDTH, initial_indent=first, subsequent_indent=rest)


def where(lat, lon):
    return f"{abs(lat):g}°{'N' if lat >= 0 else 'S'} {abs(lon):g}°{'E' if lon >= 0 else 'W'}"


def event(label, text):
    """One line of the progress table: elapsed time, batch, what happened."""
    el = time.time() - RUN_T0[0] if RUN_T0[0] else 0
    say(f"  {C.dim(f'{fmt_time(el):>7}')}   {label:<{LABEL}}  {text}")


def bar(frac, width=16):
    n = max(0, min(width, round(frac * width)))
    return C.cyan("█" * n) + C.dim("░" * (width - n))


def plural(n, word, many=None):
    return f"{n:,} {word if n == 1 else (many or word + 's')}"


def parts_line(parts):
    """The data scripts of one batch with their times; start-up / merging / reading together as 'other'."""
    other = sum(s for p, s in parts.items() if p in (START_PART, MERGE_PART, RESULT_PART))
    shown = [f"{p} {fmt_s(s)}" for p, s in parts.items() if p not in (START_PART, MERGE_PART, RESULT_PART)]
    return " · ".join(shown + [f"other {fmt_s(other)}"])


# ----------------------------------------------------------------- --time --
PHASES = {}                                            # phase of the whole run -> wall-clock seconds


@contextmanager
def timed(name):
    """Add the wall-clock time of a `with` block to PHASES[name]."""
    t = time.time()
    try:
        yield
    finally:
        PHASES[name] = PHASES.get(name, 0.0) + time.time() - t


def report_hints(batch_log, workers, batch_size, busy, part_totals):
    """Advice drawn from the numbers of this run."""
    out = []
    n = len(batch_log)
    points = sum(b["points"] for b in batch_log)
    if n < workers:
        out.append(f"Only {plural(n, 'batch', 'batches')} for {workers} workers, so {workers - n} "
                   f"{'worker' if workers - n == 1 else 'workers'} had nothing to do. A full run has many "
                   f"batches, so every worker stays busy there.")
    if n and points / n < batch_size / 2:
        out.append(f"Batches had {points / n:.1f} points on average (up to {batch_size} allowed). Each batch "
                   f"pays its start-up, log-ins, searches and map openings once for ALL its points, so fuller "
                   f"batches cost less per point. Batches of a full run are usually fuller, so the estimate "
                   f"above is on the high side: for a closer one, run e.g. --limit 200 --time.")
    scripts = {p: s for p, s in part_totals.items() if p not in (START_PART, MERGE_PART, RESULT_PART)}
    if scripts and busy:
        top = max(scripts, key=scripts.get)
        out.append(f"The slowest part is {top}: {100 * scripts[top] / busy:.0f}% of all batch time. "
                   f"It is the one to watch when you compare runs.")
    n_retry = sum(r[0] for b in batch_log for r in b["retries"].values())
    if n_retry:
        waited = sum(r[1] for b in batch_log for r in b["retries"].values())
        by_part = {}
        for b in batch_log:
            for p, r in b["retries"].items():
                by_part[p] = by_part.get(p, 0) + r[0]
        worst = max(by_part, key=by_part.get)
        out.append(f"{plural(n_retry, 'network retry', 'network retries')} ({fmt_s(waited)} spent waiting), "
                   f"most in {worst}: a data site is slow or limiting requests. If this grows, use fewer --workers.")
    elif n >= workers:
        out.append(f"No network retries: the data sites kept up with {workers} batches at a time. "
                   f"You can try --workers {workers + 2} and compare the 'per point' time.")
    return out


def time_report(total, batch_log, workers, remaining, batch_size):
    """The --time report: where the wall-clock time of the run went, then the time of every part
    of the batches (start-up, each data script, merging) added up over all batches, then hints."""
    pct = lambda s, of: f"{100 * s / of:5.1f}%" if of else "    -"
    lines = ["", banner_text("TIME REPORT", f"total {fmt_s(total)}"), "",
             section("Where the time went (wall clock)")]
    run_order = ["reading inputs", "preparing batches", "Earthdata login", "processing batches",
                 "writing finished_dataset.csv"]
    other = max(total - sum(PHASES.values()), 0)
    for name in sorted(PHASES, key=lambda n: run_order.index(n) if n in run_order else len(run_order)):
        s = PHASES[name]
        lines.append(f"  {name:<32}{fmt_s(s):>9}  {pct(s, total)}  {bar(s / total if total else 0)}")
    if other >= 0.1:
        lines.append(f"  {'(other)':<32}{fmt_s(other):>9}  {pct(other, total)}  {bar(other / total)}")
    lines.append(f"  {C.bold('total'):<{32 + len(C.bold(''))}}{C.bold(f'{fmt_s(total):>9}')}")

    part_totals = {}
    busy = 0
    if batch_log:
        wall = PHASES.get("processing batches", 0.0)
        busy = sum(b["secs"] for b in batch_log)
        n_points = sum(b["points"] for b in batch_log)
        by_time = sorted(batch_log, key=lambda b: b["secs"])
        lines += ["", section("Batches")]
        item = lambda k, v: f"  {C.cyan('•')} {k:<16}{v}"
        lines.append(item("finished", f"{len(batch_log)}, up to {workers} at the same time"))
        lines.append(item("time per batch", f"mean {fmt_s(busy / len(batch_log))} · fastest "
                          f"{fmt_s(by_time[0]['secs'])} (#{by_time[0]['k']}) · slowest "
                          f"{fmt_s(by_time[-1]['secs'])} (#{by_time[-1]['k']})"))
        if wall:
            lines.append(item("added up", f"{fmt_s(busy)} = {busy / wall:.1f}× the wall-clock time "
                              f"(batches run at the same time)"))
        if n_points and wall:
            lines.append(item("per point", f"{fmt_s(wall / n_points)} (wall clock)"))
            if remaining:
                lines.append(item("still to do", C.bold(f"{remaining:,} points → about "
                                  f"{fmt_time(wall / n_points * remaining)}") + f" at this speed (--workers {workers})"))

        order = [START_PART] + list(dict.fromkeys(
            p for b in batch_log for p in b["parts"] if p not in (START_PART, MERGE_PART, RESULT_PART))) \
            + [MERGE_PART, RESULT_PART]
        lines += ["", section("Time per part (all batches added up)"),
                  C.dim(f"  {'part':<22}{'total':>9}{'share':>8}  {'':<16}{'mean/batch':>11}"
                        f"{'slowest':>15}{'per point':>11}{'retries':>14}")]
        for part in order:
            have = [b for b in batch_log if part in b["parts"]]
            if not have:
                continue
            tot = sum(b["parts"][part] for b in have)
            part_totals[part] = tot
            slow = max(have, key=lambda b: b["parts"][part])
            pts = sum(b["points"] for b in have)
            n_retry = sum(b["retries"].get(part, [0, 0])[0] for b in have)
            waited = sum(b["retries"].get(part, [0, 0])[1] for b in have)
            retry_txt = f"{n_retry} ({fmt_s(waited)})" if n_retry else "-"
            slow_txt = f"{fmt_s(slow['parts'][part])} #{slow['k']}"
            lines.append(f"  {part:<22}{fmt_s(tot):>9}{pct(tot, busy):>8}  {bar(tot / busy if busy else 0)}"
                         f"{fmt_s(tot / len(have)):>11}{slow_txt:>15}{fmt_s(tot / pts) if pts else '-':>11}"
                         + (C.yellow(f"{retry_txt:>14}") if n_retry else f"{retry_txt:>14}"))

        lines += ["", section("Slowest batches")]
        for b in sorted(batch_log, key=lambda b: -b["secs"])[:5]:
            top = max(((p, s) for p, s in b["parts"].items()), key=lambda kv: kv[1], default=("-", 0))
            lines.append(f"  #{b['k']:<4} {where(b['lat'], b['lon']):<12} {plural(b['points'], 'point'):>10}"
                         f"{fmt_s(b['secs']):>10}   longest part: {top[0]} {fmt_s(top[1])}")

    tips = report_hints(batch_log, workers, batch_size, busy, part_totals) if batch_log else []
    if tips:
        lines += ["", section("Hints")]
        for t in tips:
            lines.append(wrap(t, "  " + C.yellow("→") + " ", "    "))
    lines.append(C.cyan("═" * WIDTH))
    return "\n".join(lines)


def banner_text(text, right=""):
    gap = max(WIDTH - 2 - len(text) - len(right), 1)
    return "\n".join([C.cyan("═" * WIDTH), " " + C.bold(text) + " " * gap + C.dim(right), C.cyan("═" * WIDTH)])


def consume_batches(batches, dates, squares, lucas_rows, passthrough, args, done, batch_log, fill=None):
    """Run the batches. With fill=None, store each result as the point's features (a normal run).
    With fill={pid: old features or None}, keep what was stored and add only columns that were
    missing (--patch); a point that gains nothing is left as it was, so a failed retry cannot
    wipe an earlier good record. Returns (points with no data this time, stopped, points updated)."""
    total, finished, empty, gained = sum(len(b) for _, b in batches), 0, 0, 0
    t_start = time.time()
    RUN_T0[0] = t_start
    csv_before = PHASES.get("writing finished_dataset.csv", 0.0)
    stopped = False
    if batches:
        say()
        say(C.dim("─" * WIDTH))
        say(C.dim(f"  {'elapsed':>7}   {'batch':<{LABEL}}  event"))
        say(C.dim("─" * WIDTH))
    try:
        with ThreadPoolExecutor(args.workers) as ex, open(CACHE, "a", encoding="utf-8") as cache:
            labels = {k: f"#{k:<3} {where(key[0] * args.cell, key[1] * args.cell)}"
                      for k, (key, b) in enumerate(batches, 1)}
            futures = {ex.submit(run_batch, k, b, write_request(k, b, squares, dates), passthrough,
                                 labels[k]): (k, key, b)
                       for k, (key, b) in enumerate(batches, 1)}
            for n_batch, fut in enumerate(as_completed(futures), 1):
                k, key, b = futures[fut]
                try:
                    _, results, problems, secs, timing = fut.result()
                except Exception as e:                       # never stop the whole run
                    results, problems, secs = {p: None for p in b}, [f"{type(e).__name__}: {e}"], 0
                    timing = {"parts": {}, "retries": {}}
                for pid, feats in results.items():
                    if fill is None:
                        cache.write(json.dumps({"POINTID": pid, "ok": feats is not None, "features": feats}) + "\n")
                        if feats is not None:
                            done[pid] = feats
                    else:
                        old = fill.get(pid) or {}
                        merged = merge_gap(old, feats)
                        if merged != old and has_data(merged):
                            cache.write(json.dumps({"POINTID": pid, "ok": True, "features": merged}) + "\n")
                            fill[pid] = merged
                            done[pid] = merged
                            gained += 1
                cache.flush()                               # progress is safe after every batch
                got = sum(f is not None for f in results.values())
                finished += len(results)
                empty += len(results) - got
                for msg in problems[:8]:
                    event(labels[k], C.red("! " + msg[:200]))
                if len(problems) > 8:
                    event(labels[k], C.red(f"! ... {len(problems) - 8} more "
                                           f"(see _dataset_work/batch_{k:05d}.log)"))
                left = total - finished
                eta = (time.time() - t_start) / finished * left if finished else 0
                status = (C.green("FINISHED") if got == len(results) else C.yellow("FINISHED"))
                event(labels[k], f"{status}  {got}/{len(results)} points with data · {fmt_s(secs)}")
                if args.time and timing["parts"]:
                    say(wrap(parts_line(timing["parts"]), " " * (14 + LABEL), " " * (14 + LABEL)))
                say(f"  {'':>7}   {C.cyan('▸')} {C.bold(f'batch {n_batch}/{len(batches)} done')} · "
                    f"{finished:,}/{total:,} points ({100 * finished / total:.0f}%)"
                    + (f" · about {fmt_time(eta)} to go" if left else ""))
                batch_log.append({"k": k, "lat": key[0] * args.cell, "lon": key[1] * args.cell,
                                  "points": len(results), "secs": secs, **timing})
                if n_batch % 10 == 0:                       # keep the CSV fresh during long runs
                    with timed("writing finished_dataset.csv"):
                        build_csv(lucas_rows, squares, done)
    except KeyboardInterrupt:
        stopped = True
        say(C.yellow("\nStopped - progress is saved, run again to continue."))
    # wall-clock time of the batches, without the CSV writes made in between
    PHASES["processing batches"] = PHASES.get("processing batches", 0.0) + (
        time.time() - t_start - (PHASES.get("writing finished_dataset.csv", 0.0) - csv_before))
    return empty, stopped, gained


def prepare_points(pids, lucas, squares):
    """Sampling date for each point. Points with no usable date are dropped."""
    dates, bad = {}, []
    for p in pids:
        try:
            dates[p] = sampling_date(lucas.get(p), squares[p])
        except (ValueError, KeyError):
            bad.append(p)
    return dates, bad


def run_patch(args, lucas, lucas_rows, squares, done, batch_log):
    """Fill characteristics missing on points already in the cache. Nothing past the last
    stored point is fetched, and a point that was never examined is left for a normal run.
    Points that miss the same scripts are fetched together, with only those scripts."""
    catalog = script_catalog()
    known = [name for name, _prefixes in catalog]
    unknown = [n for n in (args.only or []) + (args.skip or []) if n not in known]
    if unknown:
        raise SystemExit(f"Unknown script {', '.join(unknown)}. Available: {', '.join(known)}")
    if args.only:
        catalog = [(n, p) for n, p in catalog if n in args.only]
    if args.skip:
        catalog = [(n, p) for n, p in catalog if n not in args.skip]

    records = load_cache_records()
    order = list(squares)
    last_i = max((i for i, pid in enumerate(order) if pid in records), default=-1)
    say(f"  {'Mode':<16}--patch: missing characteristics on points already stored, no new points")
    if args.limit:
        say(wrap("--limit is ignored: --patch never goes past the points already in the cache.",
                 "  " + C.yellow("→") + " ", "    "))
    if last_i < 0:
        say(wrap("The cache has no stored points yet. Run a normal build first.",
                 "  " + C.yellow("→") + " ", "    "))
        return 0

    frontier = order[:last_i + 1]
    cached = [pid for pid in frontier if pid in records]
    never = len(frontier) - len(cached)
    last_pid = order[last_i]
    say(row2("Last stored", f"{last_i + 1:,} of {len(order):,}", "POINTID", last_pid))
    say(row2("In the cache", f"{len(cached):,}", "Never examined", f"{never:,}"))
    if never:
        say(wrap("Points before that position that were never examined are left for a normal run.",
                 "  " + C.yellow("→") + " ", "    "))

    groups = {}                                        # missing script names -> point ids
    prior = {}                                         # pid -> features already stored (or None)
    per_script = {name: 0 for name, _prefixes in catalog}
    bare = 0
    for pid in cached:
        rec = records[pid]
        feats = rec.get("features") if rec.get("ok") and has_data(rec.get("features")) else None
        missing = missing_scripts(feats, catalog)
        if not missing:
            continue
        if feats is None:
            bare += 1
        for name in missing:
            per_script[name] = per_script.get(name, 0) + 1
        groups.setdefault(tuple(missing), []).append(pid)
        prior[pid] = feats

    n_gap = sum(len(v) for v in groups.values())
    say(row2("With a gap", f"{n_gap:,}", "No data at all", f"{bare:,}"))
    for name, _prefixes in catalog:
        if per_script.get(name):
            say(f"  {'':<16}{name:<22}{per_script[name]:,} points")
    if not groups:
        say(wrap("Every stored point already has every characteristic. Only the CSV is rebuilt.",
                 "  " + C.yellow("→") + " ", "    "))
        return 0

    with timed("Earthdata login"):
        ok, text = earthdata_login()
    say(f"  {'NASA Earthdata':<16}" + (C.green(text) if ok else C.red(text))
        + C.dim(f"   ({fmt_s(PHASES['Earthdata login'])})"))

    empty = gained = 0
    notes = []
    for names, pids in groups.items():
        dates, bad = prepare_points(pids, lucas, squares)
        pids = [p for p in pids if p in dates]
        if bad:
            notes.append(f"{plural(len(bad), 'point')} missing {', '.join(names)} "
                         f"{'has' if len(bad) == 1 else 'have'} no usable sampling date and "
                         f"{'is' if len(bad) == 1 else 'are'} skipped, e.g. {', '.join(bad[:3])}.")
        if not pids:
            continue
        batches = make_batches(pids, squares, args.cell, args.batch_size)
        say()
        say(row2("Fetching", ", ".join(names), "Points", f"{len(pids):,}"))
        say(row2("Batches", f"{len(batches):,}", "At a time", f"up to {args.workers}"))
        part_empty, stopped, part_gained = consume_batches(
            batches, dates, squares, lucas_rows, ["--only", *names], args, done, batch_log, fill=prior)
        empty += part_empty
        gained += part_gained
        if stopped:
            break
    say()
    say(row2("Updated", f"{gained:,}", "", ""))
    if notes:
        for t in notes:
            say(wrap(t, "  " + C.yellow("→") + " ", "    "))
    return empty


# ------------------------------------------------------------------ main --
def main():
    ap = argparse.ArgumentParser(description="Join LUCAS points with all the data of their squares.")
    ap.add_argument("--limit", type=int, help="only the first N points")
    ap.add_argument("--workers", type=int, default=3, help="batches processed at the same time (default 3)")
    ap.add_argument("--batch-size", type=int, default=40, help="max points per batch (default 40)")
    ap.add_argument("--cell", type=float, default=1.0, help="batch area in degrees (default 1.0)")
    ap.add_argument("--rebuild", action="store_true", help="don't run anything, just rebuild the CSV")
    ap.add_argument("--patch", action="store_true",
                    help="don't fetch new points; fill missing characteristics on points already in the cache, "
                         "up to the last one stored, then update the CSV")
    ap.add_argument("--only", nargs="+", metavar="NAME", help="passed to all_data.py")
    ap.add_argument("--skip", nargs="+", metavar="NAME", help="passed to all_data.py")
    ap.add_argument("--time", action="store_true",
                    help="show the time of every part of each batch, and a full time report at the end")
    args = ap.parse_args()
    if args.rebuild and args.patch:
        ap.error("--patch fills missing data, so it cannot be combined with --rebuild")
    C.setup()
    t_run = time.time()
    batch_log = []                                     # one record per finished batch (for --time)

    with timed("reading inputs"):
        squares_csv = pipeline_squares_csv()
        for p in (LUCAS_CSV, squares_csv, ALL_DATA, HERE / "common.py"):
            if not p.exists():
                raise SystemExit(f"Missing {p}")
        lucas_rows = read_csv(LUCAS_CSV)
        lucas = {pid_of(r): r for r in lucas_rows}
        squares = {pid_of(r): r for r in read_csv(squares_csv)}
        done = load_cache()

    banner("BUILD DATASET", time.strftime("%Y-%m-%d %H:%M"))
    say(f"  {'Data folder':<16}{HERE}")
    say(f"  {'Pipeline':<16}{PIPELINE}")
    say()
    say(row2("LUCAS points", f"{len(lucas_rows):,}", "Squares", f"{len(squares):,}"))
    say(row2("Already done", f"{len(done):,}"))

    empty = 0
    if args.rebuild:
        say(f"  {'Mode':<16}--rebuild: only rebuilding finished_dataset.csv, nothing is downloaded")
    elif args.patch:
        empty = run_patch(args, lucas, lucas_rows, squares, done, batch_log)
    else:
        with timed("preparing batches"):
            pids = list(squares)[:args.limit] if args.limit else list(squares)
            pids = [p for p in pids if p not in done]
            dates, bad = prepare_points(pids, lucas, squares)
            pids = [p for p in pids if p in dates]
            batches = make_batches(pids, squares, args.cell, args.batch_size)
            passthrough = (["--only", *args.only] if args.only else []) + (["--skip", *args.skip] if args.skip else [])
        say(row2("To do now", f"{len(pids):,}", "", "") + (C.dim(f"   (--limit {args.limit})") if args.limit else ""))
        say(row2("Batches", f"{len(batches):,}", "At a time", f"up to {args.workers}")
            + C.dim(f"   (≤ {args.batch_size} points, {args.cell:g}° cells)"))
        if passthrough:
            say(f"  {'all_data.py':<16}{' '.join(passthrough)}")
        if pids:
            with timed("Earthdata login"):
                ok, text = earthdata_login()
            say(f"  {'NASA Earthdata':<16}" + (C.green(text) if ok else C.red(text))
                + C.dim(f"   ({fmt_s(PHASES['Earthdata login'])})"))
        notes = []
        if bad:
            notes.append(f"{plural(len(bad), 'point')} without a usable sampling date "
                         f"{'is' if len(bad) == 1 else 'are'} skipped, e.g. {', '.join(bad[:3])}.")
        if batches and len(batches) < args.workers:
            idle = args.workers - len(batches)
            notes.append(f"{plural(len(batches), 'batch', 'batches')} for {args.workers} workers: "
                         f"{idle} {'worker stays' if idle == 1 else 'workers stay'} idle in this run.")
        if not pids:
            notes.append("Nothing to download: every point asked for is done. Only the CSV is rebuilt.")
        if notes:
            say()
            for t in notes:
                say(wrap(t, "  " + C.yellow("→") + " ", "    "))

        empty, _stopped, _gained = consume_batches(
            batches, dates, squares, lucas_rows, passthrough, args, done, batch_log)

    with timed("writing finished_dataset.csv"):
        n, cols = build_csv(lucas_rows, squares, done)
    say()
    banner("FINISHED", f"total {fmt_s(time.time() - t_run)}")
    say(f"  {'finished_dataset.csv':<22}{n:,} points × {cols} columns")
    say(f"  {'':<22}{C.dim(FINAL_CSV)}")
    if not args.rebuild and empty:
        if args.patch:
            say(wrap(f"{plural(empty, 'point')} still returned nothing for the scripts that were missing. "
                     f"Run --patch again to retry those.", "  " + C.yellow("→") + " ", "    "))
        else:
            say(wrap(f"{plural(empty, 'point')} got no data at all; "
                     f"{'it is' if empty == 1 else 'they are'} retried on the next run.", "  " + C.yellow("→") + " ", "    "))

    if args.time:
        remaining = sum(p not in done for p in squares)
        t_total = time.time() - t_run
        report = time_report(t_total, batch_log, args.workers, remaining, args.batch_size)
        say(report)
        was_on, C.on = C.on, False                     # the saved copy has no colour codes
        plain = time_report(t_total, batch_log, args.workers, remaining, args.batch_size)
        C.on = was_on
        try:
            WORK.mkdir(parents=True, exist_ok=True)
            (WORK / "time_report.txt").write_text(plain.lstrip("\n") + "\n", encoding="utf-8")
            say(C.dim(f"  (saved in {WORK / 'time_report.txt'})"))
        except OSError as e:
            say(C.red(f"  (time report not saved: {e})"))


if __name__ == "__main__":
    main()