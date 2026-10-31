"""Counterfactual stop rules over loops.json (analyze.py writes it to the current directory). Read-only."""
import json, sys
L = json.load(open('loops.json'))
ENDED = {'continued', 'dry', 'yield'}
L = [o for o in L if o['status'] == 'passed' and o['reason'] in ENDED]


def fw(r, floor):
    if floor == 'everyday':
        return r['sev'].get('everyday', 0) + r['reopSev'].get('everyday', 0)
    return r['new'] + r['reopened']


def stop_round(o, rule, cap=None):
    """First round after which the rule ends the loop, or None (out of rounds)."""
    rounds = o['rounds']; n = o['areas'] or 1
    per_round_cost = o['cost'] / max(1, len(rounds))
    last_find = 0
    settled = {}  # area -> clean as of its latest review
    for i, r in enumerate(rounds, 1):
        floor = 'everyday' if rule == 'floor' else o['floor']
        f = fw(r, floor)
        if f: last_find = r['r']
        for a in r['reviewed']:
            settled[a] = a not in r['findAreas'] or (rule == 'floor' and f == 0)
        since = [x for x in rounds[:i] if x['r'] > last_find]
        seen = {a for x in since for a in x['reviewed']}
        if rule in ('today', 'floor'):
            if since and len(seen) >= n: return r['r']
        elif rule == 'credit':
            if f == 0 and all(settled.get(a, False) for a in range(n)): return r['r']
        elif rule == 'clean':
            if f == 0: return r['r']
        elif rule == 'cap':
            if since and len(seen) >= n: return r['r']
            if per_round_cost * (i + 1) > cap and i < len(rounds): return r['r']
    return None


def lost(o, at):
    """In-scope findings at or above the loop's floor that rounds after `at` found."""
    return sum(r['new'] for r in o['rounds'] if r['r'] > at)

print(len(L), 'loops that ended (dry, yield, or by a person)')
for rule, cap in [('today', None), ('credit', None), ('clean', None), ('floor', None), ('cap', 10), ('cap', 15), ('cap', 20)]:
    person = auto = saved_rounds = lost_f = 0; saved_usd = 0.0; names = []
    for o in L:
        if rule == 'today':
            at = None if o['reason'] == 'continued' else o['round']
        else:
            at = stop_round(o, rule, cap)
            # rules that only add stops: the yield stop still ends where it did
            if o['reason'] in ('dry', 'yield') and (at is None or at > o['round']): at = o['round']
        if at is None: person += 1; continue
        if o['reason'] == 'continued': auto += 1; names.append(o['run'])
        ran = len(o['rounds'])
        if at < ran:
            saved_rounds += ran - at; saved_usd += o['cost'] / ran * (ran - at); lost_f += lost(o, at)
    label = rule + (f' ${cap}' if cap else '')
    print(f'{label:10} needs a person {person:2} | of today\'s 16 ends by itself {auto:2} | rounds not run {saved_rounds:2} | ~${saved_usd:6.1f} not spent | findings those rounds found {lost_f:3} | {",".join(names)}')
