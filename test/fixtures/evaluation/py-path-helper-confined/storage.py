import os

REPORTS = os.path.realpath("reports")


def report_path(name: str) -> str:
    path = os.path.realpath(os.path.join(REPORTS, name))
    if not path.startswith(REPORTS + os.sep):
        raise ValueError("outside the reports directory")
    return path
