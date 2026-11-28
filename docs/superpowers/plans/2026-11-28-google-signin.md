# Google Sign-in Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web players register with a Google ID token and always get the same `client_id`.

**Architecture:** `register()` dispatches a JSON body with `google_id_token` to a new verifier in `src/proof.ts`; the ID is derived from the Google subject. Nothing is stored.

**Tech Stack:** Cloudflare Worker, TypeScript, Web Crypto, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-27-google-signin-design.md`

## Global Constraints

- No new dependencies, no storage. Uploads do not change.
- `alg` RS256, `iss` either Google spelling, `aud` string equal to `GOOGLE_CLIENT_ID`, `exp` not passed, `iat` within 300 s either side, non-empty `sub`. Else 401; keys unfetchable 503; `GOOGLE_CLIENT_ID` unset 401.
- `client_id = base64url(HMAC-SHA256(MASTER_KEY, "google\n" + sub))`.
- Never log the token or its claims.

## Review Focus

- Junk or claim-invalid tokens must not cause a fetch to Google.
- `google_id_token` together with `integrity_token` or build headers is 401.
- A `null` or non-object JSON body is 401, not 500.
- A non-ASCII `name` claim must not break decoding.
- An unknown `kid` is 401, not 500.

---

### Task 1: Verify Google ID tokens at register

**Files:** Modify `src/proof.ts`, `src/index.ts`; Test `test/api.test.mjs`

**Interfaces:**
- Produces: `fromGoogle(token: unknown, env: GoogleEnv): Promise<{ sub: string } | 401 | 503>`, `GoogleEnv { GOOGLE_CLIENT_ID?: string; GOOGLE_BASE?: string }`.

- [ ] **Step 1:** Add tests (local only): stub serves `GET /oauth2/v3/certs` with a counter, settable status and no caching by default; dev server gets `--var GOOGLE_CLIENT_ID:test-client`. Cases: valid token registers and uploads; same `sub` same ID, other `sub` other ID; both `iss` spellings; each bad claim, `alg` none and HS256, unknown `kid`, wrong key; junk never fetches keys; mixed proofs; JWKS 500 is 503; keys cached for `max-age`. Remote: a bad token gets 401.
- [ ] **Step 2:** `npm test`. Expected: the new registration tests fail with 401.
- [ ] **Step 3:** Implement `fromGoogle`: claim checks first, then keys (cached per `max-age`), then signature. Dispatch in `register()`.
- [ ] **Step 4:** `npm run check && npm test`. Expected: all pass.
- [ ] **Step 5:** Commit `feat: register web players with a Google ID token`.

### Task 2: Docs, evidence, review

**Files:** `README.md`, `docs/TRD.md`, `docs/PRD.md` (if it says otherwise), `docs/adr/0003`, `0004`, new `0006-google-sign-in.md`, spec status, new `docs/evidence/2026-11-28-google-signin.md`

- [ ] **Step 1:** Update docs as the spec's "What changes elsewhere" says; add a browser client example.
- [ ] **Step 2:** Record real `npm run check` and `npm test` output in the evidence file, with what was not tested (real token, deployment).
- [ ] **Step 3:** Reviewer pass on the diff, fix real findings, commit. Do not push.
