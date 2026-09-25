"""Strict offline contracts for optional scanner binaries and images.

The adapter never downloads databases or loads repository configuration. macOS
host binaries require the default-deny Seatbelt path; other platforms execute
only digest-pinned container images. A managed version and binary/image pin are
required before an optional engine becomes available.
"""
