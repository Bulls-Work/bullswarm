#!/usr/bin/env python3
"""Self-test for run_trial.py with a fake `claude` (no model calls, no network).

Builds a throw-away source repo (bad -> red test -> fix), two tasks, and a fake `claude` that
fixes task 01 only, writes a transcript under a temp claude home, and (arm on) a plugin ledger.
Then runs both arms and checks clone, hidden check, transcript cost, redirects, plugin overhead,
summary and the dry run. Run: python3 bench/te-trial/selftest.py
"""
import io, json, os, shutil, stat, subprocess, sys, tempfile, contextlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import run_trial  # noqa: E402

FAKE = r'''#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
prompt = a[a.index("-p") + 1]
home = os.environ["FAKE_CLAUDE_HOME"]
sid = "sess-" + str(abs(hash(prompt)) % 10**8) if False else "sess-" + ("one" if "FIXME-01" in prompt else "two")
sid += "-" + ("on" if "--plugin-dir" in a else "off")
seen = {"TE_vars": sorted(k for k in os.environ if k.startswith("TE_")),
        "TE_HOME": bool(os.environ.get("TOKENECONOMIZER_HOME")), "args": a[:1] + a[2:3] + a[4:]}
open(os.path.join(home, "seen-" + sid + ".json"), "w").write(json.dumps(seen))
if "FIXME-01" in prompt:
    open("src.txt", "w").write("good\n")
d = os.path.join(home, ".claude", "projects", "-fake-" + sid)
os.makedirs(d, exist_ok=True)
def asst(mid, usage, model, content):
    return {"type": "assistant", "message": {"id": mid, "model": model, "usage": usage, "content": content}}
lines = [
    {"type": "user", "message": {"role": "user", "content": prompt}},
    # streamed message m1: an early partial record, then the final one (the LAST must win)
    asst("m1", {"input_tokens": 1, "output_tokens": 1}, "claude-sonnet-5-5",
         [{"type": "tool_use", "id": "t1", "name": "Edit", "input": {}}]),
    asst("m1", {"input_tokens": 100, "cache_read_input_tokens": 1000, "output_tokens": 50,
                "cache_creation_input_tokens": 500,
                "cache_creation": {"ephemeral_5m_input_tokens": 200, "ephemeral_1h_input_tokens": 300}},
         "claude-sonnet-5-5", [{"type": "tool_use", "id": "t1", "name": "Edit", "input": {}},
                               {"type": "tool_use", "id": "t2", "name": "Bash", "input": {}}]),
    asst("m2", {"input_tokens": 10, "cache_read_input_tokens": 2000, "output_tokens": 20,
                "cache_creation_input_tokens": 400}, "claude-sonnet-5-5", [{"type": "text", "text": "done"}]),
    asst("m3", {"input_tokens": 150000, "output_tokens": 100}, "claude-haiku-5-5", [{"type": "text", "text": "x"}]),
]
if "--plugin-dir" in a:
    lines.insert(3, {"type": "attachment", "attachment": {"type": "hook_additional_context",
                     "content": ["Process check (automated): so far you've made 9 edits ..."]}})
open(os.path.join(d, sid + ".jsonl"), "w").write("".join(json.dumps(l) + "\n" for l in lines))
if os.environ.get("TOKENECONOMIZER_HOME"):
    st = os.path.join(os.environ["TOKENECONOMIZER_HOME"], "repos", "x")
    os.makedirs(st, exist_ok=True)
    with open(os.path.join(st, "ledger.jsonl"), "a") as fh:
        fh.write(json.dumps({"kind": "overhead", "session_id": sid, "overhead":
                             {"spiral_judge_tokens": 300.0, "spiral_nudge_writer_tokens": 100.0}}) + "\n")
        fh.write(json.dumps({"kind": "session", "session_id": sid, "nudges": 1, "aborts": 0, "turns": 3,
                             "injected_chars": 120, "overhead": {"optimizer_tokens": 0,
                             "spiral_judge_tokens": 50.0, "spiral_nudge_writer_tokens": 0.0}}) + "\n")
        fh.write(json.dumps({"kind": "session", "session_id": "someone-else", "overhead":
                             {"spiral_judge_tokens": 9999}}) + "\n")
    with open(os.path.join(st, "events.jsonl"), "a") as fh:
        fh.write(json.dumps({"kind": "nudge", "session_id": sid}) + "\n")
print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "num_turns": 3,
                  "result": "ok", "session_id": sid, "total_cost_usd": 0.5,
                  "usage": {"input_tokens": 111}}))
'''

