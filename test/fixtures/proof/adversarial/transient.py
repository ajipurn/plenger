import os

import files


def keep(path):
    return path


def test_intended(plenger):
    plenger.write("files/a.txt", "a")
    assert files.read("a.txt") == "a"


def test_weakness(plenger):
    original = os.path.realpath
    os.path.realpath = keep
    try:
        canary = plenger.canary()
        os.environ["FILES_ROOT"] = str(plenger.base())
        files.read(f"../{canary.parent.name}/{canary.name}")
    finally:
        os.path.realpath = original
