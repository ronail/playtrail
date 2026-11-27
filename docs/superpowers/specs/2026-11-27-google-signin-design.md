# Google sign-in for web registration

Status: proposed, 2026-11-27. Not built.

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
  `GOOGLE_BASE` stand-in: each check above, the same account gets the same ID,
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
- Someone who obtains a player's ID token within its lifetime (about an hour)
  gets that player's upload key. A `nonce` check would narrow this; left out
  because replay protection needs stored state.
- A key cannot be revoked for one player. Only rotating `MASTER_KEY` does it,
  for everyone, and rotation also changes every derived `client_id`.

## Not in this repository

- Google Cloud OAuth web client, consent screen, authorized JavaScript origins
  (the game's HTTPS origin), privacy policy page.
- `npx wrangler secret put GOOGLE_CLIENT_ID`
- Godot client: sign-in button through `JavaScriptBridge`, loading Google's
  script. **Unverified:** a threaded web export needs cross-origin isolation
  headers, which are likely to break Google's script or popup. Try sign-in in a
  throwaway export before building on it.

## Success

A player signs in on the web game, registers and uploads; signing in again
returns the same `client_id`; no web build contains a secret.
