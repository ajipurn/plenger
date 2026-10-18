from fastapi import APIRouter

from app.api.routes import (
    audit_events,
    business_hours,
    comments,
    customers,
    invoices,
    macros,
    organizations,
    satisfaction,
    sla_policies,
    tags,
    teams,
    tickets,
    users,
)

api_router = APIRouter(prefix="/api/v1")
for module in (
    organizations,
    users,
    teams,
    customers,
    tickets,
    comments,
    tags,
    macros,
    sla_policies,
    business_hours,
    satisfaction,
    audit_events,
    invoices,
):
    api_router.include_router(module.router)
