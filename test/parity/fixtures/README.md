# Parity fixtures

One YAML fixture per **retained** v1 task type. Each fixture is the
behaviour contract `dropagents` must reproduce against the v1
commit pinned in [`REFERENCE_BASELINE`](../../../REFERENCE_BASELINE).

The fixtures are load-bearing: `scripts/parity-smoke.ts` enumerates
this directory at the start of every run and fails non-zero if the set
of fixtures drifts from the retained list, if any cut-list task type
gains a fixture, or if any fixture's `reference_sha` falls out of sync
with `REFERENCE_BASELINE`. CI runs `npm run parity-smoke` as a required
step (`.github/workflows/ci.yml`).

## Retained task types

| Task type          | Fixture                  | Track  |
|--------------------|--------------------------|--------|
| implement          | `implement.yaml`         | 1      |
| refactor           | `refactor.yaml`          | 1      |
| scaffold           | `scaffold.yaml`          | 0      |
| integration-test   | `integration-test.yaml`  | 2      |
| document           | `document.yaml`          | 3      |
| deploy-azure       | `deploy-azure.yaml`      | 4      |
| deploy-verify      | `deploy-verify.yaml`     | 4      |
| review-codebase    | `review-codebase.yaml`   | 5      |
| review-azure       | `review-azure.yaml`      | 5      |
| scaffold-repo      | `scaffold-repo.yaml`     | 6      |
| investigate        | `investigate.yaml`       | 0      |

## Cut list (no fixtures)

The following v1 task types are **permanently** out of scope for v2.
Adding a fixture for any of them fails parity-smoke.

- `swagger` — schema/codegen flow retired with the swagger-writer agent.
- `deploy-nuget` — NuGet-publish flow retired; v2 only ships Azure
  deployments (`deploy-azure` / `deploy-verify`).
- `bump-package-reference` — package-bumper retired; cross-repo NuGet
  refs are now resolved through the manager-api at boot.

Each cut type's rationale is the bullet above it; the agent roles that
existed only to serve them (swagger-writer, package-bumper) were retired at
the same time.

## Fixture format

```yaml
task_type: <retained task type name>          # required, unique
reference_sha: <40-char hex>                  # required, must equal REFERENCE_BASELINE
status: pending | green | red                 # required
owner: track-<n>                              # required, parity track id
description: |                                # one-paragraph operator-readable summary
  ...
expected_events:                              # ordered list of bus events the round-trip emits
  - PlanApproved
  - ...
retained: true                                # always true for files in this directory
notes: |                                      # optional caveats, prior-incident memory
  ...
```

`status: pending` is the default — the fixture is authored but the
harness does not yet drive it end-to-end. `status: green` means a
matching round-trip in `scripts/parity-smoke.ts` (or a future runner
the decomposed sub-tasks add) exercises it. `status: red` is an open
parity defect and blocks promotion.

The fixture's `task_type` field is canonical; the filename is for human
navigation only — `scripts/parity-smoke.ts` reads `task_type` from
inside the file, not from the filename.
