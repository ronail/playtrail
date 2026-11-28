# ADR-0006: Web players register with Google sign-in

**Status:** Accepted. Built 2026-11-28, not deployed. Tested only with tokens signed by a local stand-in.
**Date:** 2026-11-28

## Context

Phase 1 is web only. A release key in a web build can be extracted and used
without a dependable limit ([ADR-0002](0002-best-effort-rate-limiting.md)). See
the [design](../superpowers/specs/2026-11-27-google-signin-design.md).

## Decision

- Web registration takes a Google ID token, issued within 300 s.
- `client_id` is derived from the Google subject with `MASTER_KEY`. Nothing is
  stored.
- The build signature stays only so CI can register.

## Options considered

| Option | Trade-off | Outcome |
|---|---|---|
| ID derived from the Google subject | Logs are filed under a stable pseudonym | Chosen |
| Sign-in, then a random ID | One account registers without limit | Rejected |
| Sign-in plus release key | Keeps the extractable key | Rejected |

## Consequences

- Replaces the "no accounts" choice of
  [ADR-0003](0003-registration-requires-app-proof.md) for web.
- One ID per account; many accounts still give many IDs.
- A privacy policy and erasure requests are now needed.
- No per-player revocation, and rotating `MASTER_KEY` changes every ID.
- Registration depends on Google being reachable.
