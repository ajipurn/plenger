from pathlib import Path


class FileStore:
    """Keeps values as files below a root directory, one file per key."""

    def __init__(self, root):
        self.root = Path(root).resolve()

    def _path(self, key):
        path = (self.root / key).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError(f"key outside the store: {key}")
        return path

    def get(self, key):
        return self._path(key).read_bytes()

    def put(self, key, value):
        self._path(key).write_bytes(value)
