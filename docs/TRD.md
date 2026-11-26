# Playtrail: Technical Requirements and Design

Status: v1 implemented in [src/index.ts](../src/index.ts) and tested locally. The
sketches below are illustrative; the source is authoritative.

## Architecture

One Cloudflare Worker (TypeScript, no dependencies in v1) and one R2 bucket. No
database and no scheduled jobs. An R2 lifecycle rule handles retention.

```
game client ──PUT──▶ Worker ──put-if-absent──▶ R2 {client_id}/{batch_id}.ndjson
                                                 │ lifecycle rule: expire at 14 days
developer ──────────── S3-compatible read ───────▶ R2
```

## Setup

```toml
# wrangler.toml
name = "playtrail"
main = "src/index.ts"
compatibility_date = "2026-11-01"
# Old versions must not stay reachable on their own URLs after a fix.
preview_urls = false

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "playtrail-logs"

[[ratelimits]]
name = "REGISTER_LIMIT"
namespace_id = "1001"
simple = { limit = 5, period = 60 }

[[ratelimits]]
name = "UPLOAD_LIMIT"
namespace_id = "1002"
simple = { limit = 10, period = 60 }
```

The two `limit` values above are defaults. Rate limit bindings are deploy-time
config, so a Worker variable cannot change them. Instead, `npm run deploy` and
`npm run dev` go through [scripts/wrangler.mjs](../scripts/wrangler.mjs): if
`REGISTER_LIMIT` or `UPLOAD_LIMIT` is set in the shell (CI passes the repository
variables of the same names), it writes `wrangler.limits.toml` with those limits
and runs Wrangler with it. Unset or empty means the default. Anything but a
positive whole number stops before Wrangler runs. `period` stays 60; Cloudflare
allows only 10 or 60.

```sh
npx wrangler r2 bucket create playtrail-logs
npx wrangler r2 bucket lifecycle add playtrail-logs --name expire-14d --expire-days 14
openssl rand -base64 32 | npx wrangler secret put MASTER_KEY
```

Also set a billing notification in the Cloudflare dashboard, keep the bucket
private, and give readers a read-only R2 token.

## API

HTTPS only. A plain HTTP request gets 403 (except on `localhost`, `127.0.0.1` and
`[::1]`, for local development) and is not redirected, so a misconfigured client
fails visibly instead of sending in the clear. Every response sends
`Strict-Transport-Security: max-age=31536000`.

Both IDs must match `[\w-]{1,64}`, and the path regex is anchored:
`^/v1/logs/([\w-]{1,64})/([\w-]{1,64})$`. This blocks path traversal.

### `POST /v1/register`

No accounts, but the request must prove it comes from one of our builds, else 401.
Rate limited (before the proof is checked) with `REGISTER_LIMIT`, keyed by `CF-Connecting-IP`: the
whole address for IPv4, the /64 prefix for IPv6 (the IP is not stored). The
response carries the key, so it is sent with `Cache-Control: no-store`. Returns:

```json
{"client_id": "<server uuid>", "key": "<base64>"}
```

`key = HMAC-SHA256(MASTER_KEY, client_id)`. It is derived, not stored.

**Web proof: release key.**

| Header | Value |
|---|---|
| `X-Build` | build ID, a key of the `BUILD_KEYS` secret |
| `X-Timestamp` | Unix seconds, digits only, within 300 s of the server |
| `X-Build-Signature` | base64 Ed25519 signature of `register\n{build}\n{timestamp}` |

`BUILD_KEYS` is `{"<build>":"<base64 raw public key>"}`. Unset refuses this proof
(401); malformed is a 500.

### `GET /v1/challenge`

For native app proofs. Returns `{"challenge": "{ts}.{mac}"}` with
`Cache-Control: no-store`, where `mac` is base64url
`HMAC-SHA256(MASTER_KEY, "challenge\n{ts}")`. Valid for 300 s and not single use.
Nothing is stored, it is not rate limited, and browsers are not expected to call
it.

### `PUT /v1/logs/{client_id}/{batch_id}`

Headers: `Content-Type: application/x-ndjson`,
`X-Signature: base64(HMAC-SHA256(key, client_id + "\n" + batch_id + "\n" + body))`.

`batch_id` is a ULID, generated once when the batch is sealed and reused on
every retry.

| Response | Meaning | Client action |
|---|---|---|
| 201 | stored | drop the batch |
| 200 | already stored | drop the batch |
| 401 | bad signature | register again, start a new `client_id` |
| 403 | plain HTTP | use `https://` |
| 404 | bad path | fix the client |
| 413 | over 32 KB | split the batch |
| 429 / 5xx / network | not stored or unknown | back off, retry with the same `batch_id` |

PUT rather than POST: the client names the resource, so no short-lived
idempotency key store is needed.

### CORS

