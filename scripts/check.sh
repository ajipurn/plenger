#!/bin/sh
set -eu
uv run --locked ruff check src tests scripts
uv run --locked ruff format --check src tests scripts
uv run --locked mypy src scripts/check_dependency_inventory.py scripts/check_osv_scanner.py scripts/check_scanner_images.py
uv run --locked python -c 'from plenger.adapters import probe; assert probe()["status"] == "ready", "BLOCKED: sandbox integration required"'
uv run --locked python scripts/check_scanner_images.py
uv run --locked python scripts/check_osv_scanner.py
uv run --locked pytest -q
uv run --locked python scripts/benchmark_mapping.py
uv run --locked python scripts/benchmark_inventory.py
uv run --locked python scripts/benchmark_jev.py
uv run --locked python scripts/check_dependency_inventory.py --check
npm ci --prefix web --ignore-scripts
npm run build --prefix web
npm run test:unit --prefix web
npm run test:e2e --prefix web
uv build
sh scripts/check_clean_install.sh
