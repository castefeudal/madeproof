# MADEPROOF Threat Model

MADEPROOF is a verification platform: its entire value is **not** being fooled.
This document enumerates the actors, assets, trust boundaries and attack paths
that the architecture defends against.

## Actors

| Actor | Description | Trust |
| --- | --- | --- |
| **Worker/Agent** | The entity claiming completion (AI agent, developer, contractor, automation) | **Untrusted** — may lie, be confused, or be compromised |
| **Human owner** | Account holder who creates projects, contracts, runners | Trusted (auth boundary) |
| **API/Web** | Control plane | Trusted code, untrusted input |
| **Worker process** | Durable queue coordinator | Trusted (server-side) |
| **Runner** | Executes criteria in sandbox | Trusted code, runs untrusted target code |
| **Target code** | Code under verification | **Untrusted** — may be malicious |
| **External attacker** | Network/API attacker | Untrusted |

## Assets to protect

1. **Verdict integrity** — a `VERIFIED` receipt must mean criteria actually passed.
2. **Evidence integrity** — evidence must be genuine artifacts of the check.
3. **Runner isolation** — target code must never escape the sandbox to the host.
4. **Secrets** — DB credentials, runner credential, signing keys, API keys.
5. **Tenancy** — one project's data must not leak to another.
6. **Availability** — queue must survive crashes without losing jobs.

## Trust boundaries

```text
           untrusted                    trusted
   ┌──────────────────┐    auth    ┌──────────────────────────┐
   │ Worker (claims)  │ ─────────▶ │ API / Web (control plane)│──┐
   └──────────────────┘            └──────────────────────────┘  │ never executes
                                                                 │ target code
   ┌──────────────────┐            ┌──────────────────────────┐  │
   │ External attacker │──────────▶│ PostgreSQL (source of    │◀─┘
   └──────────────────┘  network   │ truth, durable queue)    │
                                    └────────────┬─────────────┘
                                                 │ outbound poll only
                                    ┌────────────▼─────────────┐
                                    │ Runner (no DB cred, no   │
                                    │ inbound port)            │
                                    └────────────┬─────────────┘
                                                 │ Bubblewrap sandbox
                                    ┌────────────▼─────────────┐
                                    │ Target code (untrusted)  │
                                    └──────────────────────────┘
```

## Attack paths and mitigations

### 1. Worker lies: "I did it" without doing it
- **Mitigation**: MADEPROOF never trusts the claim. Criteria are executed by the
  Runner independently. Self-reported evidence (`SELF_REPORTED`) can support a
  claim but never produces `VERIFIED` on its own. A criterion passes only when
  its check actually passes.

### 2. Worker submits forged evidence (fake logs/screenshots)
- **Mitigation**: Evidence is provenance-typed. `MACHINE`/`BROWSER`/`COMMAND`
  evidence is produced by the Runner's own execution (digests of real artifacts,
  CDP snapshots). `SELF_REPORTED` evidence is labeled as such and cannot drive a
  verdict to `VERIFIED` alone. Every artifact is hashed; receipts are
  hash-chained and immutable.

### 3. Malicious target code escapes the sandbox
- **Mitigation**: Bubblewrap with user/mount/PID/IPC/UTS/cgroup namespaces,
  non-root user, empty environment (deny by default), network disabled unless a
  check explicitly opts in, disposable workspace, resource limits, process-tree
  kill on timeout. Runner has **no database credential** and **no inbound port**,
  so even a sandbox escape yields no secrets and no persistence.

### 4. Runner is compromised
- **Mitigation**: Runner holds only a workspace-bound, single-use credential
  (`mpr_...`, stored hashed). It polls outbound; nothing connects to it. If a
  runner is compromised, the blast radius is the runner host, not the control
  plane or database. Credentials are revocable; revoked runners cannot replay
  leases (lease tokens are single-use).

### 5. Control plane is tricked into executing code
- **Mitigation**: The API/Web code paths **never import or invoke** the command
  runner. There is no code path from API to execution. The API can only enqueue;
  the Worker coordinates; the Runner executes. Security tests assert that
  control-plane sources do not import host command execution.

### 6. API attacker (auth bypass, IDOR, CSRF, rate abuse)
- **Mitigation**: RBAC on every route; household/workspace tenancy returns 404
  (no enumeration) for cross-boundary access; rate limiting on auth and API;
  audit log; session cookies httpOnly; API keys scoped and revocable.

### 7. Infrastructure failure produces false VERIFIED
- **Mitigation**: **Fail-closed semantics.** A crashed worker → lease expires →
  job reclaimed → re-run. A runner error → criterion `ERROR`, never `PASSED`.
  A missing sandbox → runner refuses to run (in production). There is no
  timeout/crash path that yields `VERIFIED` without all mandatory criteria
  passing. Security/integration tests cover these paths explicitly.

### 8. Receipt tampering / repudiation
- **Mitigation**: Receipts are content-addressed (deterministic digest over
  criterion results and evidence), pinned to run and contract, immutable after
  finalization. Optional Ed25519 signing keys add signatures; labels never imply
  stronger crypto than configured.

### 9. Supply chain (npm dependencies)
- **Mitigation**: Minimal dependency surface — a single runtime dependency
  (`pg`). Everything else is implemented in-repo. `npm audit` clean.

## Out of scope / assumptions

- The human owner's account credentials are the root of trust; phishing/2FA
  bypass is out of scope for the software threat model.
- The host OS and hypervisor are assumed trusted (standard VPS/cloud).
- Side-channel attacks on the sandbox (microarchitectural) are out of scope.
- A malicious **human** reviewer is out of scope: a human can always confirm
  evidence in the UI.

## Security tests

The guarantees above are enforced by `tests/security/`:

- `input-boundaries.test.ts` — URL policy, path traversal, upload bounds.
- `runner-boundary.test.ts` — runner rejects root, symlink escape blocked,
  environment deny-default, strong sandbox fail-closed.
- `authorization.test.ts` — runner credential workspace-bound, revocable,
  lease-token cannot replay; capability escalation blocked.
- `tests/integration/worker-runner.test.ts` — real distributed worker + runner
  execute an isolated command; lease reclaim; no duplicate results.

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.
