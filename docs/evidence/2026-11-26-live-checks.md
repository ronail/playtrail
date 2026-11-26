# Evidence: live checks, 2026-11-26

Commit `8d0ae3c` on `main`. The deployment URL and account details are left out.

## Deploy run

[Run 45846565855](https://github.com/ronail/playtrail/actions/runs/45846565855),
second attempt (the first stopped before deploying because `BUILD_SEED` was not
set). `npm test` against the deployment:

```
ok 1 - register response is not cacheable
ok 2 - plain HTTP is refused
ok 3 - register returns id and key
ok 4 - register without a proof is refused
ok 5 - bad build proof is refused # SKIP
ok 6 - challenge has the expected shape
ok 7 - a challenge is not a client key
ok 8 - play token registers # SKIP
ok 9 - bad verdicts are refused # SKIP
ok 10 - bad play requests never reach Google # SKIP
ok 11 - google failure is retryable # SKIP
ok 12 - first upload 201, retry 200, object unchanged
ok 13 - bad signature, altered body, other client's id
ok 14 - missing or non-base64 signature
ok 15 - size limits
ok 16 - streamed oversize body
ok 17 - oversize body is rejected without reading it all # SKIP
ok 18 - bad paths
ok 19 - cors
ok 20 - an invalid limit override stops before wrangler runs
ok 21 - register is rate limited # SKIP
ok 22 - upload is rate limited # SKIP
ok 23 - register limit covers a whole IPv6 /64 # SKIP
# tests 23
# pass 14
# fail 0
# skipped 9
```

## Requests made afterwards

```
GET  https /v1/challenge:           200
POST https /v1/register, no proof:  401
POST http  /v1/register:            403
```

## Not checked

The skipped tests run only locally. Android is not configured, so no real Play
token was tried.
