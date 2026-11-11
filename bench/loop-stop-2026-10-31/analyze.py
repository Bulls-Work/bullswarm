"""Review loops in ~/.bullswarm/workflows: how each ended, and what each stop
option would have done. Read-only. Usage: python3 -I analyze.py [since] [until]"""
import json, glob, os, sys, collections

HOME = os.path.expanduser('~/.bullswarm/workflows')
SINCE = sys.argv[1] if len(sys.argv) > 1 else '2026-10-17T04:46:00Z'
UNTIL = sys.argv[2] if len(sys.argv) > 2 else '2026-10-31T04:46:00Z'
SEV = ['everyday', 'edge', 'obscure']


def usd(att):
    return ((att.get('usage') or {}).get('api') or {}).get('usd') or 0.0


def loops_of(state):
    prog = state.get('program') or {}
    loops = ((prog.get('control') or {}).get('loops')) or []
    return {l['id']: l for l in loops if isinstance(l, dict) and 'id' in l}, prog


out = []
for f in sorted(glob.glob(f'{HOME}/*/state.json')):
    try:
        s = json.load(open(f))
    except Exception:
        continue
    started = (s.get('lifecycle') or {}).get('startedAt') or ''
    if not (SINCE <= started < UNTIL):
        continue
    decl, plan = loops_of(s)
    acts = [a for a in (plan.get('actions') or []) if isinstance(a, dict)]
    for n in s.get('controlNodes') or []:
        if n.get('type') != 'loop' or 'findings' not in n:
            continue
        L = decl.get(n['id'], {})
        until = L.get('until') or {}
        if not isinstance(until.get('dry'), int):
            continue
        revs = [a for a in acts if (a.get('areaOf') or {}).get('step') == until.get('step')]
        areas = (revs[0]['areaOf'].get('areas') if revs else []) or []
        per = len(revs) or 1
        loop_steps = set(L.get('steps') or [])
        atts = [a for a in s.get('attempts') or []
                if a.get('actionId') in loop_steps or any(a.get('actionId', '').startswith(x + '-area-') for x in loop_steps)]
        cost = sum(usd(a) for a in atts)
        F = n['findings']
        rounds = F.get('rounds') or []
        sev_by_round = collections.defaultdict(collections.Counter)
        reop_sev = collections.defaultdict(collections.Counter)
        area_find = collections.defaultdict(set)  # round -> areas with a fix-worthy finding
        for k in F.get('known') or []:
            if k.get('inScope') and not k.get('belowFloor'):
                sev_by_round[k['round']][k.get('severity') or 'none'] += 1
                area_find[k['round']].add(k.get('area'))
                for r in k.get('reopened') or []:
                    area_find[r].add(k.get('area'))
                    reop_sev[r][k.get('severity') or 'none'] += 1
        out.append(dict(
            run=s.get('shortId'), file=f, loop=n['id'], status=n.get('status'), reason=n.get('reason'),
            round=n.get('round'), maxRounds=n.get('maxRounds') or L.get('maxRounds'),
            dry=until.get('dry'), floor=until.get('floor', 'edge'), yieldRule=until.get('yield'),
            areas=len(areas), perRound=per, cost=round(cost, 2), runCost=round((s.get('usage') or {}).get('apiUsd') or 0, 2),
            rounds=[dict(r=x['round'], new=x['new'], reopened=x['reopened'], reviewed=x['reviewed'],
                         below=x.get('belowFloor', 0), sev=dict(sev_by_round[x['round']]), reopSev=dict(reop_sev[x['round']]),
                         findAreas=sorted(a for a in area_find[x['round']] if a is not None)) for x in rounds],
        ))

json.dump(out, open('loops.json', 'w'), indent=1)  # written to the current directory
c = collections.Counter((o['status'], o['reason']) for o in out)
print(len(out), 'dry loops in window', SINCE, '..', UNTIL)
for k, v in c.most_common():
    print(' ', v, k)
