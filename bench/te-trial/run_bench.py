#!/usr/bin/env python3
"""Run the frozen eval-suite tasks t1-t4 as single `claude -p` sessions, plugin off or on.

  run_bench.py --arm off|on --suite <bench/eval-suite/tasks> --out <dir> --plugin <TE plugin dir>
               --te-home <dir> [--model claude-sonnet-5-5] [--only t1,t3] [--timeout 3600]

For each task: copy fixture/ to a fresh git repo, replace {cwd} in prompt.md, run one session,
score with the task's check.sh (hidden tests copied in after the run; last line SCORE p/t).
Cost, turns and plugin activity are read exactly as run_trial.py reads them.
"""
import argparse, json, os, re, shutil, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_trial as rt  # noqa: E402


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--arm", choices=["off", "on"], required=True)
    p.add_argument("--suite", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--plugin", required=True)
    p.add_argument("--te-home", required=True)
    p.add_argument("--model", default="claude-sonnet-5-5")
    p.add_argument("--only", default="")
    p.add_argument("--timeout", type=int, default=3600)
    p.add_argument("--claude-home", default=os.path.expanduser("~/.claude"))
    a = p.parse_args(argv)
    a.out, a.te_home, a.suite = map(os.path.abspath, (a.out, a.te_home, a.suite))
    only = [x for x in a.only.split(",") if x]
    os.makedirs(a.out, exist_ok=True)
    rows = []
    for d in sorted(os.listdir(a.suite)):
        tdir = os.path.join(a.suite, d)
        if not os.path.isfile(os.path.join(tdir, "check.sh")):
            continue
        tid = d.split("-")[0]
        if only and tid not in only:
            continue
        work = os.path.join(a.out, "work", tid)
        shutil.rmtree(work, ignore_errors=True)
        shutil.copytree(os.path.join(tdir, "fixture"), work)
        for c in (["git", "init", "-q"], ["git", "add", "-A"],
                  ["git", "-c", "user.name=bench", "-c", "user.email=bench@local", "commit", "-qm", "fixture"]):
            subprocess.run(c, cwd=work, check=True)
        prompt = open(os.path.join(tdir, "prompt.md"), encoding="utf-8").read().replace("{cwd}", work)
        rc, so, se, wall = rt.run(rt.claude_cmd(prompt, a.model, a.arm, a.plugin), cwd=work,
                                  env=rt.claude_env(a.arm, a.te_home), timeout=a.timeout)
        res = dict(task=d, arm=a.arm, model=a.model, wall_sec=round(wall, 1), claude_exit=rc,
                   timed_out=(rc == 124))
        try:
            j = json.loads(so)
        except ValueError:
            j = {}
            res["claude_parse_error"] = rt.tail(so or se, 300)
        sid = j.get("session_id")
        res.update(session_id=sid, reported_cost_usd=j.get("total_cost_usd"),
                   reported_turns=j.get("num_turns"), is_error=j.get("is_error"))
        crc, cso, cse, _ = rt.run(["bash", os.path.join(tdir, "check.sh"), work], timeout=900)
        m = re.search(r"SCORE (\d+)/(\d+)", cso)
        res.update(score_pass=int(m.group(1)) if m else 0, score_total=int(m.group(2)) if m else 0)
        tr = rt.find_transcript(a.claude_home, sid) if sid else None
        if tr:
            st = rt.read_transcript(tr)
            res.update(transcript_stats=st, cost_usd=st["cost_usd"], turns=st["assistant_turns"],
                       redirects=st["redirects_transcript"])
        else:
            res.update(cost_usd=None, transcript_error=f"no transcript for {sid}")
        if a.arm == "on" and sid:
            pa = rt.plugin_activity(a.te_home, sid)
            res.update(plugin=pa, plugin_overhead_tokens=pa["overhead_tokens"],
                       plugin_nudges=max(pa["nudges"], pa["events"].get("nudge", 0)))
        rows.append(res)
        with open(os.path.join(a.out, "results.jsonl"), "a") as fh:
            fh.write(json.dumps(res) + "\n")
        print(f"[{tid}] score={res['score_pass']}/{res['score_total']} cost={res.get('cost_usd')} "
              f"wall={res['wall_sec']}s turns={res.get('turns')}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
