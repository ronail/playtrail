<!-- Keep every section in this template. Fill it in rather than replacing it
     with a custom PR body. Mark sections that don't apply as n/a. -->

## Summary

What this PR does and why.

## Type of Change

- [ ] Bug fix
- [ ] API behaviour change (status codes, limits, headers, wire format)
- [ ] Storage, rate limit or `wrangler.toml` change
- [ ] Documentation only
- [ ] Other:

## Changes

-

## Test Evidence

- [ ] `npm test` passes locally (paste the summary line)
- [ ] `npm run check` passes
- [ ] Storage, rate limit or `wrangler.toml` behaviour changed: tested against a deployment with `BASE_URL=... npm test`, and the TRD Verification section is updated (or n/a)

## Checklist

- [ ] Uploads stay put-if-absent: a retry never overwrites, and 200 is returned only if the object exists
- [ ] Bodies are never buffered past 32 KB, and the signature covers `client_id + "\n" + batch_id + "\n" + body`
- [ ] The upload limit is applied after the signature check
- [ ] No stored per-client state: keys are still derived from `MASTER_KEY`
- [ ] CORS headers are still set on every response, including errors
- [ ] New behaviour has a test in `test/api.test.mjs`
- [ ] README, `docs/PRD.md` and `docs/TRD.md` are updated in this PR where behaviour or setup changed
- [ ] No secrets, `.dev.vars`, deployment URLs or Cloudflare account IDs are committed (the repo is public)
