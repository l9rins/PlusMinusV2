#!/usr/bin/env python3
"""
Simple API parity checker for worker vs local backend.
Run in CI to detect missing endpoints (e.g. /api/full_roster on worker).
"""
import os
import sys
import requests

ENDPOINTS = [
    "/api/full_roster",
    "/api/team_top_players",
    "/api/playerlog",
    "/api/lineups",
    "/api/shot_zones",
]

WORKER = os.environ.get('PM_WORKER', 'https://nba-data-worker.lorenzbarangan112.workers.dev')
LOCAL = os.environ.get('PM_LOCAL_BACKEND', 'http://localhost:8000')

results = []

for ep in ENDPOINTS:
    out = { 'endpoint': ep, 'worker': None, 'local': None }
    for name, base in [('worker', WORKER), ('local', LOCAL)]:
        # supply sample query params for endpoints that require them
        params = ''
        if ep == '/api/full_roster' or ep == '/api/team_top_players':
            params = '?team=LAL&n=10'
        elif ep == '/api/playerlog':
            params = '?player_id=201939'
        elif ep == '/api/lineups' or ep == '/api/shot_zones':
            params = f'?team=LAL'
        url = base.rstrip('/') + ep + params
        try:
            r = requests.get(url, timeout=6)
            out[name] = { 'status': r.status_code }
            try:
                out[name]['keys'] = list(r.json().keys()) if r.headers.get('Content-Type','').startswith('application/json') else []
            except Exception:
                out[name]['keys'] = []
        except Exception as e:
            out[name] = { 'error': str(e) }
    results.append(out)

ok = True
for r in results:
    w = r['worker']
    l = r['local']
    if (not w) or (not l):
        ok = False
        print('MISSING:', r['endpoint'], 'worker=', w, 'local=', l)
        continue
    ws = w.get('status')
    ls = l.get('status')
    # Treat 2xx as success; fail when one side is success and the other is not.
    ws_ok = 200 <= (ws or 0) < 300
    ls_ok = 200 <= (ls or 0) < 300
    if ws_ok != ls_ok:
        ok = False
        print('SERIOUS MISMATCH:', r['endpoint'], 'worker=', ws, 'local=', ls)
    else:
        # Both success or both non-success. If both non-success but different codes, warn only.
        if ws != ls:
            if (ws or 0) >= 500 or (ls or 0) >= 500:
                ok = False
                print('SERVER ERROR DIFF:', r['endpoint'], 'worker=', ws, 'local=', ls)
            else:
                print('WARN: non-fatal diff for', r['endpoint'], 'worker=', ws, 'local=', ls)

if not ok:
    sys.exit(2)
print('API parity: OK')
