# Playtrail: Product Requirements

Status: draft

## Problem

Developers of turn-based board games want a record of what players did, for
replay, balancing and bug reports. Hosted analytics and game backends add
schemas, query engines and pricing tiers that a plain move record doesn't need.

## Users

- **Game developer:** integrates the client, deploys the server to their own
  Cloudflare account, reads the logs offline.
- **Player:** never sees Playtrail. Expects the game to work without it.

## Goals

1. Accept batches of actions from game clients.
2. Store them append-only, with retries that never duplicate a batch.
3. Delete all of a client's data after 14 days with no uploads.
4. Cost about $0 at low volume.
5. Be small enough to read in one sitting.

## Non-goals

Reading or querying through the API, event-level dedup, ordering guarantees,
content validation, conflict resolution, game logic, real-time multiplayer.

## Assumptions

- Uploads are infrequent (up to about 1,000 batches a day).
- High latency is fine. Clients may queue for hours and flush on app close, next
  launch or a timer.
- Readers are offline jobs or a developer with S3-compatible tools.

## Requirements

| ID | Requirement |
|---|---|
| F1 | A new install can register and receive an ID and signing key |
| F2 | A client can upload a batch of up to 32 KB of NDJSON |
| F3 | Re-uploading the same batch ID succeeds without writing again |
| F4 | A client cannot write under another client's ID |
| F5 | All data of a client idle for 14 days is deleted automatically |
| F6 | Web game exports can upload (CORS) |
| N1 | No secret is embedded in the distributed game |
| N2 | The game stays fully playable when Playtrail is unreachable |
| N3 | Runs within Cloudflare free tiers at the assumed volume |

## Integrator responsibilities

- **Consent:** upload only if the player has agreed. Opting out must also clear
  the local queue. The server cannot enforce this.
- **Identity:** use only the server-issued ID, never a device or hardware ID.
- **Hidden information:** logs may contain secret moves. Never expose them to
  players while a match is live.
- **Privacy notice:** state the 14-day idle retention. There is no on-demand
  erasure in v1.
- **Reading:** export data you want to keep before the client has been idle for
  14 days.

## Success criteria

- A retried upload never produces a second object.
- A client idle for 14 days has no objects after the next completed sweep.
- A forged or tampered upload is rejected.
- 1,000 batches a day stays within the free tiers.

## Phases

1. **v1:** register, signed upload, idle deletion, size cap, rate limit, billing
   alert.
2. **When abuse appears:** platform attestation at registration, then per-client
   quotas.

## Open questions

- Do integrators need "delete this player now" (`DELETE /v1/logs/{client_id}`)?
- Is 32 KB per batch enough for long games?
