#!/usr/bin/env python3
"""Grade calibration runs against the §5 acceptance criteria.

  python3 tools/score.py <dir-of-pace-outputs>
"""
import os, re, sys

D = sys.argv[1]
# criterion -> (label, low, high)  ; None bound = unbounded
CRIT = {
    'tier4':  ('A1 tier 4',        0,  2),
    'tier7':  ('A2 tier 7',        5,  9),
    'tier10': ('A3 tier 10',      18, 25),
    'tier13': ('A4 tier 13',      28, 45),
    'mig1':   ('A5 migrate 1',     4,  8),
    'sing1':  ('A6 singularity 1',11, 21),
}

def parse(path):
    txt = open(path).read()
    r = {'file': os.path.basename(path)[:-4]}
    for i in range(14):
        m = re.search(r'tier\s+%d\s+\S.*?(day ([\d.]+)|NOT REACHED)' % i, txt)
        r['tier%d' % i] = None if (not m or m.group(2) is None) else float(m.group(2))
    for key, pat in (('mig1', 'migrate1'), ('sing1', 'singularity1')):
        m = re.search(pat + r'\s+(day ([\d.]+)|NOT REACHED)', txt)
        r[key] = None if (not m or m.group(2) is None) else float(m.group(2))
    m = re.search(r'boost uptime in-session: ([\d.]+)%', txt)
    r['boost'] = float(m.group(1)) if m else None
    m = re.search(r'overheats: (\d+)', txt)
    r['overheat'] = int(m.group(1)) if m else None
    # last data row: sing count + shard tree %
    # split the table rows on '|' by NAME rather than by positional regex -
    # the column set has changed twice during calibration and a positional
    # match silently read `lvl` as the singularity count.
    hdr = re.search(r'^ day \|(.*)$', txt, re.M)
    r['singCount'] = r['treePct'] = None
    if hdr:
        cols = [c.strip() for c in ('day|' + hdr.group(1)).split('|')]
        body = [l for l in txt.split('\n') if re.match(r'^\s*\d+ \|', l)]
        if body:
            cells = [c.strip() for c in body[-1].split('|')]
            if len(cells) == len(cols):
                d = dict(zip(cols, cells))
                r['singCount'] = int(d.get('sing', 0))
                r['treePct'] = int(d.get('shardTree', '0%').rstrip('%'))
    return r

def grade(r):
    hits, out = 0, []
    for k, (label, lo, hi) in CRIT.items():
        v = r.get(k)
        if v is None:
            out.append((label, '—', 'MISS'))
        elif lo <= v <= hi:
            hits += 1
            out.append((label, 'd%g' % v, 'ok'))
        else:
            out.append((label, 'd%g' % v, 'fast' if v < lo else 'slow'))
    # A7 singularities 2-4 ; A8 tree < 40%
    sc, tp = r.get('singCount'), r.get('treePct')
    if sc is not None and 2 <= sc <= 4:
        hits += 1; out.append(('A7 sing count', str(sc), 'ok'))
    else:
        out.append(('A7 sing count', str(sc), 'fast' if (sc or 0) > 4 else 'slow'))
    if tp is not None and tp < 40:
        hits += 1; out.append(('A8 shard tree', '%d%%' % tp, 'ok'))
    else:
        out.append(('A8 shard tree', '%s%%' % tp, 'fast'))
    return hits, out

runs = []
for f in sorted(os.listdir(D)):
    if f.endswith('.txt'):
        try:
            runs.append(parse(os.path.join(D, f)))
        except Exception as e:
            print('parse fail', f, e)

names = [r['file'] for r in runs]
print('\n%-18s' % 'criterion (target)' + ''.join(n.rjust(11) for n in names))
print('-' * (18 + 11 * len(names)))
rowlabels = [c[0] for c in CRIT.values()] + ['A7 sing count', 'A8 shard tree']
graded = {r['file']: dict((g[0], g) for g in grade(r)[1]) for r in runs}
targets = {c[0]: 'd%g-%g' % (c[1], c[2]) for c in CRIT.values()}
targets['A7 sing count'] = '2-4'
targets['A8 shard tree'] = '<40%'
for lab in rowlabels:
    line = ('%-14s%s' % (lab, targets[lab].rjust(4)))[:18].ljust(18)
    for n in names:
        g = graded[n][lab]
        tag = {'ok': '', 'fast': '▲', 'slow': '▼', 'MISS': '✗'}[g[2]]
        line += ('%s%s' % (g[1], tag)).rjust(11)
    print(line)
print('-' * (18 + 11 * len(names)))
score = {r['file']: grade(r)[0] for r in runs}
print('%-18s' % 'PASSED /8' + ''.join(('%d' % score[n]).rjust(11) for n in names))
print('%-18s' % 'boost uptime %' + ''.join(('%.1f' % (r['boost'] or 0)).rjust(11) for r in runs))
print('%-18s' % 'overheats' + ''.join(('%d' % (r['overheat'] or 0)).rjust(11) for r in runs))
print('\n▲ = too fast   ▼ = too slow   ✗ = never reached')
best = max(score, key=lambda k: score[k])
print('\nbest: %s (%d/8)' % (best, score[best]))
