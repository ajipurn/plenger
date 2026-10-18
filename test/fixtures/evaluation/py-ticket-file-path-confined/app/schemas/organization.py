from pydantic import BaseModel, ConfigDict, Field


class OrganizationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    subdomain: str
    timezone: str
    locale: str
    ticket_prefix: str


class OrganizationUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    timezone: str | None = Field(None, max_length=64)
    locale: str | None = Field(None, pattern=r"^[a-z]{2}(-[A-Z]{2})?$")
    ticket_prefix: str | None = Field(None, pattern=r"^[A-Z]{1,8}$")
