#!/usr/bin/env python3
"""Run one arm (off|on) of one TokenEconomizer trial sequence. Standard library only.

  run_trial.py --repo A|B --arm off|on --tasks <dir> --out <dir> --plugin <TE plugin dir>
               --te-home <dir> [--model claude-sonnet-5-5] [--only 01,03] [--dry-run]
               [--src <source repo>] [--claude-home <dir>]

For every task (in order): fresh clone at the task's parent commit, `claude -p` with the task
prompt, hidden check (checkFiles copied from the fix/red commit, then checkCmd), cost read from
the session transcript, and (arm on) the plugin's own ledger/events for that session.
Outputs: <out>/results.jsonl, <out>/summary.md, <out>/pids-<nn>.txt, <out>/raw/<nn>.json.
"""
import argparse, glob, json, os, re, shlex, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCES = {"A": "/Users/cowcow02/Repo/bullswork/bullswarm",
           "B": "/Users/cowcow02/Repo/notion-in-claude"}

# Anthropic rate card, USD per million tokens. Read from Bullswarm's
# src/providers/claude-code/connector.json (the "claude-sonnet-5-5" and "claude-haiku-5-5"
# model entries, pricingSource https://platform.claude.com/docs/en/about-claude/pricing).
# sonnet-5-5: cache read $0.10 since 2026-10-07 (pricingUpdatedAt 2026-10-07; $0.20 before).
# haiku-5-5: a request whose prompt (input + cache read + cache writes) is over 100,000 tokens
# pays the longContext rates (pricingUpdatedAt 2026-10-09).
RATE_CARD_FILE = "bullswarm/src/providers/claude-code/connector.json"
RATES = [
    (r"^claude-sonnet-5-5(?:\[1m\])?$",
     dict(input=2.0, cache_read=0.1, cw5m=2.5, cw1h=4.0, output=10.0)),
    (r"^claude-haiku-5-5(?:\[1m\])?$",
     dict(input=0.1, cache_read=0.01, cw5m=0.125, cw1h=0.2, output=0.5,
          long=dict(threshold=100000, input=0.5, cache_read=0.05, cw5m=0.625, cw1h=1.0,
                    output=2.5))),
]
OVERHEAD_KEYS = ("optimizer_tokens", "untool_classify_tokens", "untool_judge_tokens",
                 "codex_untool_adapt_tokens", "spiral_judge_tokens", "spiral_nudge_writer_tokens")
# Text TokenEconomizer injects as additionalContext when the loop guard redirects a stuck turn
# (tokeneconomizer/loopguard/rules.py nudge_text; a judge-written nudge has other text and is
# counted from events.jsonl instead).
NUDGE_MARKER = "Process check (automated)"
PLUGIN_MARKER = "TokenEconomizer"
ARM_ON_ENV = {"TE_MICROSKILLS": "on", "TE_TOOLPRUNE": "auto", "TE_TOOLPRUNE_QUIET_MINUTES": "0",
              "TE_LOOPGUARD": "nudge"}


# ------------------------------------------------------------------ cost from the transcript
def rates_for(model):
    for pat, r in RATES:
        if re.match(pat, model or ""):
            return r
    return None


def price(usage, model):
    """USD for one request's usage dict, or None when the model has no rate."""
    r = rates_for(model)
    if r is None:
        return None
    cc = usage.get("cache_creation") or {}
    cw5 = cc.get("ephemeral_5m_input_tokens")
    cw1 = cc.get("ephemeral_1h_input_tokens")
    total_cw = usage.get("cache_creation_input_tokens") or 0
    if cw5 is None and cw1 is None:
        cw5, cw1 = total_cw, 0
    cw5, cw1 = cw5 or 0, cw1 or 0
    inp, cr, out = (usage.get("input_tokens") or 0, usage.get("cache_read_input_tokens") or 0,
                    usage.get("output_tokens") or 0)
    if "long" in r and inp + cr + cw5 + cw1 > r["long"]["threshold"]:
        r = r["long"]
    return (inp * r["input"] + cr * r["cache_read"] + cw5 * r["cw5m"] + cw1 * r["cw1h"]
            + out * r["output"]) / 1e6


