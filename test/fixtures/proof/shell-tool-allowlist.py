import tools


def test_intended(plenger):
    try:
        tools.run_check.invoke({"name": "status"})
    except FileNotFoundError:
        pass  # The image has no git; the check still started it.


def test_weakness(plenger):
    tools.run_check.invoke({"name": "status" + plenger.shell_payloads()[0]})
