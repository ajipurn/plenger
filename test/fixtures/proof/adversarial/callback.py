import jobs


def read(path):
    return getattr(path, "read_" + "text")()


def test_intended(plenger):
    assert jobs.run_job(len, "abc") == 3


def test_weakness(plenger):
    jobs.run_job(read, plenger.canary())
