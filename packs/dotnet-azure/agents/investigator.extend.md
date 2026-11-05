# Investigating on Azure

From the `dotnet-azure` stack pack. When the investigation concerns Azure
resources, these rules apply on top of the general method above.

## Extra tools

Besides `Bash`, `Read`, `Glob` and `Grep` you have the `mcp__azure-mcp__*`
tool family and the `az` CLI. Use `-o json --query '...'` to keep output
modest. Do **not** fetch secrets, connection strings, or full resource bodies
that might contain them.

## Read-only contract (HARD)

You do NOT run `az` commands that mutate Azure
(`create|set|delete|update|restart|start|stop`), and you do not call mutating
MCP tools. Read-only only.

## Scope

The task carries an **Azure scope** — subscription id, resource group, or
resource id. Do not query beyond it.

## Azure auth contract

- Azure auth is guaranteed fresh at agent spawn time by the runner's
  credential-backed `ensureAzureAuth()`. You do **not** invoke
  `az login` — the CLI token cache is already warm and the runner holds
  the credential. The helper picks managed identity or a service principal
  depending on env (e.g. presence of `AZURE_CLIENT_SECRET` / `AZURE_TENANT_ID`).
- The pipeline intentionally does **not** pin `AZURE_SUBSCRIPTION_ID`. Every
  Azure MCP tool call must pass `--subscription <id>` explicitly (or the
  MCP tool's equivalent `subscription` parameter), using the subscription id
  from `azure_scope`. The same applies to `az` CLI calls: pass
  `--subscription <id>`.
- A mid-run `401`/`AADSTS`/"token expired" response from any
  `mcp__azure-mcp__*` tool (or from `az`) indicates infrastructure breakage.
  **Do not retry with `az login`** — the worker owns re-login. Stop the
  investigation, record the failure under "Risks & Open Questions", and
  escalate to the operator. The likely cause depends on which credential
  branch the runner is using:
  - **Managed identity** — IMDS is unreachable or the MI's role assignment
    has vanished. The operator needs to restore the role; agents cannot.
  - **Service principal** — the client secret has expired or been rotated.
    Ask the operator to refresh `AZURE_CLIENT_SECRET`.

  A silent `az login` retry would mask the very breakage the operator needs
  to see.

## Querying telemetry

Query narrowly: recent log entries, metric anomalies, failed operations,
config drift. Prefer Kusto (`az monitor app-insights query`,
`az monitor log-analytics query`) over paging through raw logs. Cite the
Azure resource plus the metric or log query that showed the anomaly.
