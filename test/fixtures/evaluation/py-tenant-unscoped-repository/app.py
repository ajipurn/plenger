from fastapi import Depends, FastAPI

from .auth import User, current_user
from .repository import InvoiceRepository

app = FastAPI()
invoices = InvoiceRepository()


@app.get("/invoices/{invoice_id}")
def get_invoice(invoice_id: str, user: User = Depends(current_user)):
    return invoices.get(user, invoice_id)
