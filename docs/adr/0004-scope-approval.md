# ADR 0004 — No configuration-derived authorization

Status: accepted and partially implemented for the local fixed suite.

The config schema rejects every unknown field, including commands, environment,
active and hosted consent. YAML tags, aliases, anchors, duplicate keys and excessive
nesting are rejected. Browser sessions are ephemeral, never loaded from a repository.
Pairing uses a 60-second one-use random code, five attempts maximum, and a lock.
Sessions expire after 30 minutes. Only exact loopback Host/Origin is accepted;
mutations require Origin and authenticated mutations require a CSRF token.

Browser verification also uses an actual page on a second loopback port. This
is cross-origin while remaining same-site, so SameSite is not treated as a
replacement for Origin and CSRF validation. The local Chrome E2E verifies
rejection of a credentialed cross-origin logout and unreadable session data,
alongside one-use pairing and server-side invalidation of a replayed session
cookie after logout. Other browser/platform and expiry matrices remain open.

Plans now expose an immutable preview and project-bound digest. Approval is a
transactional one-use record with actor, acknowledgment, expiry, scope digest and
revocation state; consuming it creates at most one active run. The browser session
is still not active consent. The implementation only enables the local fixed suite;
remote/staging target execution remains blocked until its full acceptance matrix is
available.