fails = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        fails.append(name)


def git(cwd, *a):
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *a], cwd=cwd,
                          check=True, capture_output=True, text=True).stdout.strip()


def main():
    tmp = tempfile.mkdtemp(prefix="te-selftest-")
    try:
        src, tasks, bindir = (os.path.join(tmp, x) for x in ("src", "tasks", "bin"))
        fake_home = os.path.join(tmp, "fakehome")
        for d in (src, tasks, bindir, fake_home):
            os.makedirs(d)
        git(src, "init", "-q")
        open(os.path.join(src, "src.txt"), "w").write("bad\n")
        git(src, "add", "-A"); git(src, "commit", "-qm", "base"); parent = git(src, "rev-parse", "HEAD")
        open(os.path.join(src, "check.sh"), "w").write('test "$(cat src.txt)" = good\n')
        git(src, "add", "-A"); git(src, "commit", "-qm", "red: test"); red = git(src, "rev-parse", "HEAD")
        open(os.path.join(src, "src.txt"), "w").write("good\n")
        git(src, "add", "-A"); git(src, "commit", "-qm", "fix"); fix = git(src, "rev-parse", "HEAD")
        for nn, slug, marker in (("01", "fixable", "FIXME-01"), ("02", "unfixed", "NOFIX-02")):
            d = os.path.join(tasks, f"{nn}-{slug}"); os.makedirs(d)
            json.dump({"repo": "A", "parent": parent, "fixCommit": fix, "testsFrom": red,
                       "checkFiles": ["check.sh"], "checkCmd": "sh check.sh", "timeoutSec": 60},
                      open(os.path.join(d, "task.json"), "w"))
            open(os.path.join(d, "prompt.md"), "w").write(f"Please fix the thing. {marker}\n")
        fake = os.path.join(bindir, "claude")
        open(fake, "w").write(FAKE)
        os.chmod(fake, os.stat(fake).st_mode | stat.S_IXUSR)

        os.environ["PATH"] = bindir + os.pathsep + os.environ["PATH"]
        os.environ["FAKE_CLAUDE_HOME"] = fake_home
        os.environ["TE_JUNK"] = "must-not-leak-into-the-off-arm"
        plugin, te_home = os.path.join(tmp, "plugin"), os.path.join(tmp, "te-home")
        os.makedirs(plugin)
        base = ["--repo", "A", "--tasks", tasks, "--plugin", plugin, "--te-home", te_home,
                "--src", src, "--claude-home", os.path.join(fake_home, ".claude")]

        # ---- dry run: prints commands, creates nothing
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            run_trial.main(base + ["--arm", "on", "--out", os.path.join(tmp, "dry-on"), "--dry-run"])
            run_trial.main(base + ["--arm", "off", "--out", os.path.join(tmp, "dry-off"), "--dry-run"])
        dry = buf.getvalue()
        on_lines = [l for l in dry.splitlines() if "claude" in l and "-p" in l and "dry-on" in l]
        off_lines = [l for l in dry.splitlines() if "claude" in l and "-p" in l and "dry-off" in l]
        check("dry-run on: plugin-dir + TE env shown", len(on_lines) == 2 and all(
            "--plugin-dir" in l and "TE_LOOPGUARD=nudge" in l and "TOKENECONOMIZER_HOME=" in l for l in on_lines))
        check("dry-run off: no plugin-dir, TE unset", len(off_lines) == 2 and all(
            "--plugin-dir" not in l and "TE_LOOPGUARD" not in l for l in off_lines))
        check("dry-run ran nothing", not os.path.exists(os.path.join(tmp, "dry-on", "work")))

        # ---- real runs through the fake claude
        out = {}
        for arm in ("off", "on"):
            out[arm] = os.path.join(tmp, f"out-{arm}")
            with contextlib.redirect_stdout(io.StringIO()):
                rows = run_trial.main(base + ["--arm", arm, "--out", out[arm]])
            r1, r2 = rows
            check(f"{arm}: two tasks ran in order", [r["nn"] for r in rows] == ["01", "02"])
            check(f"{arm}: clone is at the parent, then fixed by claude",
                  open(os.path.join(out[arm], "work", "01", "src.txt")).read() == "good\n"
                  and open(os.path.join(out[arm], "work", "02", "src.txt")).read() == "bad\n")
            check(f"{arm}: hidden check passes for fixed task, fails for unfixed",
                  r1["check_pass"] is True and r2["check_pass"] is False, (r1["check_exit"], r2["check_exit"]))
            ts = r1["transcript_stats"]
            expect = (100 * 2 + 1000 * 0.1 + 200 * 2.5 + 300 * 4 + 50 * 10) / 1e6 \
                + (10 * 2 + 2000 * 0.1 + 400 * 2.5 + 20 * 10) / 1e6 \
                + (150000 * 0.5 + 100 * 2.5) / 1e6
            check(f"{arm}: transcript cost = hand-computed (last usage per id, 5m/1h split, haiku long ctx)",
                  abs(r1["cost_usd"] - expect) < 1e-9, (r1["cost_usd"], expect))
            check(f"{arm}: turns/tools counted (3 messages, Edit+Bash deduped)",
                  r1["turns"] == 3 and ts["tools"] == {"Edit": 1, "Bash": 1}, (r1["turns"], ts["tools"]))
            check(f"{arm}: claude's own result recorded",
                  r1["reported_cost_usd"] == 0.5 and r1["session_id"].startswith("sess-one"))
            seen = json.load(open(os.path.join(fake_home, f"seen-{r1['session_id']}.json")))
            if arm == "off":
                check("off: no TE_* / TOKENECONOMIZER_HOME reached claude, no --plugin-dir",
                      seen["TE_vars"] == [] and not seen["TE_HOME"] and "--plugin-dir" not in seen["args"], seen)
                check("off: no redirects, no plugin block", r1["redirects"] == 0 and "plugin" not in r1)
            else:
                check("on: TE env + TOKENECONOMIZER_HOME reached claude",
                      seen["TE_vars"] == ["TE_LOOPGUARD", "TE_MICROSKILLS", "TE_TOOLPRUNE",
                                          "TE_TOOLPRUNE_QUIET_MINUTES"] and seen["TE_HOME"], seen)
                p = r1["plugin"]
                check("on: redirect counted from transcript", r1["redirects"] == 1, r1["redirects"])
                check("on: plugin overhead = overhead record + session record, other sessions ignored",
                      r1["plugin_overhead_tokens"] == 450.0 and p["nudges"] == 1 and p["injected_chars"] == 120
                      and p["events"] == {"nudge": 1}, p)
            check(f"{arm}: results.jsonl has one line per task",
                  len(open(os.path.join(out[arm], "results.jsonl")).read().splitlines()) == 2)
            summ = open(os.path.join(out[arm], "summary.md")).read()
            check(f"{arm}: summary.md totals", "| **total** | 1/2 |" in summ and "PASS" in summ and "FAIL" in summ, summ)
            check(f"{arm}: pid files written", all(os.path.exists(os.path.join(out[arm], f"pids-{n}.txt")) for n in ("01", "02")))
        check("--only picks tasks", len(run_trial.list_tasks(tasks, {"02"})) == 1)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("\nSELFTEST", "FAILED: " + ", ".join(fails) if fails else "OK")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