def find_transcript(claude_home, session_id):
    hits = glob.glob(os.path.join(claude_home, "projects", "*", f"{session_id}.jsonl"))
    return hits[0] if hits else None


def read_transcript(path):
    """Stats from a session transcript: the LAST usage record per assistant message id."""
    last, tools, tool_ids = {}, {}, set()
    nudges = plugin_ctx = 0
    for line in open(path, encoding="utf-8", errors="replace"):
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
        if rec.get("type") == "assistant" and msg.get("id"):
            if msg.get("usage"):
                last[msg["id"]] = (msg["usage"], msg.get("model"))
            for blk in msg.get("content") or []:
                if isinstance(blk, dict) and blk.get("type") == "tool_use" and blk.get("id") not in tool_ids:
                    tool_ids.add(blk.get("id"))
                    tools[blk.get("name")] = tools.get(blk.get("name"), 0) + 1
        elif rec.get("type") != "assistant":
            if NUDGE_MARKER in line:
                nudges += 1
            if PLUGIN_MARKER in line:
                plugin_ctx += 1
    tok = dict(input=0, cache_creation_5m=0, cache_creation_1h=0, cache_read=0, output=0)
    usd, unpriced = 0.0, []
    for usage, model in last.values():
        cc = usage.get("cache_creation") or {}
        c5, c1 = cc.get("ephemeral_5m_input_tokens"), cc.get("ephemeral_1h_input_tokens")
        if c5 is None and c1 is None:
            c5, c1 = usage.get("cache_creation_input_tokens") or 0, 0
        tok["input"] += usage.get("input_tokens") or 0
        tok["cache_read"] += usage.get("cache_read_input_tokens") or 0
        tok["cache_creation_5m"] += c5 or 0
        tok["cache_creation_1h"] += c1 or 0
        tok["output"] += usage.get("output_tokens") or 0
        p = price(usage, model)
        if p is None:
            if model not in unpriced:
                unpriced.append(model)
        else:
            usd += p
    return dict(transcript=path, assistant_turns=len(last), tool_calls=sum(tools.values()),
                tools=tools, tokens=tok, cost_usd=round(usd, 6), unpriced_models=unpriced,
                redirects_transcript=nudges, plugin_context_lines=plugin_ctx)


# ------------------------------------------------------------------ plugin store
def plugin_activity(te_home, session_id):
    """Side-call overhead and actions the plugin recorded for this session under te_home.

    ledger.jsonl: `session` records (nudges, aborts, injected_chars, effective_tokens, overhead)
    and `overhead` records (a paid background judge call). events.jsonl: one row per action
    (kind nudge / abort / ...). Overhead is in the plugin's token units (effective tokens), not
    dollars; plugin_cost_usd_est prices them at the session model's fresh-input rate."""
    out = dict(overhead_tokens=0.0, overhead_by_key={}, ledger_records=0, events={}, nudges=0,
               aborts=0, injected_chars=0, ledger_files=[], plugin_cost_usd_est=None)
    for root, _dirs, files in os.walk(te_home):
        for name in files:
            if name not in ("ledger.jsonl", "events.jsonl"):
                continue
            path = os.path.join(root, name)
            for line in open(path, encoding="utf-8", errors="replace"):
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if rec.get("session_id") != session_id:
                    continue
                if name == "events.jsonl":
                    k = rec.get("kind") or "?"
                    out["events"][k] = out["events"].get(k, 0) + 1
                    continue
                out["ledger_records"] += 1
                if path not in out["ledger_files"]:
                    out["ledger_files"].append(path)
                if rec.get("kind") == "session":
                    out["nudges"] += int(rec.get("nudges") or 0)
                    out["aborts"] += int(rec.get("aborts") or 0)
                    out["injected_chars"] += int(rec.get("injected_chars") or 0)
                if rec.get("kind") in ("session", "overhead"):
                    for k, v in (rec.get("overhead") or {}).items():
                        if k in OVERHEAD_KEYS and isinstance(v, (int, float)):
                            out["overhead_by_key"][k] = out["overhead_by_key"].get(k, 0) + v
                            out["overhead_tokens"] += v
    return out


