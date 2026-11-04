import app as application


def test_intended(plenger):
    plenger.write("exports/report.csv", "id,total\n1,10\n")
    client = application.app.test_client()
    response = client.get("/exports/download", query_string={"name": "report.csv"})
    assert response.status_code == 200
    assert response.data == b"id,total\n1,10\n"


def test_weakness(plenger):
    client = application.app.test_client()
    client.get("/exports/download", query_string={"name": str(plenger.canary())})
