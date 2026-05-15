from fastapi.testclient import TestClient
from apps.api import main as api_main
c = TestClient(api_main.app)
for path in ['/api/shot_zones?team=DET','/api/lineups?team=DET&top_n=4']:
    r=c.get(path)
    print(path, r.status_code)
    try:
        print(r.json())
    except Exception:
        print(r.text[:2000])
