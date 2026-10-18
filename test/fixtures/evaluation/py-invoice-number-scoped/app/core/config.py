import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    database_url: str
    session_secret: str
    session_max_age: int
    default_page_size: int
    max_page_size: int
    first_response_minutes: int


def load_settings() -> Settings:
    return Settings(
        database_url=os.environ.get("DESKLINE_DATABASE_URL", "sqlite:///deskline.db"),
        session_secret=os.environ["DESKLINE_SESSION_SECRET"],
        session_max_age=int(os.environ.get("DESKLINE_SESSION_MAX_AGE", "43200")),
        default_page_size=25,
        max_page_size=100,
        first_response_minutes=int(os.environ.get("DESKLINE_FIRST_RESPONSE_MINUTES", "240")),
    )


settings = load_settings()
