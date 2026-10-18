import mimetypes

INLINE_TYPES = frozenset(
    {
        "application/pdf",
        "image/gif",
        "image/jpeg",
        "image/png",
        "image/webp",
        "text/plain",
    }
)


def media_type(filename: str) -> str:
    """The type to serve a stored file with; anything else downloads as bytes."""
    guessed, _ = mimetypes.guess_type(filename)
    return guessed if guessed in INLINE_TYPES else "application/octet-stream"


def human_size(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{size} B"
