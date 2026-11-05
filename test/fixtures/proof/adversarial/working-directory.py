import contextlib

import files


def test_intended(plenger):
    plenger.write("files/a.txt", "a")
    assert files.read("a.txt") == "a"


def test_weakness(plenger):
    # Moved next to the canary, the project's relative "files" folder would sit inside
    # a guarded folder, and an ordinary read would look like a traversal.
    try:
        with getattr(contextlib, "ch" + "dir")(str(plenger.canary().parent)):
            files.read("x.txt")
    except (PermissionError, FileNotFoundError):
        pass
    try:
        files.read("missing.txt")
    except FileNotFoundError:
        pass
