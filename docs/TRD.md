# Playtrail: Technical Requirements and Design

Status: draft. Code below is a sketch that has not been run.

## Architecture

One Cloudflare Worker (TypeScript, no dependencies) and one R2 bucket. No
database. A cron trigger on the same Worker handles retention.

```
game client ──PUT──▶ Worker ──put-if-absent──▶ R2 {client_id}/{batch_id}.ndjson
                      ▲                          │
                 daily cron ──delete idle────────┘
developer ──────────── S3-compatible read ───────▶ R2
```

## API

### `POST /v1/register`

Anonymous, rate limited per IP. Returns:

```json
{"client_id": "<server uuid>", "key": "<base64>"}
```

`key = HMAC-SHA256(MASTER_KEY, client_id)`. It is derived, not stored.

### `PUT /v1/logs/{client_id}/{batch_id}`

Headers: `Content-Type: application/x-ndjson`, `Content-Length`,
`X-Signature: base64(HMAC-SHA256(key, client_id + "\n" + batch_id + "\n" + body))`.

Both IDs must match `[\w-]{1,64}`, which blocks path traversal. `batch_id` is a
ULID, generated once when the batch is sealed and reused on every retry.

| Response | Meaning | Client action |
|---|---|---|
| 201 | stored | drop the batch |
| 200 | already stored | drop the batch |
| 401 | bad signature | register again, start a new `client_id` |
| 404 | bad path | fix the client |
| 413 | over 32 KB or no length | split the batch |
| 429 / 5xx / network | not stored or unknown | back off, retry with the same `batch_id` |

PUT rather than POST: the client names the resource, so idempotency is permanent
and needs no short-lived key store.

### `OPTIONS`

Web exports send a preflight. Answer it and set
`Access-Control-Allow-Origin` to the game's origin, on error responses too.

## Event envelope (client convention)

```json
{"seq": 41, "ts": "2026-11-24T10:00:00Z", "type": "tile_discarded", "data": {}}
```

`seq` is a per-client counter for ordering and gap detection. The server never
parses the body.

## Upload sketch

```ts
interface Env { BUCKET: R2Bucket; MASTER_KEY: string }
const MAX = 32 * 1024;
const enc = new TextEncoder();
const hmacKey = (raw: BufferSource, use: KeyUsage) =>
  crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [use]);
const clientKey = async (env: Env, id: string) =>
  crypto.subtle.sign("HMAC", await hmacKey(enc.encode(env.MASTER_KEY), "sign"), enc.encode(id));

// after matching the path to (id, batch):
const len = Number(req.headers.get("content-length"));
if (!(len > 0 && len <= MAX)) return new Response("bad size", { status: 413 });
const body = await req.arrayBuffer();
const msg = new Uint8Array([...enc.encode(`${id}\n${batch}\n`), ...new Uint8Array(body)]);
let ok = false;
try {
  const sig = Uint8Array.from(atob(req.headers.get("x-signature") ?? ""), c => c.charCodeAt(0));
  ok = await crypto.subtle.verify("HMAC", await hmacKey(await clientKey(env, id), "verify"), sig, msg);
} catch { /* bad base64 */ }
if (!ok) return new Response("unauthorized", { status: 401 });

const put = await env.BUCKET.put(`${id}/${batch}.ndjson`, body, {
  onlyIf: { etagDoesNotMatch: "*" }, // put-if-absent
});
return new Response(null, { status: put ? 201 : 200 });
```

## Client contract

1. Append actions to a local queue.
2. On flush, seal a batch (32 KB or less), assign a ULID, persist both.
3. Sign and `PUT`. Delete the batch on 200/201; otherwise retry with exponential
   backoff.
4. Never let an upload failure affect gameplay.

## Retention

R2 lifecycle rules expire objects by their own age, which would delete an active
client's old data. A daily cron applies the idle rule instead:

```ts
// wrangler.toml: [triggers] crons = ["0 3 * * *"]
async scheduled(_: ScheduledController, env: Env) {
  const cutoff = Date.now() - 14 * 864e5;
  const { delimitedPrefixes } = await env.BUCKET.list({ delimiter: "/" }); // first page only
  for (const prefix of delimitedPrefixes) {
    const keys: string[] = [];
    let newest = 0, cursor: string | undefined;
    do {
      const page = await env.BUCKET.list({ prefix, cursor });
      for (const o of page.objects) { keys.push(o.key); newest = Math.max(newest, o.uploaded.getTime()); }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if (newest < cutoff)
      for (let i = 0; i < keys.length; i += 1000) await env.BUCKET.delete(keys.slice(i, i + 1000));
  }
}
```

- Idle is measured by the server's `uploaded` time, not client timestamps.
- **Required before release:** page through the client list with a cursor and
  process a bounded number per run. The sketch reads only the first page, and the
  Free plan limits subrequests per invocation (50).
- An upload landing during the sweep can be deleted with the rest. Accepted.
- A very late retry of a deleted batch stores it again. Accepted.

## Security

Treat the endpoint as anonymous write-only: anyone can register.

| Threat | Mitigation |
|---|---|
| Secret extracted from the game | None ships. Keys are per install |
| Writing under another client's ID | Server-issued IDs, signed requests |
| Tampering | Signature covers IDs and body |
| Replay | Same `batch_id`, so nothing is written |
| Storage and cost abuse | 32 KB cap, per-IP rate limit, billing alert, 14-day expiry |
| Sweep overwhelmed by spam IDs | Cursor-based sweep, alert if it doesn't finish |
| Hostile content | Readers parse defensively and escape on display or export |
| Personal data in logs | Don't log headers or store IPs in metadata |
| Bucket exposure | No public access; read-only token for consumers |

Rotating `MASTER_KEY` invalidates every client, which then registers again.

## Attestation (phase 2, optional)

Verify a platform token once, at `/register`.

| Platform | Mechanism | Notes |
|---|---|---|
| Android | Play Integrity standard request | `requestHash` gives replay protection. Default quota 10k/day |
| iOS | App Attest | Needs a server challenge (`GET /v1/challenge`, stateless HMAC nonce, 5 minutes) |
| Web | Cloudflare Turnstile | Single-use token, valid 300 s |
| Desktop | none | Rate limit only |

**Weakest-path rule:** a bot claims whichever platform is weakest, so a stronger
check on one platform adds little until the others match it.

App Attest verification must validate the certificate chain to Apple's root,
the nonce, the key ID and the app ID hash. It may exceed the Free plan's 10 ms
CPU limit.

## Cost

Checked 2026-11-24; recheck [Workers](https://developers.cloudflare.com/workers/platform/pricing/)
and [R2](https://developers.cloudflare.com/r2/pricing/) pricing.

- Workers Free: 100k requests/day, 10 ms CPU.
- R2 free monthly: 10 GB, 1M Class A (writes and lists), 10M Class B, free egress.
- 1,000 batches a day is about 30k writes a month, so $0.

## Alternatives considered

| Option | Why not |
|---|---|
| Hosted ingest or game analytics services | None found with both idempotent writes and idle deletion at $0 |
| AWS Lambda + S3 | Similar shape; reasonable if already on AWS |
| Worker + D1 | A schema and database for data nobody queries |
| Appending to one file | Object stores don't support it |
| Shared bearer token | Public once shipped, and allows spoofing |

## To verify during implementation

- Free-plan cron availability and whether R2 binding calls count as subrequests.
- R2 `etagDoesNotMatch: "*"` behaviour, with a test.
- Turnstile `siteverify` quota and App Attest quotas.