`X-Signature` and `application/x-ndjson` trigger a preflight. Answer `OPTIONS`
with 204, and send these on **every** response, including errors:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, PUT, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-Signature
Access-Control-Max-Age: 86400
```

`*` is acceptable because there are no cookies or ambient credentials, and it
works with game portals whose origins change.

## Event envelope (client convention)

```json
{"seq": 41, "ts": "2026-11-24T10:00:00Z", "type": "tile_discarded", "data": {}}
```

`seq` is a per-client counter for ordering and gap detection. The server never
parses the body.

## Upload sketch

```ts
interface Env {
  BUCKET: R2Bucket;
  MASTER_KEY: string;
  UPLOAD_LIMIT: RateLimit;
}
const MAX = 32 * 1024;
const enc = new TextEncoder();
const hmacKey = (raw: BufferSource, use: KeyUsage) =>
  crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [use]);
const clientKey = async (env: Env, id: string) =>
  crypto.subtle.sign("HMAC", await hmacKey(enc.encode(env.MASTER_KEY), "sign"), enc.encode(id));

// after matching the path to (id, batch):
if (Number(req.headers.get("content-length") ?? 0) > MAX)
  return new Response("too large", { status: 413 }); // early reject only
const body = await req.arrayBuffer();
if (body.byteLength === 0) return new Response("empty", { status: 400 });
if (body.byteLength > MAX) return new Response("too large", { status: 413 }); // the real check

const msg = new Uint8Array([...enc.encode(`${id}\n${batch}\n`), ...new Uint8Array(body)]);
let ok = false;
try {
  const sig = Uint8Array.from(atob(req.headers.get("x-signature") ?? ""), c => c.charCodeAt(0));
  ok = await crypto.subtle.verify("HMAC", await hmacKey(await clientKey(env, id), "verify"), sig, msg);
} catch { /* bad base64 */ }
if (!ok) return new Response("unauthorized", { status: 401 });

// after the signature, so nobody else can use up this client's allowance
if (!(await env.UPLOAD_LIMIT.limit({ key: id })).success)
  return new Response("slow down", { status: 429 });

const key = `${id}/${batch}.ndjson`;
const put = await env.BUCKET.put(key, body, {
  onlyIf: new Headers({ "If-None-Match": "*" }), // put-if-absent
});
if (put) return new Response(null, { status: 201 });
// Only report success if the object really exists, so a client never drops data.
return new Response(null, { status: (await env.BUCKET.head(key)) ? 200 : 500 });
```

**Put-if-absent must be tested against a real bucket** (`wrangler dev --remote`),
not only locally: the wildcard behaviour on the Workers binding is not clearly
documented. Test that a first upload stores and that a second one with a
different body leaves the first unchanged.

## Client contract

1. Append actions to a local queue.
2. On flush, seal a batch (32 KB or less), assign a ULID, persist both.
3. Sign and `PUT`. Delete the batch on 200/201; otherwise retry with exponential
   backoff.
4. Never let an upload failure affect gameplay.

## Retention

The lifecycle rule expires each object 14 days after it was uploaded.

- Active players lose older batches too. This is intended: it needs no code, no
  state and no paid plan.
- Deletion is not instant at the 14-day mark; allow about a day (unverified).
- A very late retry of an expired batch stores it again. Accepted.

### Erasure on request

The developer deletes the player's prefix with any S3-compatible tool, for
example:

```sh
rclone delete r2:playtrail-logs/<client_id>/
```

This needs a write-capable token. Copies already exported must be deleted too.

## Security

Treat the endpoint as write-only and close to anonymous: a determined attacker
can register.

| Threat | Mitigation | What remains |
|---|---|---|
| Secret extracted from the game | Upload keys are per install; a release key is replaced each release and can be removed | A web build's release key can be extracted and used to register until removed |
| Replayed build proof | 300 s window | A captured request replays for 300 s |
| Leaked CI signing seed | Kept in a GitHub secret | Whoever has it can register until `ci` is removed from `BUILD_KEYS` |
| Key read off the network | HTTPS only, HSTS, `no-store` | A first request sent over `http://` is already exposed before the 403: an upload body and signature. A client set to `http://` has no protection against an active attacker, who can forward its register request over HTTPS and read the key |
| Weak `MASTER_KEY` | Setup generates 32 random bytes | Anyone registered can brute-force a weak one offline, then sign for any ID |
| Writing under another client's ID | Server-issued IDs, signed requests | Nothing known |
| Tampering | Signature covers IDs and body | Nothing known |
| Replay | Same `batch_id`, so nothing is written | An expired batch can be replayed once more |
| Storage abuse | 32 KB cap, upload limit, 14-day expiry | One ID can still hold about 6 GB; many IDs, more |
| Mass registration | Limit per IPv4 address or IPv6 /64, best effort | Weak: opening new connections got past it (see Verification). Any web page can make its visitors register (CORS `*`). A hard cap needs a WAF rule on a custom domain or a Durable Object |
| Request flooding | Rate limits | Rejected requests still count toward the daily quota; unsigned uploads are not limited. Needs a WAF rule on a custom domain |
| Compromised CI action or old version | Actions pinned to commits; preview URLs off | A malicious npm dev dependency could still reach the deploy token. `main` is only as safe as who can push to it |
| Hostile content | Readers parse defensively, escape on display and export | Relies on readers |
| Personal data in logs | Don't enable request logging or store IPs | Players may be identifiable from content |

