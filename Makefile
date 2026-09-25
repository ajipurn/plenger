# Developer entry points. Every Python command runs from the locked environment.
UV := uv run --locked
PY_PATHS := src tests scripts

.DEFAULT_GOAL := help
.PHONY: help install lint format typecheck test test-fast test-integration \
	ui-build ui-test e2e build check clean

help: ## List available targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  %-18s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install locked Python and dashboard dependencies
	uv sync --locked
	npm ci --prefix web --ignore-scripts

lint: ## Lint and verify formatting
	$(UV) ruff check $(PY_PATHS)
	$(UV) ruff format --check $(PY_PATHS)

format: ## Apply safe lint fixes and formatting
	$(UV) ruff check --fix $(PY_PATHS)
	$(UV) ruff format $(PY_PATHS)

typecheck: ## Run mypy --strict on the configured files
	$(UV) mypy

test: ## Run the full Python suite (integration tests skip when Docker/scanners are absent)
	$(UV) pytest -q

test-fast: ## Run Python tests except integration tests
	$(UV) pytest -q -m "not integration"

test-integration: ## Run only integration tests
	$(UV) pytest -q -m integration

ui-build: ## Type-check and build the dashboard into src/plenger/ui
	npm run build --prefix web

ui-test: ## Run dashboard unit tests
	npm run test:unit --prefix web

e2e: ## Run the browser end-to-end test against a disposable project
	npm run test:e2e --prefix web

build: ## Build the wheel and sdist into dist/
	uv build

check: ## Full local gate, including the network-enabled OSV provisioning smoke
	sh scripts/check.sh

clean: ## Remove caches, test output and build artifacts
	rm -rf dist .pytest_cache .mypy_cache .ruff_cache web/test-results web/playwright-report
	find src tests scripts -type d -name __pycache__ -prune -exec rm -rf {} +
