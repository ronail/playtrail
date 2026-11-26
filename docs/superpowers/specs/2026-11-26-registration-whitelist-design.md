# Registration whitelist: design

Status: **approved 2026-11-26.** Nothing here is built. Play Integrity was
checked against Google's docs on 2026-11-26. Apple and Godot behaviour has not
been rechecked.

## Intent

Only our own apps and builds should be able to register. Today anyone can, and
the register rate limit did not hold across new connections on a deployment.

## Goals, non-goals, anti-goals

- Goals: iOS registers with App Attest, Android with Play Integrity, the Godot
  web build with a per-release key; one release or app can be cut off without
  touching the rest.
- Non-goals: user accounts or sign-in, bot checks (Turnstile, reCAPTCHA),
  changing how uploads are signed.
- Anti-goals: presenting the web check as proof of the build (it is a deterrent);
  committing private keys; breaking uploads for gameplay.

## Constraints

- A web build cannot keep a secret. Its key can be extracted.
- App Attest is Apple only; Play Integrity covers Android.
- Free plan: 10 ms CPU per request.

## Approaches

| Approach | Trade-off | Decision |
|---|---|---|
| Turnstile or reCAPTCHA for web | No secret in the build, but a bot check, not an app check | Rejected |
| Player sign-in | Real identity, but adds accounts | Rejected |
| Close web registration | Strongest, but no new web players | Not chosen |
| Per-release key pair for web, App Attest and Play Integrity for the apps | Web is only a deterrent | **Chosen** |

## Design

`POST /v1/register` accepts exactly one of three proofs, else 401. The register
rate limit runs first. The returned `{client_id, key}` and uploads are unchanged.

### Web: release key

- Ed25519 pair per release. Public keys in the `BUILD_KEYS` secret:
  `{"web-1.5.0":"<base64>"}`.
- Headers `X-Build`, `X-Timestamp`, `X-Build-Signature`, signing
  `register\n{build}\n{timestamp}`, accepted within 300 s. Add the headers to
  `Access-Control-Allow-Headers`.
- Signing is in a C++ GDExtension, because Godot's `Crypto` is documented as
  unavailable on web (check first).
- Hardening: new key each release, `.pck` encryption with custom templates,
  script obfuscation, stripped symbols.
- Known gaps: a captured request replays for 300 s; the key can be extracted.

### iOS: App Attest

- `GET /v1/challenge`: stateless HMAC nonce, valid 5 minutes. Android uses it too.
- Register sends the challenge, key ID and attestation object.
- Verify: certificate chain to Apple's root, nonce, key ID, app ID hash
  (allowlist `APP_IDS`), production `aaguid`, counter 0.
- `client_id = hex(HMAC(MASTER_KEY, "attest:" + keyId))`, so a resent
  attestation returns the same ID.
- Client: the existing godot-ios-app-attest plugin, if it exposes attestation.

### Android: Play Integrity

- Standard API requests, not classic: Google returns cleared verdicts when a
  token is decoded again, so no nonce storage is needed.
- The app gets `GET /v1/challenge`, requests a token with
  `requestHash = SHA256(challenge)` and sends both to register.
- The Worker signs a service-account JWT (WebCrypto), exchanges it for an access
  token and calls `decodeIntegrityToken`. New secret `GOOGLE_SA_KEY`, never
  committed. Android registration then depends on Google being reachable.
- Require: `requestPackageName` and `certificateSha256Digest` in the
  `ANDROID_APPS` allowlist, matching `requestHash`, a valid challenge,
  `appRecognitionVerdict` = `PLAY_RECOGNIZED`, and `deviceRecognitionVerdict`
  containing `MEETS_DEVICE_INTEGRITY`.
- `appLicensingVerdict` = `LICENSED` is **not** required: it would
  reject real players, for example those not signed in to Play.
- Verdicts carry no install ID, so `client_id` is random, as today. A genuine
  device can register repeatedly.
- Client: needs a Godot Android plugin offering Standard requests with
  `requestHash` and the Cloud project number.
- Local and debug builds are not expected to pass. Test through a Play internal
  test track; no bypass in production.
- Quota: 10,000 token requests and 10,000 decodes per app per day by default,
  shared with any other Play Integrity use. Junk tokens might use up the decode
  quota; the docs read do not say.

## Rollout

1. Spike: parse and verify one real attestation in a Worker and measure CPU. It
   may need CBOR and X.509 libraries (the first runtime dependencies) and may not
   fit in 10 ms.
2. Spike: Ed25519 signing from a Godot web export.
3. Spike: OAuth and decode from a Worker with a real token, including that a
   second decode is rejected (the docs give no replay threshold).
4. Build, then ship clients that send proofs before the Worker requires them.
5. Rotate `MASTER_KEY` to drop clients registered without proof. All clients
   register again, and queued batches need the new ID.

## Open

- A hard registration cap (Durable Object or WAF rule) is not part of this
  design. Without it, an extracted web key allows unlimited registrations.
- TRD, README and PRD change with the code. N1 ("no secret in the game") becomes
  false for web, and F6 then covers released builds only.

## Left to the builder

Module layout, library choice after the spike, test fixtures.
