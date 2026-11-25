# Test evidence: CI runs only on `main`, 2026-11-25

## Change checked locally

```
npm run check: tsc --noEmit, exit 0
npm test:      # tests 10  # pass 10  # fail 0  # skipped 0
workflow YAML: triggers: push; jobs: test,deploy
```

The new trigger cannot be run before the merge: it only fires on `main`.

## First deploy from CI (previous merge to `main`)

<https://github.com/ronail/playtrail/actions/runs/45628913289>

```
test job:   success
deploy job: success
  Deployed playtrail
  # tests 10  # pass 8  # fail 0  # skipped 2 (local only)
```
