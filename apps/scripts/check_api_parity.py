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
        url = base.rstrip('/') + ep
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
    if w.get('status') != l.get('status'):
        ok = False
        print('DIFF STATUS:', r['endpoint'], 'worker=', w.get('status'), 'local=', l.get('status'))

if not ok:
    sys.exit(2)
print('API parity: OK')
