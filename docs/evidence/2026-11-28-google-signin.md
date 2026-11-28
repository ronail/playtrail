# Google sign-in: local test run, 2026-11-28

`npm run check` and `npm test` on this branch (local Worker, Google replaced by a stand-in). Test output is filtered to result and summary lines.

```
> check
> tsc --noEmit
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
ok 12 - a bad google token is refused
ok 13 - google sign-in registers, and the same account keeps its id
ok 14 - bad google tokens are refused
ok 15 - junk google requests never fetch keys
ok 16 - unfetchable google keys are retryable
ok 17 - google keys are cached for max-age
ok 18 - first upload 201, retry 200, object unchanged
ok 19 - bad signature, altered body, other client's id
ok 20 - missing or non-base64 signature
ok 21 - size limits
ok 22 - streamed oversize body
ok 23 - oversize body is rejected without reading it all
ok 24 - bad paths
ok 25 - cors
ok 26 - an invalid limit override stops before wrangler runs
ok 27 - register is rate limited
ok 28 - upload is rate limited
ok 29 - register limit covers a whole IPv6 /64
# tests 29
# pass 29
# fail 0
# skipped 0
```

Not tested: a real Google ID token, a deployment, the Godot client, and an unset
`GOOGLE_CLIENT_ID` (the local server always sets it). "a bad google token is
refused" also runs against a deployment, but it only shows that junk gets 401:
that was already true before this feature.
