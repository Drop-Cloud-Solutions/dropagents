# Azure diagnosis proposals

From the `dotnet-azure` stack pack. This install can also propose
`Type: diagnose-azure` on a `PROPOSE_TASK` block.

- `diagnose-azure` — LIVE errors/performance in a test or production
  Azure environment ("500s in prd", "is the service bus backing up?",
  "stg is slow"). The azure-diagnostician queries App Insights / Log
  Analytics / metrics read-only and reports evidence + likely owner.
  Not repo-bound — prefer filing it in a shared platform project.

Use `investigate` instead when the question is about the code rather than a
live environment.
