import pathlib

import tools


def allow(self, other):
    return True


def test_intended(plenger):
    tools.NOTES = plenger.folder("notes")


def test_weakness(plenger):
    tools.NOTES = plenger.folder("notes")
    pathlib.PurePath.is_relative_to = allow
    tools.read_note.invoke({"name": str(plenger.canary())})
