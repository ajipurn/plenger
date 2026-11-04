import os


def read(name):
    root = os.path.realpath(os.environ.get("FILES_ROOT", "files"))
    target = os.path.realpath(os.path.join(root, name))
    if not target.startswith(root + os.sep):
        raise ValueError("outside the files folder")
    with open(target, encoding="utf-8") as handle:
        return handle.read()
