# Playtrail: Product Requirements

Status: draft

## Problem

Developers of turn-based board games want a record of what players did, for
replay, balancing and bug reports. Hosted analytics and game backends add
schemas, query engines and pricing tiers that a plain move record doesn't need.

## Users

- **Game developer:** integrates the client, deploys the server to their own
  Cloudflare account, reads the logs offline.
- **Player:** doesn't interact with Playtrail, apart from seeing their ID if
  they want their data deleted. The game works without it.

## Goals

1. Accept batches of actions from game clients.
2. Store them append-only, with retries that don't duplicate a batch.
3. Delete each batch 14 days after upload.
4. Cost about $0 at low volume.
5. Be small enough to read in one sitting.

## Non-goals

Reading or querying through the API, event-level dedup, ordering guarantees,
content validation, conflict resolution, game logic, real-time multiplayer,
long-term storage.

## Assumptions

- Uploads are infrequent (up to about 1,000 batches a day).
- High latency is fine. Clients may queue for hours and flush on app close, next
  launch or a timer.
- Readers are offline jobs or a developer with S3-compatible tools, and they
  export at least once every 14 days.

## Requirements

| ID | Requirement |
|---|---|
| F1 | A new install of our own build can register and receive an ID and signing key |
| F2 | A client can upload a batch of up to 32 KB of NDJSON |
| F3 | Re-uploading a stored batch ID succeeds without writing again |
| F4 | A client cannot write under another client's ID |
| F5 | Every batch is deleted by a storage rule 14 days after upload |
| F6 | Released web exports can register and upload (CORS) |
| F7 | Registration and uploads are rate limited |
| N1 | No long-lived secret is embedded in the distributed game. Exception: a web build carries a per-release signing key, which can be extracted |
| N2 | The game stays fully playable when Playtrail is unreachable |
| N3 | Runs within Cloudflare free tiers at the assumed volume |

## Integrator responsibilities

- **Consent:** upload only if the player has agreed. Opting out must also clear
  the local queue. The server cannot enforce this.
- **Identity:** use only the server-issued ID, never a device or hardware ID.
- **Hidden information:** logs may contain secret moves. Never expose them to
  players while a match is live.
- **Privacy notice:** state that each upload is kept for about 14 days.
- **Erasure requests:** show players their `client_id` (for example in
  settings), so you can delete their data on request. See the TRD.
- **Reading:** export data you want to keep within 14 days of upload.
- **Billing:** set a billing alert. It notifies you but does not cap spending.

## Success criteria

- Against a real bucket, uploading one batch twice returns 201 then 200 and
  leaves one object.
- A wrong signature, altered body or another client's ID returns 401.
- Registering without a valid build proof returns 401.
- A body over 32 KB returns 413.
- A browser export on another origin can register and upload.
- The bucket has a 14-day expiry rule, and a test object is gone by day 16.
- 1,000 batches a day (about 30k writes a month) stays within the free tiers.

## Phases

1. **v1:** register, signed upload, 14-day expiry, size cap, rate limits,
   billing alert.
2. **When abuse appears:** platform attestation at registration, then daily
   per-client quotas.

## Open questions

- Do integrators need a `DELETE /v1/logs/{client_id}` endpoint?
- Is 32 KB per batch enough for long games?
