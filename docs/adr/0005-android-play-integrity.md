# ADR-0005: Android registers with Play Integrity Standard requests

**Status:** Accepted. In [PR #5](https://github.com/ronail/playtrail/pull/5), not merged or deployed; tested only against a stand-in for Google.
**Date:** 2026-11-26

## Context

The Worker stores no registration state, and a token must not be reusable. Part
of [ADR-0003](0003-registration-requires-app-proof.md).

## Decision

- Standard requests with `requestHash = SHA256(challenge)`; the challenge is a
  stateless HMAC nonce valid for 300 s.
- The Worker decodes the token with Google using a service account
  (`GOOGLE_SA_KEY`).
- Require an allowlisted package and certificate, `PLAY_RECOGNIZED` and
  `MEETS_DEVICE_INTEGRITY`. No debug-build bypass.

## Options considered

| Option | Trade-off | Outcome |
|---|---|---|
| Classic requests | Need nonce storage against replay | Not chosen |
| Standard requests | Per Google's docs, a re-decoded token loses its verdicts, so nothing is stored (not confirmed with a real token) | Chosen |
| Also require `LICENSED` | Would reject real players, such as those not signed in to Play | Not required |

## Consequences

- Android registration depends on Google being reachable (503 means retry).
- Verdicts carry no install ID, so a genuine device can register repeatedly.
- Quota is limited, and exposed to junk tokens
  ([ADR-0002](0002-best-effort-rate-limiting.md)).
- Local and debug builds are not expected to pass.
- Unverified: replay refusal with a real token, and CPU time of the RS256
  signature on a deployment.
