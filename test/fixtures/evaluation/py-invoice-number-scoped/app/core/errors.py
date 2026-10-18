from fastapi import HTTPException, status


class NotFound(HTTPException):
    def __init__(self, resource: str):
        super().__init__(status.HTTP_404_NOT_FOUND, f"{resource} not found")


class Forbidden(HTTPException):
    def __init__(self, permission: str):
        super().__init__(status.HTTP_403_FORBIDDEN, f"missing permission {permission}")


class Conflict(HTTPException):
    def __init__(self, message: str):
        super().__init__(status.HTTP_409_CONFLICT, message)


class Invalid(HTTPException):
    def __init__(self, message: str):
        super().__init__(status.HTTP_422_UNPROCESSABLE_ENTITY, message)
