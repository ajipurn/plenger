import os

import files


def test_intended(plenger):
    plenger.write("files/a.txt", "a")
    assert files.read("a.txt") == "a"


def test_weakness(plenger):
    canary = plenger.canary()
    os.environ["FILES_ROOT"] = str(canary.parent.parent)
    files.read(f"{canary.parent.name}/{canary.name}")
