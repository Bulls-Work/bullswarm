#!/usr/bin/env python3
"""Mechanically verify one replay task: red at parent(+check files), green at fixCommit.

usage: verify_task.py <task_dir> <source_repo_path> <tmp_dir>
Reads <task_dir>/task.json; prints one JSON line and writes <task_dir>/verification.json.
"""
import json, os, subprocess, sys, shutil, time


def sh(cmd, cwd, timeout=600, env=None):
    t = time.time()
    try:
        p = subprocess.run(cmd, cwd=cwd, shell=True, capture_output=True, text=True,
                           timeout=timeout, env=env)
        return p.returncode, (p.stdout + p.stderr), time.time() - t
    except subprocess.TimeoutExpired as e:
        return 124, "TIMEOUT", time.time() - t


def main():
    task_dir, src, tmp = sys.argv[1:4]
    t = json.load(open(os.path.join(task_dir, "task.json")))
    clone = os.path.join(tmp, os.path.basename(task_dir.rstrip("/")))
    shutil.rmtree(clone, ignore_errors=True)
    subprocess.run(["git", "clone", "-q", src, clone], check=True)
    env = {k: v for k, v in os.environ.items() if k not in ("FORCE_COLOR", "NO_COLOR")}
    # dependency files must not change between parent and fix
    _, d, _ = sh(f"git diff --name-only {t['parent']} {t['fixCommit']} -- package.json package-lock.json pnpm-lock.yaml", clone)
    res = {"task": os.path.basename(task_dir.rstrip("/")), "depsChanged": d.strip()}
    os.symlink(os.path.join(src, "node_modules"), os.path.join(clone, "node_modules"))
    files = " ".join(t["checkFiles"])
    # the check files come from the red commit if present, else from the fix commit
    tests_from = t.get("testsFrom") or t["fixCommit"]
    subprocess.run(["git", "checkout", "-q", t["parent"]], cwd=clone, check=True)
    subprocess.run(f"git checkout {tests_from} -- {files}", cwd=clone, shell=True, check=True)
    rc, out, dt = sh(t["checkCmd"], clone, t.get("timeoutSec", 600), env)
    res["parent"] = {"exit": rc, "failed": rc != 0, "sec": round(dt, 1), "tail": out[-600:]}
    subprocess.run(["git", "checkout", "-q", "-f", t["fixCommit"]], cwd=clone, check=True)
    subprocess.run(f"git checkout {tests_from} -- {files}", cwd=clone, shell=True, check=True)
    rc, out, dt = sh(t["checkCmd"], clone, t.get("timeoutSec", 600), env)
    res["fix"] = {"exit": rc, "passed": rc == 0, "sec": round(dt, 1), "tail": out[-600:]}
    res["verified"] = res["parent"]["failed"] and res["fix"]["passed"] and not res["depsChanged"]
    json.dump(res, open(os.path.join(task_dir, "verification.json"), "w"), indent=1)
    print(json.dumps({k: (v if not isinstance(v, dict) else {a: b for a, b in v.items() if a != "tail"}) for k, v in res.items()}))


main()
