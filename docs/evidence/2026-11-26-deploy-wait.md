# Evidence: wait after deploy, 2026-11-26

## The failure

The `main` run for [PR #4](https://github.com/ronail/playtrail/pull/4) (run
45845603919). Step times and results from its log:

```
Run npm run deploy=success 15:06:20Z..15:06:26Z
Run npm test=failure       15:06:26Z..15:06:32Z

15:06:26.75  not ok 1 - register response is not cacheable   (null !== 'no-store')
15:06:26.83  not ok 2 - plain HTTP is refused                (200 !== 403)
# tests 15  # pass 9  # fail 2  (4 skipped)
```

Both failures are behaviour that is new in that deploy.

Requests to the deployment some minutes later:

```
http OPTIONS /v1/register:   403
https OPTIONS:               204, strict-transport-security: max-age=31536000
https POST /v1/register:     200, cache-control: no-store, strict-transport-security: max-age=31536000
http POST /v1/register:      403
```

So the tests most likely reached the previous version. How long the new one takes
to be served was not measured, and 30 s is not a documented bound.

## Local, with the change

```
npm run check: exit 0
npm test: # tests 15, # pass 15, # fail 0, # skipped 0
```

The workflow file parses as YAML.

## Not verified

- The deploy job with the wait: it runs only on a push to `main`.
