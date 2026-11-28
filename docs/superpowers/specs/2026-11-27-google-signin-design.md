# Google sign-in for web registration

Status: approved and built, 2026-11-28. Not deployed.

## Intent

Phase 1 is web only. A release key shipped in a web build can be extracted and
then used without a dependable limit. Replace it with Google sign-in, so that
registering again gains nothing, without storing a user database.

## Approaches

| Approach | Trade-off | Outcome |
|---|---|---|
| `client_id` derived from the Google subject | One ID per account, no storage; logs are filed under a stable pseudonym | **Chosen** |
| Sign-in, then a random `client_id` | Logs not linked to an account; one account can register without limit | Rejected: no gain in abuse control |
| Sign-in plus release key | Keeps the extractable key and the build hardening work | Rejected: out of phase 1 scope |

## Design

`POST /v1/register` with body `{"google_id_token": "<ID token>"}` returns
`{client_id, key}` as today.

The Worker requires all of:

- `alg` is `RS256` and the signature verifies against the key named by `kid` in
  `https://www.googleapis.com/oauth2/v3/certs`
- `iss` is `accounts.google.com` or `https://accounts.google.com`
- `aud` equals `GOOGLE_CLIENT_ID`
- `exp` has not passed
- `iat` is within 300 s of the server's time, either side
- `sub` is a non-empty string

Anything else is 401. If Google's keys cannot be fetched, 503. Without
`GOOGLE_CLIENT_ID`, 401. Keys are cached as the response's `Cache-Control` says.

`client_id = base64url(HMAC-SHA256(MASTER_KEY, "google\n" + sub))`. The newline
cannot appear in a client ID, so this value is never another client's upload
key. `key` is derived from `client_id` as today. Uploads do not change. No new
dependencies and no storage.

## What changes elsewhere

- **Web release keys:** no web build gets one. The build-key proof stays in the
  Worker **only for the `ci` entry's use**, because CI cannot sign in to Google.
  Its code is unchanged.
- **Android:** code kept, still unconfigured and refused. Deferred.
- **Rate limit:** the register limit stays, still best effort.
- **Docs:** README, TRD, a new ADR-0006; ADR-0003 and 0004 marked superseded for
  web.
- **Tests:** local tests sign tokens with their own key through the existing
  `GOOGLE_BASE` stand-in: each check above (including a stale `iat`), the same account gets the same ID,
  different accounts differ. The deployment run checks only that a bad token
  gets 401. A real token is checked by hand once.

## Data and privacy

The ID token also carries the player's name, email and picture under the default
sign-in. The Worker reads only the claims above and neither stores nor logs the
rest. Stored logs are linked to a stable pseudonymous ID, so plan for a privacy
policy and for erasure: the game should be able to show the player their
`client_id`.

## What remains open to abuse

- One account holds one ID, but many accounts give many IDs.
- The upload limit is the same rate limit binding, not verified on a deployment.
- A player can use their own token or key in a script.
- Someone who obtains a player's ID token within 300 s of it being issued gets
  that player's upload key. Google fixes the token's own lifetime (about an
  hour); the Worker's age check is what shortens it. The key obtained stays
  valid.
- A key cannot be revoked for one player. Only rotating `MASTER_KEY` does it,
  for everyone, and rotation also changes every derived `client_id`.

## Godot web export (checked 2026-11-27)

A throwaway Godot 4.7 single-threaded export loaded Google's script through
`JavaScriptBridge` and drew the sign-in button on `localhost`, with a
placeholder client ID. The same build was served again with the isolation
headers a threaded export needs
(`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp`): script and button still loaded,
but a page could no longer receive a message from a cross-origin popup (tested
with a local popup in headless Chromium 153; without the headers the message
arrived).

**So: export single-threaded and do not send those headers.** Threaded export
itself was not built (template not installed). Not tested: a real sign-in, and
whether Google's FedCM button mode works on an isolated page.

## Environment variables

| Name | Where | Status |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Worker secret | **new** |
| `MASTER_KEY` | Worker secret | set |
| `BUILD_KEYS` | Worker secret, only the `ci` entry needed | set |
| `BUILD_SEED` | GitHub secret | set |
| `CLOUDFLARE_API_TOKEN` | GitHub secret | set |
| `CLOUDFLARE_ACCOUNT_ID`, `BASE_URL` | GitHub variables | set |
| `REGISTER_LIMIT`, `UPLOAD_LIMIT` | GitHub variables, optional | unset |
| `ANDROID_APPS`, `GOOGLE_SA_KEY` | Worker secrets, Android only | unset, deferred |

The client ID is not confidential; it is a secret binding so that a deploy keeps
it and the repository does not name the deployment.

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
```

Local development, in `.dev.vars` (git ignored):

```
MASTER_KEY=local-only-key
BUILD_KEYS={"dev":"<public key>"}
GOOGLE_CLIENT_ID=<client ID>
```

## Not in this repository

- Google Cloud OAuth web client, consent screen, authorized JavaScript origins
  (the game's HTTPS origin, and `http://localhost` with its port for
  development), privacy policy page.
- Godot client: sign-in button through `JavaScriptBridge`.

## Success

A player signs in on the web game, registers and uploads; signing in again
returns the same `client_id`; no web build contains a secret.
