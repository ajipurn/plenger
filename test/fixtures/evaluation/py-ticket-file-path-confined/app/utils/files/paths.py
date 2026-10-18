import os
from pathlib import Path

STORAGE_ROOT = Path(os.environ.get("DESKLINE_STORAGE_DIR", "var/storage")).resolve()


def ticket_folder(ticket_id: int) -> Path:
    return STORAGE_ROOT / "tickets" / str(ticket_id)


def avatar_path(user_id: int) -> Path:
    return STORAGE_ROOT / "avatars" / f"{user_id}.png"


def ticket_file_path(ticket_id: int, filename: str) -> Path:
    folder = ticket_folder(ticket_id)
    path = (folder / filename).resolve()
    if not path.is_relative_to(folder):
        raise ValueError("the file name leaves the ticket folder")
    return path
