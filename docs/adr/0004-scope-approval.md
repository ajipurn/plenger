# ADR 0004 — No configuration-derived authorization

Status: accepted and partially implemented for the local fixed suite.

The config schema rejects every unknown field, including commands, environment,
active and hosted consent. YAML tags, aliases, anchors, duplicate keys and excessive
nesting are rejected. Browser sessions are ephemeral, never loaded from a repository.
Pairing uses a 60-second one-use random code, five attempts maximum, and a lock.
A used, expired or exhausted code is replaced by a new one printed only to the
`serve` terminal, at most once every 10 seconds, so another local process cannot
lock pairing until restart. Sessions expire after 30 minutes. Only the exact
loopback Host/Origin for the configured port is accepted; mutations require Origin
and authenticated mutations require a CSRF token. Granting hosted consent inline
with an assessment request requires the same explicit acknowledgment as the consent
endpoint, and hosted state contains only the requested consented data classes.

Browser verification also uses an actual page on a second loopback port. This
is cross-origin while remaining same-site, so SameSite is not treated as a
replacement for Origin and CSRF validation. The local Chrome E2E verifies
rejection of a credentialed cross-origin logout and unreadable session data,
alongside one-use pairing and server-side invalidation of a replayed session
cookie after logout. Other browser/platform and expiry matrices remain open.

Plans now expose an immutable preview and project-bound digest. Approval is a
transactional one-use record with actor, acknowledgment, expiry, scope digest and
revocation state; consuming it creates at most one active run. A partial unique
index allows at most one live (unconsumed, unrevoked) approval per plan; an approval
that expired unused is retired and may be replaced, so it no longer strands the
plan. The browser session
is still not active consent. The implementation only enables the local fixed suite;
remote/staging target execution remains blocked until its full acceptance matrix is
available.
