from pathlib import Path


class FileStore:
    """Keeps values as files below a root directory, one file per key."""

    def __init__(self, root):
        self.root = Path(root)

    def get(self, key):
        return (self.root / key).read_bytes()

    def put(self, key, value):
        (self.root / key).write_bytes(value)
