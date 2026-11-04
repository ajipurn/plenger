from fastapi.testclient import TestClient

from app.main import app


def test_intended(plenger):
    response = TestClient(app).get("/diagnostics/ping", params={"host": "db.internal"})
    assert response.status_code == 200


def test_weakness(plenger):
    host = "db.internal" + plenger.shell_payloads()[0]
    TestClient(app).get("/diagnostics/ping", params={"host": host})
