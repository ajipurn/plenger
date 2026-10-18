from fastapi import FastAPI

from app.api.router import api_router
from app.core.db import Base, engine


def create_app() -> FastAPI:
    application = FastAPI(title="Deskline", version="0.14.2")
    application.include_router(api_router)
    return application


def create_schema() -> None:
    """Create missing tables; production databases are migrated separately."""
    import app.models  # noqa: F401  (registers every model on Base.metadata)

    Base.metadata.create_all(engine)


app = create_app()
