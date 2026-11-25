# Playtrail v1 Worker: design

Status: approved 2026-11-25. The [TRD](../../TRD.md) is the spec; this records
only what it leaves open.

## Intent
Turn the drafted API into a running Worker (PRD phase 1). Why: see the
[PRD](../../PRD.md).

## Goals, non-goals, anti-goals
- Goals: `register`, signed `PUT`, CORS, size cap, rate limits, 14-day expiry,
  deployed and checked on the real account.
- Non-goals: attestation, game client library, read or delete endpoints.
- Anti-goals: runtime dependencies; reporting success for data that was not
  stored.

## Approaches
- **Single `src/index.ts` following the TRD sketch (chosen):** two routes, small
  enough to read in one sitting.
- Router library or split modules: more code and dependencies for two routes.
- Languages: TypeScript (chosen) over JavaScript (no type checks), Python and
  Rust (less mature or heavier toolchain on Workers).

## Decisions beyond the TRD
- Dev dependencies only: wrangler, typescript, `@cloudflare/workers-types`.
- One test file using `node:test`, sending HTTP to `wrangler dev` or to a
  deployed URL given by environment variable.
- One wrapper adds CORS headers to every response, including uncaught errors.
- `register` returns the raw HMAC bytes as base64; clients decode before signing.
  README says so.
- Missing `CF-Connecting-IP` (local dev) falls back to a fixed rate limit key.
- Unknown path or method: 404. `Content-Type` is not enforced.
- If `onlyIf: If-None-Match: *` fails on a real bucket: fall back to
  head-then-put, and document the concurrent-retry race.

## Real-account checks
Run by the assistant after the owner runs `wrangler login`: create bucket, add
lifecycle rule, set `MASTER_KEY`, deploy, test. Left to the owner: billing
notification, read-only R2 token. The day-16 expiry check waits about two weeks.

## Left to the builder
Code layout inside the file, test case naming.
