import json

from sqlalchemy import text

from plenger.services.application import project_id
from plenger.services.workspace import PROJECT_ID_FILE, initialize, path_project_id
from plenger.storage.database import open_store, reports, save_report


def _store_report(root, run_id="run-before-move"):
    identity = project_id(root)
    engine = open_store(root)
    try:
        save_report(engine, {"run_id": run_id, "project_id": identity, "state": "completed"})
    finally:
        engine.dispose()
    return identity


def test_moving_a_project_keeps_its_identity_and_store(tmp_path):
    original = tmp_path / "original"
    original.mkdir()
    initialize(original)
    identity = _store_report(original)
    assert identity == path_project_id(original)
    assert (original / ".plenger" / PROJECT_ID_FILE).read_text().strip() == identity

    moved = tmp_path / "renamed"
    original.rename(moved)

    assert project_id(moved) == identity
    engine = open_store(moved)
    try:
        assert reports(engine, identity, "run-before-move")["state"] == "completed"
    finally:
        engine.dispose()


def test_store_moved_before_identities_were_persisted_is_adopted(tmp_path):
    original = tmp_path / "legacy"
    original.mkdir()
    initialize(original)
    identity = _store_report(original)
    # Simulate a store written by a release that derived identity only from the path.
    (original / ".plenger" / PROJECT_ID_FILE).unlink()

    moved = tmp_path / "legacy-moved"
    original.rename(moved)
    assert project_id(moved) == path_project_id(moved) != identity

    engine = open_store(moved)
    try:
        assert project_id(moved) == identity
        with engine.connect() as connection:
            rows = connection.execute(text("SELECT id,root_identity FROM projects")).all()
        assert [tuple(row) for row in rows] == [(identity, identity)]
        stored = reports(engine, identity, "run-before-move")
        assert json.loads(json.dumps(stored))["run_id"] == "run-before-move"
    finally:
        engine.dispose()
