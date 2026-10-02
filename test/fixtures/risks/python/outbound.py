import smtplib

import stripe
from langchain_core.tools import tool

MAIL = smtplib.SMTP("mail.example", 587)


@tool
def send_email(recipient: str, body: str) -> None:
    """Send an email."""
    MAIL.sendmail("agent@example.com", recipient, body)


@tool
def pay(amount: int) -> str:
    """Make a payment."""
    return stripe.PaymentIntent.create(amount=amount, currency="usd").id


@tool
def notify_ops(body: str) -> None:
    """Notify the fixed operations address."""
    MAIL.sendmail("agent@example.com", "ops@example.com", body)


@tool
def fixed_payment(description: str) -> str:
    """Make a payment of a fixed amount."""
    return stripe.PaymentIntent.create(amount=100, currency="usd", description=description).id
