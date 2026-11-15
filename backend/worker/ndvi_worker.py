#!/usr/bin/env python3
"""Watch prediction_runs and run the NDVI check for each new request.

The page inserts a row with status "ndvi". This process claims it, writes
model_data.coords to a temp file, and runs Data/salt_indexes/ndvi_checker.py.
It stores the checker's vegetated flag and satellite date. It does not run
the prediction model: a barren field, or a farmer override, leaves the row
at "predict" for the page's placeholder phase.

Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment, then
from backend/.env, then from the repo .env. The anon key cannot write the
checker's answer.

    python backend/worker/ndvi_worker.py
"""

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
CHECKER = BACKEND / "Data" / "salt_indexes" / "ndvi_checker.py"
POLL_SECONDS = 2
CHECK_TIMEOUT_SECONDS = 600


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


def outcome(returncode, payload):
    """Columns to store from one checker result. Never invents a vegetation answer."""
    failed = {"status": "failed", "vegetated": None, "observed_on": None}
    if returncode not in (0, 2) or not isinstance(payload, dict):
        return {**failed, "error": "The vegetation check failed."}
    vegetated = payload.get("vegetated")
    observed = payload.get("date")
    if vegetated is None or returncode == 2:
        return {**failed, "error": "No usable satellite date."}
    if not isinstance(observed, str) or len(observed) < 10:
        return {**failed, "error": "The vegetation check returned no date."}
    day = observed[:10]
    if vegetated is True:
        return {"status": "needs_override", "vegetated": True, "observed_on": day, "error": None}
    if vegetated is False:
        return {"status": "predict", "vegetated": False, "observed_on": day, "error": None}
    return {**failed, "error": "The vegetation check returned no answer."}


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
            {"id": "ndvi", "seen_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
            prefer="resolution=merge-duplicates,return=minimal",
        )


def claim(rest):
    waiting = rest.request(
        "GET",
        "prediction_runs",
        {"status": "eq.ndvi", "select": "id,field_id", "order": "created_at.asc", "limit": "1"},
    )
    if not waiting:
        return None
    row = waiting[0]
    claimed = rest.request(
        "PATCH",
        "prediction_runs",
        {"id": "eq." + row["id"], "status": "eq.ndvi"},
        {"status": "running"},
        representation=True,
    )
    if not claimed:
        return None
    return claimed[0]


def coords_for(rest, field_id):
    rows = rest.request(
        "GET",
        "model_data",
        {"field_id": "eq." + field_id, "select": "coords"},
    )
    if not rows or not isinstance(rows[0].get("coords"), dict):
        raise RuntimeError("This field has no coordinates.")
    return rows[0]["coords"]


def run_checker(source, out):
    try:
        return subprocess.run(
            [sys.executable, str(CHECKER), "--source", str(source), "--out", str(out)],
            cwd=str(CHECKER.parent),
            capture_output=True,
            text=True,
            timeout=CHECK_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return None


def finish(rest, run_id, patch):
    rest.request(
        "PATCH",
        "prediction_runs",
        {"id": "eq." + run_id, "status": "eq.running"},
        patch,
        representation=True,
    )


def handle(rest, row):
    run_id = row["id"]
    field_id = row["field_id"]
    print(f"ndvi {run_id} field {field_id}", flush=True)
    try:
        source_json = coords_for(rest, field_id)
    except Exception as err:
        finish(rest, run_id, {**outcome(1, None), "error": str(err)[:200]})
        print(f"  failed before the checker: {err}", flush=True)
        return

    with tempfile.TemporaryDirectory(prefix="ndvi-") as folder:
        folder = Path(folder)
        source = folder / "source.json"
        out = folder / "ndvi_check.json"
        source.write_text(json.dumps(source_json), encoding="utf-8")
        proc = run_checker(source, out)
        if proc is None:
            patch = outcome(1, None)
            patch["error"] = "The vegetation check timed out."
        elif not out.is_file():
            detail = (proc.stderr or proc.stdout or "The vegetation check failed.").strip()
            patch = outcome(proc.returncode, None)
            patch["error"] = detail[:200]
        else:
            try:
                payload = json.loads(out.read_text(encoding="utf-8"))
                first = payload[0] if isinstance(payload, list) and payload else None
            except (OSError, json.JSONDecodeError):
                first = None
            patch = outcome(proc.returncode, first)
            if patch["status"] == "failed" and proc.returncode not in (0, 2):
                detail = (proc.stderr or proc.stdout or patch["error"]).strip()
                patch["error"] = detail[:200]
    finish(rest, run_id, patch)
    print(f"  {patch['status']} vegetated={patch['vegetated']} date={patch['observed_on']}", flush=True)


def main():
    load_env_file(BACKEND / ".env")
    load_env_file(BACKEND.parent / ".env")
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        raise SystemExit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment or backend/.env.")
    if not CHECKER.is_file():
        raise SystemExit(f"NDVI checker not found at {CHECKER}.")
    rest = Rest(url, key)

    def heartbeat():
        while True:
            try:
                rest.beat()
            except Exception as err:
                print(f"heartbeat failed: {err}", flush=True)
            time.sleep(POLL_SECONDS)

    threading.Thread(target=heartbeat, name="ndvi-heartbeat", daemon=True).start()
    print("Watching prediction_runs.", flush=True)
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
                finish(rest, row["id"], {**outcome(1, None), "error": str(err)[:200]})
            except Exception as second:
                print(f"could not store the failure: {second}", flush=True)


if __name__ == "__main__":
    main()
