# Test evidence: rate limit overrides (2026-11-25)

Local only: Wrangler 4.168.0, Node 22.22.3, macOS. Nothing was deployed.

## `npm run check`

```
$ npm run check

> check
> tsc --noEmit

exit 0
```

## `npm test` with defaults, overrides and empty values

Filtered to result lines. The 1/1 run is slow because the suite waits out the limit.

```
$ npm test
ok 1 - register returns id and key
ok 2 - first upload 201, retry 200, object unchanged
ok 3 - bad signature, altered body, other client's id
ok 4 - missing or non-base64 signature
ok 5 - size limits
ok 6 - streamed oversize body
ok 7 - oversize body is rejected without reading it all
ok 8 - bad paths
ok 9 - cors
ok 10 - an invalid limit override stops before wrangler runs
ok 11 - register is rate limited
ok 12 - upload is rate limited
# tests 12
# pass 12
# fail 0
# skipped 0
# duration_ms 2501.569375

$ REGISTER_LIMIT=20 UPLOAD_LIMIT=60 npm test
ok 1 - register returns id and key
ok 2 - first upload 201, retry 200, object unchanged
ok 3 - bad signature, altered body, other client's id
ok 4 - missing or non-base64 signature
ok 5 - size limits
ok 6 - streamed oversize body
ok 7 - oversize body is rejected without reading it all
ok 8 - bad paths
ok 9 - cors
ok 10 - an invalid limit override stops before wrangler runs
ok 11 - register is rate limited
ok 12 - upload is rate limited
# tests 12
# pass 12
# fail 0
# skipped 0
# duration_ms 2373.634334

$ REGISTER_LIMIT=1 UPLOAD_LIMIT=1 npm test
ok 1 - register returns id and key
ok 2 - first upload 201, retry 200, object unchanged
ok 3 - bad signature, altered body, other client's id
ok 4 - missing or non-base64 signature
ok 5 - size limits
ok 6 - streamed oversize body
ok 7 - oversize body is rejected without reading it all
ok 8 - bad paths
ok 9 - cors
ok 10 - an invalid limit override stops before wrangler runs
ok 11 - register is rate limited
ok 12 - upload is rate limited
# tests 12
# pass 12
# fail 0
# skipped 0
# duration_ms 102955.195333

$ REGISTER_LIMIT= UPLOAD_LIMIT= npm test
ok 1 - register returns id and key
ok 2 - first upload 201, retry 200, object unchanged
ok 3 - bad signature, altered body, other client's id
ok 4 - missing or non-base64 signature
ok 5 - size limits
ok 6 - streamed oversize body
ok 7 - oversize body is rejected without reading it all
ok 8 - bad paths
ok 9 - cors
ok 10 - an invalid limit override stops before wrangler runs
ok 11 - register is rate limited
ok 12 - upload is rate limited
# tests 12
# pass 12
# fail 0
# skipped 0
# duration_ms 2795.79525

```

## The override changes the running server

```
$ npm run dev  # fresh state, then 7 x POST /v1/register
200 200 200 200 200 429 429 
$ REGISTER_LIMIT=2 npm run dev  # fresh state, then 7 x POST /v1/register
200 200 429 429 429 429 429 
```

## What would be deployed (`--dry-run`)

```
$ REGISTER_LIMIT=20 UPLOAD_LIMIT=60 npm run deploy -- --dry-run
REGISTER_LIMIT overridden: 20 per period
UPLOAD_LIMIT overridden: 60 per period

 ⛅️ wrangler 4.168.0
────────────────────
Total Upload: 3.35 KiB / gzip: 1.47 KiB
Your Worker has access to the following bindings:
Binding                                   Resource        
env.BUCKET (playtrail-logs)               R2 Bucket       
env.REGISTER_LIMIT (20 requests/60s)      Rate Limit      
env.UPLOAD_LIMIT (60 requests/60s)        Rate Limit      

--dry-run: exiting now.

$ npm run deploy -- --dry-run

 ⛅️ wrangler 4.168.0
────────────────────
Total Upload: 3.35 KiB / gzip: 1.47 KiB
Your Worker has access to the following bindings:
Binding                                   Resource        
env.BUCKET (playtrail-logs)               R2 Bucket       
env.REGISTER_LIMIT (5 requests/60s)       Rate Limit      
env.UPLOAD_LIMIT (10 requests/60s)        Rate Limit      

--dry-run: exiting now.

$ diff wrangler.toml wrangler.limits.toml
12c12
< simple = { limit = 5, period = 60 }
---
> simple = { limit = 20, period = 60 }
17c17
< simple = { limit = 10, period = 60 }
---
> simple = { limit = 60, period = 60 }
```

## Invalid values stop before Wrangler runs

```
$ UPLOAD_LIMIT='abc' npm run deploy -- --dry-run
UPLOAD_LIMIT must be a positive whole number, got "abc"
exit 1
$ UPLOAD_LIMIT='0' npm run deploy -- --dry-run
UPLOAD_LIMIT must be a positive whole number, got "0"
exit 1
$ UPLOAD_LIMIT='-1' npm run deploy -- --dry-run
UPLOAD_LIMIT must be a positive whole number, got "-1"
exit 1
$ UPLOAD_LIMIT='1.5' npm run deploy -- --dry-run
UPLOAD_LIMIT must be a positive whole number, got "1.5"
exit 1
$ UPLOAD_LIMIT=' 5' npm run deploy -- --dry-run
UPLOAD_LIMIT must be a positive whole number, got " 5"
exit 1
$ UPLOAD_LIMIT='1e3' npm run deploy -- --dry-run
UPLOAD_LIMIT must be a positive whole number, got "1e3"
exit 1
$ UPLOAD_LIMIT='99999999999999999999' npm run deploy -- --dry-run
UPLOAD_LIMIT must be a positive whole number, got "99999999999999999999"
exit 1
```

## Not verified

- No deployment with an overridden limit, and no `BASE_URL=...` run, so the
  wait-and-retry path against a deployment has not run.
- The CI deploy step with the repository variables set or unset (it runs only on a
  push to `main`).
- Which large values Cloudflare accepts for `limit`; no maximum is documented.
