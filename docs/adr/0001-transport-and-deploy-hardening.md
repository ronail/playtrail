# ADR-0001: HTTPS only, and a smaller deploy surface

**Status:** Accepted. Merged in [PR #4](https://github.com/ronail/playtrail/pull/4) and deployed 2026-11-26.
**Date:** 2026-11-25 (written up 2026-11-26)

## Context

On the deployment, the Worker answered over plain HTTP and sent no HSTS header
([evidence](../evidence/2026-11-25-security.md)). The register response carries
the client's key. The repository is public, and a push to `main` deploys.

## Decision

- Refuse plain HTTP with 403, except on localhost. Do not redirect.
- Send `Strict-Transport-Security` on every response, and
  `Cache-Control: no-store` on the register response.
- Turn off preview URLs, so old versions are not reachable after a fix.
- Pin CI actions to commits and do not persist checkout credentials.

## Options considered

Redirecting HTTP to HTTPS was rejected: a client set to `http://` would keep
working while sending in the clear. A refusal makes the mistake visible.

## Consequences

- A client set to `http://` has already exposed that first request. HSTS and the
  403 do not protect it against an active attacker.
- Updating a CI action is now a manual change of commit hash.
- A malicious npm dev dependency could still reach the deploy token, and `main`
  is only as safe as who can push to it.
- Seen on the deployment 2026-11-26: the 403, HSTS and `no-store`. Preview URLs
  being off is not verified.
