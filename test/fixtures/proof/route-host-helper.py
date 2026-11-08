from app import app


def test_intended(plenger):
    response = app.test_client().get("/trace", query_string={"host": "db"})
    assert response.status_code == 200


def test_weakness(plenger):
    app.test_client().get("/trace", query_string={"host": "db" + plenger.shell_payloads()[0]})
