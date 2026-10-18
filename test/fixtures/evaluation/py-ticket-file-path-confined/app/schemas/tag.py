from pydantic import BaseModel, ConfigDict, Field


class TagOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    color: str


class TagCreate(BaseModel):
    name: str = Field(min_length=1, max_length=48, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    color: str = Field("#64748b", pattern=r"^#[0-9a-f]{6}$")


class TicketTags(BaseModel):
    names: list[str] = Field(max_length=20)
