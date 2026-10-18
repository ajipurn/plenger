from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.api.deps import require
from app.core.db import get_session
from app.core.pagination import Page, page_params
from app.core.security import Principal
from app.schemas.common import Listing
from app.schemas.customer import CustomerCreate, CustomerOut, CustomerUpdate
from app.services.customers import CustomerService

router = APIRouter(prefix="/customers", tags=["customers"])


@router.get("", response_model=Listing[CustomerOut])
def list_customers(
    q: str | None = Query(None, max_length=120),
    page: Page = Depends(page_params),
    principal: Principal = Depends(require("customers:read")),
    session: Session = Depends(get_session),
):
    customers, total = CustomerService(session, principal).list(q, page)
    return Listing(items=customers, total=total, limit=page.limit, offset=page.offset)


@router.get("/{customer_id}", response_model=CustomerOut)
def get_customer(
    customer_id: int,
    principal: Principal = Depends(require("customers:read")),
    session: Session = Depends(get_session),
):
    return CustomerService(session, principal).get(customer_id)


@router.post("", response_model=CustomerOut, status_code=status.HTTP_201_CREATED)
def create_customer(
    data: CustomerCreate,
    principal: Principal = Depends(require("customers:write")),
    session: Session = Depends(get_session),
):
    return CustomerService(session, principal).create(data)


@router.patch("/{customer_id}", response_model=CustomerOut)
def update_customer(
    customer_id: int,
    change: CustomerUpdate,
    principal: Principal = Depends(require("customers:write")),
    session: Session = Depends(get_session),
):
    return CustomerService(session, principal).update(customer_id, change)
