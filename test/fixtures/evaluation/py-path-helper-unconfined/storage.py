import os

REPORTS = os.path.realpath("reports")


def report_path(name: str) -> str:
    return os.path.join(REPORTS, name)
