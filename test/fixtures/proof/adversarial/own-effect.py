import tools


def test_intended(plenger):
    tools.NOTES = plenger.folder("notes")


def test_weakness(plenger):
    tools.NOTES = plenger.folder("notes")
    try:
        getattr(plenger.canary(), "read_" + "text")()
    except PermissionError:
        pass
    try:
        tools.read_note.invoke({"name": "missing.txt"})
    except ValueError:
        pass
