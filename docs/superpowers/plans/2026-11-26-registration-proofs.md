# Registration Proofs (server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /v1/register` accepts only a web release-key signature or a Play Integrity token, and an App Attest spike decides how iOS follows.

**Architecture:** The proof checks live in a new `src/proof.ts`; `register` in `src/index.ts` rate limits, picks the proof, then issues the key as today. Nothing is stored.

**Tech Stack:** Cloudflare Worker, TypeScript, WebCrypto (Ed25519, RS256, HMAC), `node --test` against `wrangler dev`. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-26-registration-whitelist-design.md`

## Global Constraints

- Base branch: `claude/advisor-opus-b531c8` (PR #4). CI runs only for PRs into `main`, so open the PR after #4 merges.
- A merge to `main` deploys and enforces at once. **Do not merge until web and Android clients that send proofs have shipped.** iOS cannot register until its own plan ships. No feature flag.
- Never commit private keys, service-account JSON, deployment URLs or account IDs.
- Do not rotate `MASTER_KEY`, set production secrets or deploy. Those are the user's steps.
- Rate limit first, then exactly one proof, else 401. Response and uploads unchanged.
- Time window for signatures, challenges and verdicts: 300 s.
- Secrets: `BUILD_KEYS` = `{"<build>":"<base64 raw Ed25519 public key>"}`; `ANDROID_APPS` = `{"<package>":["<certificateSha256Digest>"]}`; `GOOGLE_SA_KEY` = service-account JSON. Unset means that proof is refused (401); malformed means 500.
- Each task updates `README.md`, `docs/TRD.md` and (where behaviour changes) `docs/PRD.md` in its own commit.

## External prerequisites (not tasks here)

Godot web Ed25519 signing spike (web client repo); a Godot Android plugin that makes Standard integrity requests with `requestHash`; the iOS plugin exposing attestation; a Play Console app linked to a Cloud project, with a service account.

## Review Focus

- A challenge MAC must never work as a client upload key (Task 2).
- Google down: the client must get 503 and retry, not 401 (Task 3).
- `X-Build: __proto__` or `constructor`: 401, not 500 (Task 1).
- Both proofs, or half of one: 401 (Tasks 1, 3).
- A verdict with fields missing (cleared on replay): 401, not 500 (Task 3).

---

### Task 1: Web release key, proof required

**Files:** Create `src/proof.ts`; modify `src/index.ts` (`Env`, `CORS`, `register`), `test/api.test.mjs`, `.github/workflows/ci.yml`, docs.

**Interfaces:**
- Produces: `fromBuild(headers: Headers, env: Env): Promise<boolean>`; test helper `buildHeaders(ts = now, build = BUILD_ID): Record<string,string>`; `postRegister(ip?, { headers = buildHeaders(), body } = {})`.
- Wire: `X-Build`, `X-Timestamp` (digits, Unix seconds), `X-Build-Signature` (base64 Ed25519 over `register\n{build}\n{timestamp}`).

- [ ] **Step 1: Failing tests.** In `before`, local runs generate an Ed25519 pair and pass `--var BUILD_KEYS:<json>` with build `test`. Remote runs use env `BUILD_ID` and `BUILD_SEED` (base64 32-byte seed; build the key with PKCS8 prefix `302e020100300506032b657004220420`). `postRegister` signs by default. Add:
  - `register without a proof is refused`: no headers → 401, CORS present.
  - `bad build proof is refused`: each of wrong signature, non-base64 signature, `ts` now−301 and now+301, `ts` `"abc"`, build `nope`, `__proto__`, `constructor`, and each header omitted → 401. Give each case a fresh IP; skip remotely if it would exceed the limit.
  - Add `X-Build, X-Timestamp, X-Build-Signature` to the expected `Access-Control-Allow-Headers`.
- [ ] **Step 2:** `npm test`. Expected: the new tests and `cors` FAIL.
- [ ] **Step 3:** Implement. Parse `BUILD_KEYS` and import the key outside any `try` (bad config → 500); look up with `Object.hasOwn`; only decoding the client's signature may be caught.
- [ ] **Step 4:** `npm run check && npm test`. Expected: all pass.
- [ ] **Step 5:** Pass `BUILD_ID: ci` and `BUILD_SEED: ${{ secrets.BUILD_SEED }}` to the deployed `npm test` step, and add `BUILD_SEED` to the "Require settings" check. Docs: wire format, keygen command, per-release rotation; TRD gaps (300 s replay, extractable key, the CI seed can register); PRD N1 is false for web, F6 covers released builds only.
- [ ] **Step 6:** Commit `feat: require a release-key signature to register`.

### Task 2: Challenge endpoint

**Files:** Modify `src/proof.ts`, `src/index.ts`, `test/api.test.mjs`, docs.

**Interfaces:**
- Produces: `GET /v1/challenge` → `{"challenge":"{ts}.{base64url HMAC(MASTER_KEY, "challenge\n{ts}")}"}`, `Cache-Control: no-store`; `validChallenge(value: string, env: Env): Promise<boolean>` (MAC checked with `crypto.subtle.verify`, age ≤ 300 s).

- [ ] **Step 1: Failing tests.** `challenge has the expected shape`: 200, matches `^\d+\.[\w-]{43}$`, no-store. `a challenge is not a client key`: upload with `client_id = ts` and `key = base64(mac)` → 401.
- [ ] **Step 2:** `npm test`. Expected: shape test FAILS with 404.
- [ ] **Step 3:** Implement. The newline keeps the MAC input outside `LOG_PATH`'s character set. No new CORS method: only native apps call it.
- [ ] **Step 4:** `npm run check && npm test`. Expected: pass.
- [ ] **Step 5:** Docs; commit `feat: add stateless registration challenge`.

### Task 3: Play Integrity

**Files:** Modify `src/proof.ts`, `src/index.ts`, `test/api.test.mjs`, docs.

**Interfaces:**
- Consumes: `validChallenge`, `readBody`.
- Produces: `fromPlay(body: Uint8Array, env: Env): Promise<200 | 401 | 503>`.
- Wire: register body `{"package_name","challenge","integrity_token"}`. A body plus any `X-Build*` header → 401.
- Google: token `POST https://oauth2.googleapis.com/token` (grant `urn:ietf:params:oauth:grant-type:jwt-bearer`, RS256 JWT, scope `https://www.googleapis.com/auth/playintegrity`); decode `POST https://playintegrity.googleapis.com/v1/{package}:decodeIntegrityToken` with `{"integrity_token"}`; result under `tokenPayloadExternal`. Optional var `GOOGLE_BASE` replaces both origins (tests only).
- Pass only if all hold: package in `ANDROID_APPS` (checked before calling Google) and equal to `requestDetails.requestPackageName`; `requestDetails.requestHash` = unpadded base64url `SHA256(challenge)`; `requestDetails.timestampMillis` (string) within 300 s; `appIntegrity.appRecognitionVerdict` = `PLAY_RECOGNIZED`; an `appIntegrity.certificateSha256Digest` entry is allowlisted; `deviceIntegrity.deviceRecognitionVerdict` includes `MEETS_DEVICE_INTEGRITY`. Licensing is not checked.
- Errors: decode 400 or failed verdict → 401; token failure, other non-200 or network error → 503.

