# ADR-0002: Best-effort rate limiting; no hard cap yet

**Status:** Accepted for the binding. The IPv6 /64 key was merged in [PR #4](https://github.com/ronail/playtrail/pull/4) and deployed 2026-11-26, not verified there. The hard cap is **undecided**.
**Date:** 2026-11-25 (written up 2026-11-26)

## Context

Registration and uploads use Cloudflare's rate limit binding, which is
approximate and counted per location. One host usually holds a whole IPv6 /64.
On the deployment the register limit **did not hold across new connections**:
over 30 registrations all returned 200
([evidence](../evidence/2026-11-25-security.md)). The cause is not known.

## Decision

- Keep the binding. Key registration by IPv4 address or IPv6 /64.
- Key uploads by `client_id`, counted after the signature check, so nobody can
  use up another client's allowance.
- Treat the register limit as best effort, not as a control to rely on.

## Options considered

| Option | Trade-off | Outcome |
|---|---|---|
| Rate limit binding | No state, no cost; does not hold against a deliberate client | In use |
| WAF rule | Needs a custom domain | Open |
| Durable Object counter | Adds stateful infrastructure | Open |

## Consequences

- A client holding a valid proof can register without a dependable limit.
- Unsigned uploads and rejected requests are not capped and use the daily quota,
  which every Worker in the account shares.
- Junk Play Integrity tokens reach Google. If they count against the decode
  quota (unknown), they could stop Android registration for a day.
- Revisit: choose a hard cap.
