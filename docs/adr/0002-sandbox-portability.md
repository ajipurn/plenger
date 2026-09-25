# ADR 0002 — Offline Docker parser

Status: accepted for the limited static parser. Active fixed-suite cases now use
a separate OS-confined worker process; native Linux clean-host acceptance remains
open.

Use the locally available Python image pinned by repository digest. Runtime uses
`--pull=never`, network none, non-root user, readonly rootfs, dropped capabilities,
no-new-privileges, 512 MiB memory, one CPU, 32 PIDs, no Docker socket, and no target
or home mount. Only the trusted installed parser file is mounted readonly. Input
travels in stdin memory and is not written into Docker logs (`--log-driver=none`).
Stdout and stderr are separately capped at 16 MiB. Worker deadline is 30 seconds.

The host Docker client uses a minimal environment; provider secrets and proxy
variables are not forwarded. Doctor probes image availability, not a complete
platform certification. Runtime sandbox failures never fall back to host parsing.
Tests exercised the real Docker Desktop environment on this macOS host. Linux
active IPC and orphan recovery are verified in the compatibility subset; the
active broker process boundary is not a container or comprehensive syscall
sandbox. Containers and local checks do not resist a compromised host.

Active fixed-suite cases now run under Seatbelt on macOS, allowing only the
per-job broker Unix socket, or under bubblewrap network-namespace isolation on
Linux. The macOS runtime regression verifies broker-socket access and denied
direct loopback TCP. The Linux bubblewrap path and clean-host platform matrix
still require native verification.
