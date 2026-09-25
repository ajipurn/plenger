import pytest

from plenger.services.application import project_id
from plenger.services.workspace import initialize
from plenger.storage import open_store
from plenger.storage.locking import StoreBusy, runtime_lock
from plenger.storage.purge import delete_project_storage


def test_delete_project_storage_is_scoped_and_requires_exact_confirmation(tmp_path):
    initialize(tmp_path)
    engine = open_store(tmp_path)
    engine.dispose()

    private = tmp_path / ".plenger"
    nested = private / "scanners" / "osv"
    nested.mkdir(parents=True)
    (nested / "database.json").write_text("private evidence")
    outside = tmp_path / "outside.txt"
    outside.write_text("retain")
    (private / "outside-link").symlink_to(outside)

    with pytest.raises(ValueError, match="confirmation_mismatch"):
        delete_project_storage(tmp_path, "wrong-project-id")
    assert (private / "state.sqlite3").exists()

    result = delete_project_storage(tmp_path, project_id(tmp_path))

    assert result["status"] == "deleted"
    assert int(result["removed_entries"]) >= 4
    assert (tmp_path / "plenger.yaml").exists()
    assert outside.read_text() == "retain"
    assert not (private / "state.sqlite3").exists()
    assert not (private / "scanners").exists()
    assert not (private / "outside-link").exists()
    assert set(item.name for item in private.iterdir()) <= {
        "worker.lock",
        "migration.lock",
        "server.lock",
    }


def test_delete_project_storage_rejects_a_busy_worker(tmp_path):
    initialize(tmp_path)
    engine = open_store(tmp_path)
    engine.dispose()

    with runtime_lock(tmp_path, "worker.lock", blocking=False):
        with pytest.raises(StoreBusy, match="project_worker_busy"):
            delete_project_storage(tmp_path, project_id(tmp_path))

    assert (tmp_path / ".plenger" / "state.sqlite3").exists()