The rate limit binding is approximate and counted per Cloudflare location, so it
is not an exact cap. The Workers Free daily request quota is shared by **every
Worker in the account**: a flood can take your other Workers down until it
resets. Use a separate account if that matters.

Rotating `MASTER_KEY` invalidates every client, which then registers again.

## Attestation (phase 2, optional)

Verify a platform token once, at `/register`. This phase needs extra libraries
or secrets.

| Platform | Mechanism | Notes |
|---|---|---|
| Android | Play Integrity standard request | `requestHash` binds the token to the request; Google handles replay protection. Decoding needs a Google service-account secret and an OAuth call. Default quota believed 10k/day (unverified) |
| iOS | App Attest | Needs a server challenge (`GET /v1/challenge`, stateless HMAC nonce, 5 minutes) |
| Web | Release key (built, see [register](#post-v1register)) | A deterrent only. Turnstile was rejected: it checks for bots, not our build |
| Desktop | none | Rate limit only |

**Weakest-path rule:** a bot claims whichever platform is weakest, so a stronger
check on one platform adds little until the others match it.

**App Attest.** Verify the certificate chain to Apple's root, the nonce, the key
ID, the app ID hash, the `aaguid` (production, not development) and that the
counter is 0. The nonce is stateless, so one attestation can be resent within
5 minutes: derive `client_id = hex(HMAC(MASTER_KEY, "attest:" + keyId))` so a
resend returns the same ID instead of a new one. Parsing CBOR and X.509 needs
libraries and may exceed the Free plan's 10 ms CPU limit.

## Cost

Checked 2026-11-24; recheck [Workers](https://developers.cloudflare.com/workers/platform/pricing/)
and [R2](https://developers.cloudflare.com/r2/pricing/) pricing.

- Workers Free: 100k requests/day, 10 ms CPU.
- R2 free monthly: 10 GB, 1M Class A (writes and lists), 10M Class B, free egress.
- 1,000 batches a day is about 30k writes a month and at most about 450 MB
  stored, so $0. Readers' list calls also count as Class A.

## Alternatives considered

| Option | Why not |
|---|---|
| Hosted ingest or game analytics services | None found with both idempotent writes and automatic expiry at $0 |
| AWS Lambda + S3 | Similar shape; reasonable if already on AWS |
| Worker + D1 | A schema and database for data nobody queries |
| Appending to one file | Object stores don't support it |
| Shared bearer token | Public once shipped, and allows spoofing |
| Delete a client's data after 14 days idle | Needs a sweep job that outgrows the Free plan and stored progress |

## Verification

Checked on a deployment, 2026-11-25:

- Put-if-absent works on a real bucket: a second upload with a different body
  returned 200 and left the first unchanged. The head-then-put fallback is not
  needed.
- The lifecycle command works and the `expire-14d` rule is listed.
- Both rate limit bindings deployed and returned 429 (register after 5, upload
  after 11 in one run; the limits are approximate, and see the later check below).
- A 40,000-byte body returned 413, with and without `Content-Length`. A body that
  never ends timed out instead, so early rejection of it is confirmed only
  locally. Cause not investigated.
- A browser page on another origin registered (200) and uploaded (201).

Checked again on the deployment, 2026-11-25, before the security changes were
deployed ([evidence](evidence/2026-11-25-security.md)):

- A client-sent `CF-Connecting-IP` is rejected at the edge (403, error 1000), so
  the register limit key cannot be spoofed.
- **The register limit did not hold across new connections:** over 30
  registrations, each on its own connection, all returned 200. On one reused
  connection, 429 appeared. Source IP, location and the deployed limit
  (5) were stable. Do not count on it against a deliberate client.

Still to verify:

- An overridden rate limit on a deployment. Overrides are tested only locally and
  with `wrangler deploy --dry-run`. Cloudflare documents no minimum or maximum
  for `limit`.
- On a deployment: plain HTTP returns 403, the IPv6 /64 register limit applies,
  and preview URLs are off.
- Expiry: object
  `ce3b948d-e5d8-4ca6-8386-c47f58712c1e/limit-check-008b08d0-5bcd-4488-88ed-32f583560528.ndjson`
  (uploaded 2026-11-25) should be gone by 2026-12-11.
- Turnstile `siteverify` and App Attest quotas (phase 2).

## References

- [R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Rate limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
