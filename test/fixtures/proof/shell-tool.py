import tools


def test_intended(plenger):
    assert tools.run.invoke({"command": "echo ready"}) == "ready\n"


def test_weakness(plenger):
    tools.run.invoke({"command": "echo ready" + plenger.shell_payloads()[0]})
