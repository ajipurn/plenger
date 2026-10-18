from app.models.business_hours import BusinessHours
from app.repositories.base import OrgRepository


class BusinessHoursRepository(OrgRepository[BusinessHours]):
    model = BusinessHours

    def current(self) -> BusinessHours | None:
        return self.session.scalars(self.scoped()).first()