# ------------------------------------------------------------------ helpers
def run(cmd, cwd=None, env=None, timeout=None, shell=False):
    t = time.time()
    try:
        p = subprocess.run(cmd, cwd=cwd, env=env, shell=shell, capture_output=True, text=True,
                           timeout=timeout)
        return p.returncode, p.stdout, p.stderr, time.time() - t
    except subprocess.TimeoutExpired as e:
        so = e.stdout.decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        return 124, so, "TIMEOUT after %ss" % timeout, time.time() - t


def list_tasks(tasks_dir, only):
    out = []
    for d in sorted(os.listdir(tasks_dir)):
        full = os.path.join(tasks_dir, d)
        if os.path.isfile(os.path.join(full, "task.json")):
            nn = d.split("-")[0]
            if only and nn not in only:
                continue
            out.append((nn, d, full))
    return out


def claude_cmd(prompt, model, arm, plugin):
    cmd = ["claude", "-p", prompt, "--model", model, "--output-format", "json",
           "--dangerously-skip-permissions"]
    if arm == "on":
        cmd += ["--plugin-dir", plugin]
    return cmd


def claude_env(arm, te_home):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("TE_") and k != "TOKENECONOMIZER_HOME"}
    if arm == "on":
        env.update(ARM_ON_ENV)
        env["TOKENECONOMIZER_HOME"] = te_home
    return env


def stray_processes(out_dir, te_home):
    _, so, _, _ = run(["ps", "-axo", "pid=,command="])
    needles = [os.path.join(out_dir, "work") + os.sep, te_home]
    me = os.getpid()
    found = []
    for ln in so.splitlines():
        ln = ln.strip()
        pid, _, cmd = ln.partition(" ")
        if not pid.isdigit() or int(pid) == me:
            continue
        if any(n and n in cmd for n in needles) and " ps -axo" not in cmd:
            found.append((int(pid), cmd.strip()))
    return found


def tail(s, n=1500):
    return (s or "")[-n:]


