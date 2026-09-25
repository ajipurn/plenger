"""Managed scanner setup, staging, and baseline orchestration.

Project configuration cannot select binaries, images, or grant network access.
The manifest in ``.plenger`` is written only by explicit setup commands and is
revalidated against the managed binary or digest-pinned image and the offline
OSV database before every baseline run.
"""
