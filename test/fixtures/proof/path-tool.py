import tools


def test_intended(plenger):
    tools.NOTES = plenger.folder("notes")
    plenger.write("notes/today.txt", "Buy milk")
    assert tools.read_note.invoke({"name": "today.txt"}) == "Buy milk"


def test_weakness(plenger):
    tools.NOTES = plenger.folder("notes")
    tools.read_note.invoke({"name": str(plenger.canary())})
