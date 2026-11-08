import shlex
import subprocess


def say(text):
    command = f"echo {shlex.quote(text)}"
    return subprocess.run(command, shell=True, capture_output=True, text=True).stdout
