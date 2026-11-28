# ADR-0003: Registration requires proof of one of our builds

**Status:** Accepted. Merged in [PR #6](https://github.com/ronail/playtrail/pull/6) and deployed 2026-11-26 ([evidence](../evidence/2026-11-26-live-checks.md)). Android is not configured; iOS is not built. Superseded for web by [ADR-0006](0006-google-sign-in.md).
**Date:** 2026-11-26

## Context

Only our own apps and builds should be able to register; anyone could. No user
accounts and no bot checks are wanted. A web build cannot keep a secret. See the
[design](../superpowers/specs/2026-11-26-registration-whitelist-design.md).

## Decision

`POST /v1/register` accepts one proof, else 401. Uploads are unchanged.

| Platform | Proof |
|---|---|
| Web | Per-release key ([ADR-0004](0004-web-release-keys.md)) |
| Android | Play Integrity ([ADR-0005](0005-android-play-integrity.md)) |
| iOS | App Attest, not built; needs a spike with a real attestation |

## Options considered

| Option | Outcome |
|---|---|
| Turnstile or reCAPTCHA | Rejected: checks for bots, not for our app |
| Player sign-in | Rejected: adds accounts |
| Close web registration | Not chosen: no new web players |
| A proof per platform | Chosen |

## Consequences

- The check is only as strong as the weakest path, which is web.
- It was deployed before any client existed, so none was cut off. Clients must
  send a proof from their first release.
- Only web and Android can ever register as built. iOS (until App Attest is
  built), desktop and any other client are refused.
- Clients registered without proof stay valid until `MASTER_KEY` is rotated, and
  rotation makes every client register again.
