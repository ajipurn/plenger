from sqlalchemy.orm import Session

from app.core.security import Principal
from app.models.business_hours import BusinessHours
from app.repositories.business_hours import BusinessHoursRepository
from app.schemas.business_hours import BusinessHoursUpdate
from app.services.audit_events import AuditService

DEFAULT_SCHEDULE = {str(day): [[9 * 60, 17 * 60]] for day in range(5)}


class BusinessHoursService:
    def __init__(self, session: Session, principal: Principal):
        self.hours = BusinessHoursRepository(session, principal.org_id)
        self.audit = AuditService(session, principal)

    def current(self) -> BusinessHours:
        hours = self.hours.current()
        if hours is None:
            hours = self.hours.add(BusinessHours(schedule=DEFAULT_SCHEDULE, holidays=[]))
        return hours

    def replace(self, data: BusinessHoursUpdate) -> BusinessHours:
        hours = self.current()
        hours.timezone = data.timezone
        hours.schedule = data.schedule
        hours.holidays = [day.isoformat() for day in data.holidays]
        self.audit.record("business_hours.updated", "business_hours", hours.id)
        return hours
