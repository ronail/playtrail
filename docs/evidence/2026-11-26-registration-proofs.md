# Evidence: registration proofs, 2026-11-26

Local only (`wrangler dev`; Google is a stand-in in the tests). Nothing deployed.

Commit `356769e`.

## `npm run check`

```

> check
> tsc --noEmit

```

## `npm test`

```
ok 1 - register response is not cacheable
ok 2 - plain HTTP is refused
ok 3 - register returns id and key
ok 4 - register without a proof is refused
ok 5 - bad build proof is refused
ok 6 - challenge has the expected shape
ok 7 - a challenge is not a client key
ok 8 - play token registers
ok 9 - bad verdicts are refused
ok 10 - bad play requests never reach Google
ok 11 - google failure is retryable
ok 12 - first upload 201, retry 200, object unchanged
ok 13 - bad signature, altered body, other client's id
ok 14 - missing or non-base64 signature
ok 15 - size limits
ok 16 - streamed oversize body
ok 17 - oversize body is rejected without reading it all
ok 18 - bad paths
ok 19 - cors
ok 20 - an invalid limit override stops before wrangler runs
ok 21 - register is rate limited
ok 22 - upload is rate limited
ok 23 - register limit covers a whole IPv6 /64
# tests 23
# pass 23
# fail 0
# skipped 0
```

## Not verified

- A real Play Integrity token registering, and the same token refused on reuse
  (needs a service account and a device).
- App Attest: the spike was not run (needs a real attestation). iOS cannot
  register with these changes.
- Godot web signing and the Android/iOS plugins (client repositories).
- Anything on a deployment, including CPU time for the RS256 signature.
