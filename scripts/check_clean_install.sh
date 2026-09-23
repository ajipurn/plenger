#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
temporary_root=$(mktemp -d)

cleanup() {
    rm -rf "$temporary_root"
}
trap cleanup EXIT HUP INT TERM

uv build --wheel --out-dir "$temporary_root/dist" --project "$project_root" >/dev/null
wheel=$(find "$temporary_root/dist" -maxdepth 1 -type f -name '*.whl' -print -quit)
if [ -z "$wheel" ]; then
    echo "clean-install probe: wheel was not built" >&2
    exit 1
fi

uv venv "$temporary_root/venv" --python 3.12 >/dev/null
VIRTUAL_ENV="$temporary_root/venv" uv --project "$project_root" sync \
    --locked --active --no-editable --no-dev --no-install-project --offline >/dev/null
uv pip install --python "$temporary_root/venv/bin/python" --no-deps --reinstall "$wheel" >/dev/null

"$temporary_root/venv/bin/plenger" --help >/dev/null
"$temporary_root/venv/bin/python" - "$project_root" <<'PY'
import importlib.metadata
import re
import sys
from pathlib import Path

import plenger

project_root = Path(sys.argv[1]).resolve()
module_path = Path(plenger.__file__).resolve()
package_root = module_path.parent
if project_root in module_path.parents:
    raise SystemExit("clean-install probe imported the source tree")
if importlib.metadata.version("plenger") != "0.1.0":
    raise SystemExit("clean-install probe found the wrong package version")

index = package_root / "ui" / "index.html"
if not index.is_file():
    raise SystemExit("clean-install probe could not find the packaged UI entrypoint")
for asset in re.findall(r'(?:src|href)="(/assets/[^\"]+)"', index.read_text()):
    asset_path = package_root / "ui" / asset.lstrip("/")
    if not asset_path.is_file():
        raise SystemExit(f"clean-install probe could not find packaged asset: {asset}")
PY

printf '%s\n' "clean-install probe passed: $wheel"