# ------------------------------------------------------------------ one task
def run_task(a, nn, dname, tdir, src):
    t = json.load(open(os.path.join(tdir, "task.json")))
    prompt = open(os.path.join(tdir, "prompt.md"), encoding="utf-8").read()
    work = os.path.join(a.out, "work", nn)
    ccmd = claude_cmd(prompt, a.model, a.arm, a.plugin)
    timeout = t.get("timeoutSec") or 1200
    tests_from = t.get("testsFrom") or t["fixCommit"]
    res = dict(task=dname, nn=nn, repo=a.repo, arm=a.arm, model=a.model, parent=t["parent"],
               fixCommit=t["fixCommit"])
    if a.dry_run:
        print(f"[{nn}] git clone {shlex.quote(src)} {shlex.quote(work)} && git -C {work} checkout {t['parent']}")
        print(f"[{nn}] ln -s {src}/node_modules {work}/node_modules")
        shown = ["claude", "-p", "<prompt.md: %d chars>" % len(prompt)] + ccmd[3:]
        envs = (" ".join(f"{k}={v}" for k, v in ARM_ON_ENV.items()) + f" TOKENECONOMIZER_HOME={a.te_home} "
                if a.arm == "on" else "(TE_* and TOKENECONOMIZER_HOME unset) ")
        print(f"[{nn}] cd {work} && {envs}timeout {timeout}s " + " ".join(shlex.quote(x) for x in shown))
        print(f"[{nn}] git -C {work} checkout {tests_from} -- {' '.join(t['checkFiles'])} && {t['checkCmd']}")
        return None

    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(os.path.dirname(work), exist_ok=True)
    subprocess.run(["git", "clone", "-q", src, work], check=True)
    subprocess.run(["git", "checkout", "-q", t["parent"]], cwd=work, check=True)
    if os.path.isdir(os.path.join(src, "node_modules")):
        os.symlink(os.path.join(src, "node_modules"), os.path.join(work, "node_modules"))

    rc, so, se, wall = run(ccmd, cwd=work, env=claude_env(a.arm, a.te_home), timeout=timeout)
    res.update(wall_sec=round(wall, 1), claude_exit=rc, timed_out=(rc == 124))
    os.makedirs(os.path.join(a.out, "raw"), exist_ok=True)
    open(os.path.join(a.out, "raw", f"{nn}.json"), "w").write(
        json.dumps({"stdout": so, "stderr_tail": tail(se)}, indent=1))
    try:
        j = json.loads(so)
    except ValueError:
        j = {}
        res["claude_parse_error"] = tail(so or se, 300)
    sid = j.get("session_id")
    res.update(session_id=sid, reported_cost_usd=j.get("total_cost_usd"), usage=j.get("usage"),
               reported_turns=j.get("num_turns"), is_error=j.get("is_error"))

    # hidden check
    ch = subprocess.run(f"git checkout {tests_from} -- {' '.join(t['checkFiles'])}", cwd=work,
                        shell=True, capture_output=True, text=True)
    if ch.returncode != 0:
        res.update(check_pass=False, check_exit=-1, check_tail="could not copy check files: " + tail(ch.stderr, 300))
    else:
        cenv = {k: v for k, v in os.environ.items() if k not in ("FORCE_COLOR", "NO_COLOR")}
        crc, cso, cse, _ = run(t["checkCmd"], cwd=work, env=cenv, timeout=t.get("timeoutSec") or 600, shell=True)
        res.update(check_pass=(crc == 0), check_exit=crc, check_tail=tail(cso + cse, 800))

    # transcript cost
    tr = find_transcript(a.claude_home, sid) if sid else None
    if tr:
        res["transcript_stats"] = read_transcript(tr)
        res["cost_usd"] = res["transcript_stats"]["cost_usd"]
        res["turns"] = res["transcript_stats"]["assistant_turns"]
        res["redirects"] = res["transcript_stats"]["redirects_transcript"]
    else:
        res.update(transcript_stats=None, cost_usd=None, turns=None, redirects=None,
                   transcript_error=f"no transcript for session {sid} under {a.claude_home}/projects")
    if a.arm == "on" and sid:
        pa = plugin_activity(a.te_home, sid)
        res["plugin"] = pa
        res["plugin_overhead_tokens"] = pa["overhead_tokens"]
        res["plugin_nudges"] = max(pa["nudges"], pa["events"].get("nudge", 0))
        if res.get("redirects") is not None:
            res["redirects"] = max(res["redirects"], res["plugin_nudges"])
    # stray processes
    pids = stray_processes(a.out, a.te_home)
    with open(os.path.join(a.out, f"pids-{nn}.txt"), "w") as fh:
        for pid, cmd in pids:
            fh.write(f"{pid}\t{cmd}\n")
    res["stray_pids"] = [p for p, _ in pids]
    return res


