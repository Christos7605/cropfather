#!/usr/bin/env python3
"""
Compare two versions of temperature.py on the SAME batches, alternating, several rounds:
which is faster, and do they write the same CSVs?

    python bench_temperature.py --old temperature_old.py --new temperature.py
    python bench_temperature.py --old temperature_old.py --new temperature.py --rounds 5

Put it in Data\\temperature\\ next to both versions. It uses the batch requests that
build_dataset.py left in Data\\_dataset_work\\requests\\ (run build_dataset.py once first) and runs
each version exactly as all_data.py does (--onlydata --days 90 --lst-days 60). The order
alternates every round (old, new, then new, old, ...) so a slow minute on the network does not
always fall on the same version. Nothing in your dataset is touched: outputs go to a temporary
folder that is deleted at the end.
"""
import argparse
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
ARGS = ["--onlydata", "--days", "90", "--lst-days", "60"]       # as all_data.py runs it
CSVS = ["temperature.csv", "temperature_passes.csv"]


def run(script, request, out):
    t = time.time()
    p = subprocess.run([sys.executable, str(script), "--source", str(request), "--out", str(out), *ARGS],
                       cwd=script.parent, capture_output=True, text=True, encoding="utf-8", errors="replace",
                       env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    secs = time.time() - t
    retries = p.stdout.count(" - retry ")
    if p.returncode != 0 and not (out / CSVS[0]).exists():
        print(f"      !! {script.name} failed on {request.name}:\n{p.stdout[-800:]}")
    return secs, retries


def main():
    ap = argparse.ArgumentParser(description="Old vs new temperature.py on the same batches.")
    ap.add_argument("--old", required=True, help="previous version, e.g. temperature_old.py")
    ap.add_argument("--new", required=True, help="new version, e.g. temperature.py")
    ap.add_argument("--rounds", type=int, default=3, help="times each version runs each batch (default 3)")
    ap.add_argument("--requests", default=str(HERE.parent / "_dataset_work" / "requests"),
                    help="folder with build_dataset.py's batch_*.json")
    args = ap.parse_args()

    versions = {"old": (HERE / args.old).resolve(), "new": (HERE / args.new).resolve()}
    for v in versions.values():
        if not v.exists():
            raise SystemExit(f"Missing {v}")
    requests = sorted(Path(args.requests).glob("batch_*.json"))
    if not requests:
        raise SystemExit(f"No batch_*.json in {args.requests} - run build_dataset.py once first.")
    print(f"{len(requests)} batch(es) x {args.rounds} round(s) x 2 versions = "
          f"{len(requests) * args.rounds * 2} runs\n")

    times = {"old": [], "new": []}
    retries = {"old": 0, "new": 0}
    same, differ = 0, []
    tmp = Path(tempfile.mkdtemp(prefix="bench_temp_"))
    try:
        for rnd in range(1, args.rounds + 1):
            order = ["old", "new"] if rnd % 2 else ["new", "old"]
            for req in requests:
                line = []
                for v in order:
                    out = tmp / f"{v}_{req.stem}_{rnd}"
                    secs, r = run(versions[v], req, out)
                    times[v].append(secs)
                    retries[v] += r
                    line.append(f"{v} {secs:6.1f}s" + (f" ({r} retries)" if r else ""))
                a, b = tmp / f"old_{req.stem}_{rnd}", tmp / f"new_{req.stem}_{rnd}"
                ok = all((a / c).exists() == (b / c).exists() and
                         (not (a / c).exists() or (a / c).read_bytes() == (b / c).read_bytes()) for c in CSVS)
                same += ok
                if not ok:
                    differ.append(f"round {rnd}, {req.name}")
                print(f"  round {rnd}  {req.stem}:  {'   '.join(line)}   CSVs {'identical' if ok else 'DIFFERENT'}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n" + "=" * 72)
    for v in ("old", "new"):
        t = times[v]
        print(f"  {v}:  median {statistics.median(t):6.1f}s   mean {statistics.fmean(t):6.1f}s   "
              f"fastest {min(t):5.1f}s   slowest {max(t):6.1f}s   retries {retries[v]}")
    m_old, m_new = statistics.median(times["old"]), statistics.median(times["new"])
    print(f"\n  new / old (median): {m_new / m_old:.2f}  ->  "
          + ("new is faster" if m_new < m_old * 0.9 else "old is faster" if m_new > m_old * 1.1
             else "no clear difference (within 10%)"))
    print(f"  CSVs identical in {same} of {same + len(differ)} comparisons"
          + (f"; DIFFERENT: {', '.join(differ)}" if differ else ""))
    print("=" * 72)


if __name__ == "__main__":
    main()