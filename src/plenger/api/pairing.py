"""One-use terminal pairing codes and short-lived browser sessions."""

import secrets
import threading
import time
from collections.abc import Callable

PAIRING_CODE_SECONDS = 60
PAIRING_MAX_ATTEMPTS = 5
PAIRING_ROTATION_COOLDOWN_SECONDS = 10.0


class Sessions:
    """One-use pairing codes shown only in the terminal that started the server.

    With ``announce`` set, a code that is used, expired or out of attempts is
    replaced by a fresh one printed to that terminal (at most once per cooldown),
    so a failed or finished pairing no longer requires restarting the server.
    """

    def __init__(self, announce: Callable[[str], None] | None = None) -> None:
        self.announce = announce
        self.lock = threading.Lock()
        self.sessions: dict[str, tuple[float, str]] = {}
        self._issue_code()

    def _issue_code(self) -> None:
        self.code = secrets.token_urlsafe(24)
        self.deadline = time.monotonic() + PAIRING_CODE_SECONDS
        self.used = False
        self.attempts = 0
        self.rotated_at = time.monotonic()

    def rate_limited(self) -> bool:
        return self.attempts >= PAIRING_MAX_ATTEMPTS

    def exhausted(self) -> bool:
        return (
            self.attempts >= PAIRING_MAX_ATTEMPTS or self.used or time.monotonic() >= self.deadline
        )

    def pair(self, code: str) -> tuple[str, str] | None:
        with self.lock:
            if self.exhausted():
                if (
                    self.announce is not None
                    and time.monotonic() - self.rotated_at >= PAIRING_ROTATION_COOLDOWN_SECONDS
                ):
                    self._issue_code()
                    self.announce(self.code)
                return None
            self.attempts += 1
            if not secrets.compare_digest(code, self.code):
                return None
            self.used = True
            token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            self.sessions[token] = (time.monotonic() + 1800, csrf)
            return token, csrf

    def valid(self, token: str) -> tuple[float, str] | None:
        with self.lock:
            session = self.sessions.get(token)
            if session is None:
                return None
            if time.monotonic() >= session[0]:
                self.sessions.pop(token, None)
                return None
            return session