def summarize(a, rows):
    def f(x, nd=4):
        return "n/a" if x is None else (f"{x:.{nd}f}" if isinstance(x, float) else str(x))
    L = [f"# TE trial: repo {a.repo}, arm {a.arm}, model {a.model}", "",
         "| task | pass | cost $ | reported $ | wall s | turns | tool calls | redirects | plugin ovh tok |",
         "|---|---|---|---|---|---|---|---|---|"]
    tot = dict(cost=0.0, rep=0.0, wall=0.0, turns=0, calls=0, red=0, ovh=0.0, passed=0)
    for r in rows:
        ts = r.get("transcript_stats") or {}
        L.append("| {} | {} | {} | {} | {} | {} | {} | {} | {} |".format(
            r["task"], "PASS" if r.get("check_pass") else "FAIL", f(r.get("cost_usd")),
            f(r.get("reported_cost_usd")), f(r.get("wall_sec"), 1), f(r.get("turns")),
            f(ts.get("tool_calls")), f(r.get("redirects")),
            f(r.get("plugin_overhead_tokens"), 0) if a.arm == "on" else "-"))
        tot["cost"] += r.get("cost_usd") or 0
        tot["rep"] += r.get("reported_cost_usd") or 0
        tot["wall"] += r.get("wall_sec") or 0
        tot["turns"] += r.get("turns") or 0
        tot["calls"] += ts.get("tool_calls") or 0
        tot["red"] += r.get("redirects") or 0
        tot["ovh"] += r.get("plugin_overhead_tokens") or 0
        tot["passed"] += 1 if r.get("check_pass") else 0
    L.append("| **total** | {}/{} | {:.4f} | {:.4f} | {:.1f} | {} | {} | {} | {} |".format(
        tot["passed"], len(rows), tot["cost"], tot["rep"], tot["wall"], tot["turns"], tot["calls"],
        tot["red"], f"{tot['ovh']:.0f}" if a.arm == "on" else "-"))
    L += ["", f"Cost = transcript-priced USD (rate card: {RATE_CARD_FILE}); reported = claude's own "
          "total_cost_usd. Plugin overhead is in the plugin's effective-token units, not dollars."]
    stray = [(r["task"], r["stray_pids"]) for r in rows if r.get("stray_pids")]
    if stray:
        L += ["", "Stray processes left after: " + "; ".join(f"{t}: {p}" for t, p in stray)]
    bad = [r["task"] for r in rows if r.get("transcript_error") or r.get("is_error") or r.get("claude_parse_error")]
    if bad:
        L += ["", "Needs a look (no transcript, claude error or unparsable output): " + ", ".join(bad)]
    open(os.path.join(a.out, "summary.md"), "w").write("\n".join(L) + "\n")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True, choices=["A", "B"])
    ap.add_argument("--arm", required=True, choices=["off", "on"])
    ap.add_argument("--tasks", required=True, help="directory holding the nn-slug task folders")
    ap.add_argument("--out", required=True)
    ap.add_argument("--plugin", required=True, help="TokenEconomizer plugin directory")
    ap.add_argument("--te-home", required=True, help="TOKENECONOMIZER_HOME for the on arm")
    ap.add_argument("--model", default="claude-sonnet-5-5")
    ap.add_argument("--only", default="", help="comma list of task numbers, e.g. 01,03")
    ap.add_argument("--src", help="source repo to clone (default: the repo's path in SOURCES)")
    ap.add_argument("--claude-home", default=os.path.join(os.path.expanduser("~"), ".claude"),
                    help="where session transcripts live (default ~/.claude)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    a.out, a.te_home = os.path.abspath(a.out), os.path.abspath(a.te_home)
    a.plugin, a.tasks = os.path.abspath(a.plugin), os.path.abspath(a.tasks)
    src = a.src or SOURCES[a.repo]
    only = {x.strip() for x in a.only.split(",") if x.strip()}
    os.makedirs(a.out, exist_ok=True)
    rows = []
    for nn, dname, tdir in list_tasks(a.tasks, only):
        r = run_task(a, nn, dname, tdir, src)
        if r is None:
            continue
        rows.append(r)
        with open(os.path.join(a.out, "results.jsonl"), "w") as fh:
            for x in rows:
                fh.write(json.dumps(x) + "\n")
        summarize(a, rows)
        print(f"[{nn}] {dname}: check={'PASS' if r.get('check_pass') else 'FAIL'} "
              f"cost={r.get('cost_usd')} wall={r.get('wall_sec')}s turns={r.get('turns')} "
              f"redirects={r.get('redirects')}", flush=True)
    return rows


if __name__ == "__main__":
    main()
