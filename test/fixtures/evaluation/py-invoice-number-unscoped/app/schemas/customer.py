from pydantic import BaseModel, EmailStr, Field

from app.schemas.common import Record


class CustomerOut(Record):
    email: str
    name: str
    company: str
    phone: str
    notes: str


class CustomerCreate(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=120)
    company: str = Field("", max_length=120)
    phone: str = Field("", max_length=32)


class CustomerUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    company: str | None = Field(None, max_length=120)
    phone: str | None = Field(None, max_length=32)
    notes: str | None = Field(None, max_length=2000)
