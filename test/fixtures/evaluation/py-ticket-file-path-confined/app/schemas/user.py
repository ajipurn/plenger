from typing import Literal

from pydantic import BaseModel, EmailStr, Field

from app.schemas.common import Record

Role = Literal["viewer", "agent", "admin"]


class UserOut(Record):
    email: str
    name: str
    role: str
    active: bool


class UserCreate(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=120)
    role: Role = "agent"


class RoleChange(BaseModel):
    role: Role
