from fastapi import APIRouter, Depends, Path, Query
from sqlalchemy.orm import Session

from app.api.deps import require
from app.core.db import get_session
from app.core.pagination import Page, page_params
from app.core.security import Principal
from app.schemas.common import Listing
from app.schemas.invoice import InvoiceOut, InvoiceSummary
from app.services.invoices import InvoiceService

router = APIRouter(prefix="/invoices", tags=["billing"])


@router.get("", response_model=Listing[InvoiceSummary])
def list_invoices(
    customer_id: int | None = Query(None),
    page: Page = Depends(page_params),
    principal: Principal = Depends(require("billing:read")),
    session: Session = Depends(get_session),
):
    invoices, total = InvoiceService(session, principal).list(customer_id, page)
    return Listing(items=invoices, total=total, limit=page.limit, offset=page.offset)


@router.get("/{number}", response_model=InvoiceOut)
def get_invoice(
    number: str = Path(pattern=r"^[A-Za-z]{2,8}-\d{4,10}$"),
    principal: Principal = Depends(require("billing:read")),
    session: Session = Depends(get_session),
):
    return InvoiceService(session, principal).by_number(number)


@router.post("/{invoice_id}/void", response_model=InvoiceSummary)
def void_invoice(
    invoice_id: int,
    principal: Principal = Depends(require("billing:manage")),
    session: Session = Depends(get_session),
):
    return InvoiceService(session, principal).void(invoice_id)
