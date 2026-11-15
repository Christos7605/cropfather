#!/usr/bin/env python3
"""Watch prediction_runs and run the crop model for each row that reached predict.

The NDVI worker leaves a barren field, or a farmer override, at status "predict".
This process claims that row, writes the four model_data JSON files to a temp
folder, and runs predictor_model.py. It stores the four crop choices.

Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment, then
from backend/.env, then from the repo .env. The same files supply
SALINITY_GEE_KEY and SALINITY_GEE_PROJECT, which the model reads itself.

    python backend/worker/predictor_worker.py          # localhost: via=local only, with a heartbeat
    python backend/worker/predictor_worker.py --once   # one GitHub row: RUN_ID, then exit

--once does not write the heartbeat. A second run that finds the row already
taken exits without running the model again.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent
MODEL = BACKEND / "predictor" / "predictor_model.py"
POLL_SECONDS = 2
MODEL_TIMEOUT_SECONDS = 40 * 60


def read_env_text(path):
    raw = path.read_bytes()
    if raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff"):
        return raw.decode("utf-16")
    return raw.decode("utf-8-sig")


def load_env_file(path):
    if not path.is_file():
        return
    for line in read_env_text(path).splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key, value = text.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


class Rest:
    def __init__(self, url, key):
        self.url = url.rstrip("/")
        self.key = key

    def request(self, method, path, query=None, body=None, representation=False, prefer=None):
        target = self.url + "/rest/v1/" + path
        if query:
            target += "?" + urllib.parse.urlencode(query)
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(target, data=data, method=method)
        req.add_header("apikey", self.key)
        req.add_header("Authorization", "Bearer " + self.key)
        req.add_header("Content-Type", "application/json")
        if representation:
            req.add_header("Prefer", "return=representation")
        elif prefer:
            req.add_header("Prefer", prefer)
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", errors="replace")[:300]
            raise RuntimeError(f"{method} {path} failed ({err.code}): {detail}") from None
        if not raw:
            return None
        return json.loads(raw)

    def beat(self):
        self.request(
            "POST",
            "prediction_worker",
            {"on_conflict": "id"},
            {"id": "predictor", "seen_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
            prefer="resolution=merge-duplicates,return=minimal",
        )


def claim(rest):
    waiting = rest.request(
        "GET",
        "prediction_runs",
        {
            "status": "eq.predict",
            "via": "eq.local",
            "select": "id,field_id",
            "order": "created_at.asc",
            "limit": "1",
        },
    )
    if not waiting:
        return None
    row = waiting[0]
    claimed = rest.request(
        "PATCH",
        "prediction_runs",
        {"id": "eq." + row["id"], "status": "eq.predict", "via": "eq.local"},
        {"status": "scoring"},
        representation=True,
    )
    if not claimed:
        return None
    return claimed[0]


def claim_github(rest, run_id):
    """Claim one dispatched row. None when it is already taken or is not a GitHub row."""
    claimed = rest.request(
        "PATCH",
        "prediction_runs",
        {"id": "eq." + run_id, "status": "eq.predict", "via": "eq.github"},
        {"status": "scoring"},
        representation=True,
    )
    if not claimed:
        return None
    return claimed[0]


def model_data_for(rest, field_id):
    rows = rest.request(
        "GET",
        "model_data",
        {"field_id": "eq." + field_id, "select": "farm_questionnaire,field_questionnaire,seasons,coords"},
    )
    if not rows:
        raise RuntimeError("This field has no model data.")
    return rows[0]


def field_document(raw):
    """Keep maxMonths, and set maxDays to maxMonths × 30 for the model."""
    if not isinstance(raw, dict):
        raise RuntimeError("This field has no questionnaire.")
    answers = dict(raw.get("answers") or {}) if isinstance(raw.get("answers"), dict) else {}
    months = answers.get("maxMonths")
    if isinstance(months, (int, float)) and not isinstance(months, bool):
        answers["maxDays"] = int(round(float(months) * 30))
    document = dict(raw)
    document["answers"] = answers
    return document


def write_inputs(folder, row):
    general = row.get("farm_questionnaire")
    coords = row.get("coords")
    if not isinstance(general, dict):
        raise RuntimeError("This farm has no questionnaire.")
    if not isinstance(coords, dict):
        raise RuntimeError("This field has no coordinates.")
    seasons = row.get("seasons")
    if not isinstance(seasons, list):
        seasons = []
    paths = {
        "general": folder / "general-info.json",
        "field": folder / "field-info.json",
        "seasons": folder / "farmer-seasons.json",
        "coords": folder / "field-coords.json",
    }
    paths["general"].write_text(json.dumps(general, ensure_ascii=False), encoding="utf-8")
    paths["field"].write_text(json.dumps(field_document(row.get("field_questionnaire")), ensure_ascii=False), encoding="utf-8")
    paths["seasons"].write_text(json.dumps(seasons, ensure_ascii=False), encoding="utf-8")
    paths["coords"].write_text(json.dumps(coords, ensure_ascii=False), encoding="utf-8")
    return paths


def run_model(paths, out):
    try:
        return subprocess.run(
            [
                sys.executable,
                str(MODEL),
                "--general", str(paths["general"]),
                "--field", str(paths["field"]),
                "--seasons", str(paths["seasons"]),
                "--coords", str(paths["coords"]),
                "--out", str(out),
            ],
            cwd=str(MODEL.parent),
            capture_output=True,
            text=True,
            timeout=MODEL_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return None


def read_options(path):
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError("The model returned no choices.")
    return {
        key: payload.get(key) if isinstance(payload.get(key), str) else None
        for key in ("economic", "environmental", "mixed", "current")
    }


def finish(rest, run_id, patch):
    rest.request(
        "PATCH",
        "prediction_runs",
        {"id": "eq." + run_id, "status": "eq.scoring"},
        patch,
        representation=True,
    )


def failed(message):
    return {"status": "failed", "error": message[:200]}


def handle(rest, row):
    run_id = row["id"]
    field_id = row["field_id"]
    print(f"predict {run_id} field {field_id}", flush=True)
    try:
        source = model_data_for(rest, field_id)
    except Exception as err:
        finish(rest, run_id, failed(str(err)))
        print(f"  failed before the model: {err}", flush=True)
        return

    with tempfile.TemporaryDirectory(prefix="predict-") as folder:
        folder = Path(folder)
        try:
            paths = write_inputs(folder, source)
        except Exception as err:
            finish(rest, run_id, failed(str(err)))
            print(f"  failed before the model: {err}", flush=True)
            return
        out = folder / "results.json"
        proc = run_model(paths, out)
        if proc is None:
            patch = failed("The prediction timed out.")
        elif proc.returncode != 0 or not out.is_file():
            detail = ((proc.stderr or proc.stdout or "The prediction failed.").strip())
            patch = failed(detail or "The prediction failed.")
        else:
            try:
                patch = {"status": "done", "results": read_options(out), "error": None}
            except (OSError, json.JSONDecodeError, RuntimeError) as err:
                patch = failed(str(err))
    finish(rest, run_id, patch)
    print(f"  {patch['status']}", flush=True)


def run_row(rest, row):
    try:
        handle(rest, row)
    except Exception as err:
        print(f"run failed: {err}", flush=True)
        try:
            finish(rest, row["id"], failed(str(err)))
        except Exception as second:
            print(f"could not store the failure: {second}", flush=True)
            raise SystemExit(1) from None


def once(rest):
    run_id = os.environ.get("RUN_ID", "").strip()
    if not run_id:
        raise SystemExit("Set RUN_ID to the prediction_runs id.")
    row = claim_github(rest, run_id)
    if row is None:
        print(f"predict {run_id} already taken", flush=True)
        return
    run_row(rest, row)


def main():
    parser = argparse.ArgumentParser(description="Run the crop model for prediction_runs in predict.")
    parser.add_argument("--once", action="store_true", help="Score only RUN_ID, then exit. Does not write a heartbeat.")
    args = parser.parse_args()

    load_env_file(BACKEND / ".env")
    load_env_file(BACKEND.parent / ".env")
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        raise SystemExit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment or backend/.env.")
    if not MODEL.is_file():
        raise SystemExit(f"Prediction model not found at {MODEL}.")
    rest = Rest(url, key)

    if args.once:
        once(rest)
        return

    def heartbeat():
        while True:
            try:
                rest.beat()
            except Exception as err:
                print(f"heartbeat failed: {err}", flush=True)
            time.sleep(POLL_SECONDS)

    threading.Thread(target=heartbeat, name="predictor-heartbeat", daemon=True).start()
    print("Watching prediction_runs for the model.", flush=True)
    while True:
        try:
            row = claim(rest)
        except Exception as err:
            print(f"claim failed: {err}", flush=True)
            time.sleep(POLL_SECONDS)
            continue
        if row is None:
            time.sleep(POLL_SECONDS)
            continue
        try:
            handle(rest, row)
        except Exception as err:
            print(f"run failed: {err}", flush=True)
            try:
                finish(rest, row["id"], failed(str(err)))
            except Exception as second:
                print(f"could not store the failure: {second}", flush=True)


if __name__ == "__main__":
    main()
