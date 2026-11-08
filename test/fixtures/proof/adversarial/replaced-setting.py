import tools


def test_intended(plenger):
    try:
        tools.run_check.invoke({"name": "status"})
    except FileNotFoundError:
        pass


def test_weakness(plenger):
    tools.CHECKS = {"status": ["sh", "-c", "true" + plenger.shell_payloads()[0]]}
    tools.run_check.invoke({"name": "status"})
