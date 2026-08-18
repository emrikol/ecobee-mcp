# Future work

## Evaluate a Rust rewrite if memory becomes a constraint

Status: deferred. Keep the production TypeScript implementation until the
measured memory cost causes an operational problem. This is an explicit
architecture decision, not unfinished migration work.

### Current baseline (2026-08-17)

- Production is a bare-metal systemd service using Node 20 and the pinned
  performance fork of the official TypeScript MCP SDK.
- The Pi has 7.6 GiB RAM with approximately 6.1 GiB available and no observed
  swap use or memory pressure.
- Ecobee MCP holds approximately 79 MiB RSS after discovery and a read with the
  lazy SDK runtime, including roughly 37 MiB anonymous memory.
- It is the only Node process on the Pi.
- The deterministic fake-transport benchmark and complete test suite remain
  the parity baseline for release 2.4.0.

### Reconsider Rust when any trigger is met

- The service moves to a Pi or appliance with 1 GiB RAM or less.
- Available system memory remains below 20%, the host experiences memory
  pressure/OOM events, or this service begins swapping.
- Steady-state MCP RSS exceeds 150 MiB or shows repeatable unbounded growth.
- Multiple independent MCP instances must run on the same host.
- A single-binary deployment becomes more valuable than retaining the mature
  TypeScript implementation.

### Migration approach

1. Reconfirm that the current official Rust MCP SDK fully conforms to the
   required protocol revision and pin that revision explicitly.
2. Export the existing 24-tool and 3-resource inventory into a
   language-neutral contract, preserving the canonical schema digest and every
   safety annotation.
3. Build a small candidate containing discovery, health, and one deterministic
   read tool before porting the full Ecobee implementation.
4. Run the TypeScript and Rust candidates against the same fake Ecobee HTTP
   server and compare MCP results plus outbound Ecobee requests.
5. Adapt the existing behavioral scenarios into black-box parity tests for
   protocol negotiation, authentication, schemas, reads, mutations,
   cancellation, deadlines, rate limits, token refresh, ambiguous delivery,
   and credential non-disclosure.
6. Port the remaining tools only after the candidate demonstrates a meaningful
   memory reduction without a latency or throughput regression.
7. Perform a forward-only cutover at the existing endpoint. Do not ship a dual
   implementation or a backward-compatibility layer.

### Acceptance criteria

- All 24 tools and 3 resources remain present with the canonical schema digest
  unchanged and the same read/mutation classifications.
- All existing behavioral scenarios pass without contacting the live Ecobee
  API or performing a real thermostat mutation.
- Official SDK client and conformance verification pass for the selected modern
  protocol revision.
- Steady-state process RSS is at most 25 MiB and complete container-cgroup
  memory, if Podman is used, is at most 35 MiB.
- Deterministic throughput and p95 latency are no worse than the TypeScript
  baseline.
- Deployment remains one self-contained artifact with no production telemetry
  or validation/utility framework dependencies.

### Deployment note

Podman and `podman-compose` are available on the Pi, but neither currently runs
a workload. Containerization should be selected for operational consistency,
not as a memory optimization. A reverse proxy should be added only when it is
shared by multiple services; it does not replace the MCP server's HTTP
transport, cancellation, or deadline handling.