- [ ] **Step 1: Failing tests.** A `node:http` stub serves `/token` and `…:decodeIntegrityToken`, choosing its answer by `integrity_token` value; local `wrangler dev` gets a generated RSA `GOOGLE_SA_KEY`, `ANDROID_APPS` and `GOOGLE_BASE`. All local only.
  - `play token registers`: 200 with `client_id` and `key`.
  - `bad verdicts are refused`: one case per pass condition, plus `{}` payload, expired and forged challenge, unlisted package, non-JSON body, both proofs → 401.
  - `google failure is retryable`: stub 500 → 503; stub 400 → 401.
- [ ] **Step 2:** `npm test`. Expected: new tests FAIL.
- [ ] **Step 3:** Implement. Read the body with `readBody` (32 KB cap) after the rate limit. No access-token cache.
- [ ] **Step 4:** `npm run check && npm test`. Expected: pass.
- [ ] **Step 5:** Docs: setup of the two secrets, internal test track for development, quotas 10,000 token requests and 10,000 decodes per app per day (replace TRD's "unverified" note), random `client_id`. Commit `feat: register Android apps with Play Integrity`.
- [ ] **Step 6 (needs the user's service account and a real device token):** Confirm a real token registers and the same token sent again gets 401. Record in `docs/evidence/`; if not possible yet, say so in the PR and keep it unmerged.

### Task 4: App Attest spike

**Files:** Create `docs/evidence/2026-11-26-app-attest-spike.md`; throwaway code stays out of `src/`.

- [ ] **Step 1:** Obtain one real attestation object with its challenge and key ID (from the user). Without it, stop and report.
- [ ] **Step 2:** In a throwaway Worker run locally, do every check in the spec's "iOS: App Attest" section against current Apple docs.
- [ ] **Step 3:** Record libraries needed, bundle size, CPU per verification against the 10 ms limit, and a go/no-go. Local timing is not deployed CPU time; say so.
- [ ] **Step 4:** Commit the note. The iOS plan is written afterwards.

## Before the PR

Add `docs/evidence/2026-11-26-registration-proofs.md` with real `npm test` and `npm run check` output, and use `.github/PULL_REQUEST_TEMPLATE.md`. Tell the user the manual steps: set the secrets, add the `ci` key to `BUILD_KEYS` and `BUILD_SEED` to GitHub, then rotate `MASTER_KEY` once all clients have shipped.
