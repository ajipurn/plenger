import subprocess


def ping(binary: str, host: str) -> str:
    result = subprocess.run(
        f"{binary} -c 1 {host}", shell=True, capture_output=True, text=True
    )
    return result.stdout
