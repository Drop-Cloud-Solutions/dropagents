# Prerequisites

What a worker machine needs, why it needs it, and how to install it.

Two groups, and the distinction matters when you are triaging a failure:

- **The pipeline's own runtime** — without these, nothing starts.
- **The toolchain the agents drive** — the pipeline starts fine without
  these, and then tasks fail one by one as agents reach for a missing
  binary. If you are only evaluating the pipeline against a repo it will
  not build, you can defer them.

> Package IDs drift between winget releases. If an `install` below reports
> "No package found", run `winget search <name>` and use what it prints —
> the ID is the only part that goes stale, not the choice of package.

---

## The pipeline's own runtime

### Node.js 20 or newer — required

The whole orchestrator is TypeScript on Node. `package.json` declares
`"node": ">=20"`.

```powershell
winget install OpenJS.NodeJS.LTS
```

Verify, in a NEW shell so PATH is picked up:

```powershell
node --version    # v20.x or newer
npm --version
```

`better-sqlite3` is a native module. It ships prebuilt binaries for common
platforms, so a normal `npm ci` needs no compiler. If npm falls back to
building from source you will need C++ build tools — on Windows that is the
"Desktop development with C++" workload from Visual Studio Build Tools.

### Git — required

The pipeline clones repos, creates a worktree per task, commits, and pushes.

```powershell
winget install Git.Git
```

The service account needs push credentials for your repos. Use a credential
helper or an SSH key that works **non-interactively** — an agent cannot
answer a passphrase prompt, and a task that hits one hangs until it times
out rather than failing cleanly.

### Claude CLI — required (in any real setup)

The agent runtime. The pipeline spawns `claude` as a child process per agent
run.

```powershell
npm install -g @anthropic-ai/claude-code
claude --version
```

Then authenticate, once, on the machine:

```powershell
claude setup-token
```

Put the token in `CLAUDE_CODE_OAUTH_TOKEN` (or use `ANTHROPIC_API_KEY`
instead). See [Agents](agents.md#authentication) — this is the single most
common cause of "every task fails at once".

You can defer this: with `AGENT_RUNNER=fake` the pipeline runs a synthetic
in-memory runner, which is enough to exercise the board, flows and
projections without spending tokens.

### GitHub CLI (`gh`) — required for pull requests

The committer opens PRs through `gh`. Without it, tasks reach the commit
step and stop there.

```powershell
winget install GitHub.cli
gh auth login
```

Authenticate as the account whose PRs you want to see, and confirm it is
non-interactive afterwards: `gh auth status`.

---

## The toolchain the agents drive

These are needed because of what *your* repos are. A pipeline pointed at
different repos needs a different list — which is the point: nothing below
is wired into the orchestrator, the agents just run the commands the repos
expect. What follows is what the `dotnet-azure` stack pack assumes; if your
workspace is a different stack, skip it and install that stack's toolchain
instead.

### .NET SDK — only if your repos are .NET

The developer, reviewer and tester agents run `dotnet build` and
`dotnet test` against repos that are .NET.

```powershell
winget search Microsoft.DotNet.SDK      # confirm the current major
winget install Microsoft.DotNet.SDK.10
dotnet --list-sdks
```

### PowerShell 7 (`pwsh`) — only for script-running task types

The `dotnet-azure` pack's deploy tasks run the target repo's `Deploy/*.ps1`,
and its publish tasks run `nuget_package_publish.ps1`. On Windows these can run under the built-in
`powershell.exe`; on macOS and Linux `pwsh` is the only edition that exists.

```powershell
winget install Microsoft.PowerShell
```

### Azure CLI — required for Azure deploys and diagnostics

```powershell
winget install Microsoft.AzureCLI
```

The `az` CLI does **not** read `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`
from the environment — it trusts only its own login cache. That is why the
deploy persona runs `az login --service-principal` itself when a command
reports a missing token. Setting the three `AZURE_*` variables is what makes
headless deployment work; see [Environment](environment.md#azure).

### Azure Functions Core Tools — required to run or deploy Functions apps

```powershell
winget search FunctionsCoreTools
winget install Microsoft.Azure.FunctionsCoreTools
```

### NSSM — only if you want Windows services

Used by [`scripts/install-services.ps1`](../scripts/install-services.ps1) to
register the worker and manager as services. It is not on winget reliably;
download it from [nssm.cc](https://nssm.cc/download) and either place
`nssm.exe` at `C:\Drop-AI\Pipeline\nssm.exe` or point `NSSM_PATH` at it.

You do not need this to run the pipeline — see
[Getting started](getting-started.md#step-7--decide-how-the-processes-stay-running).

---

## Platform notes

The pipeline is developed and deployed on **Windows**, and that is the
best-tested path.

It also runs on **macOS and Linux**: every Windows-specific behaviour
(process-tree kills, `shell: true` and the cmd.exe quoting it forces, the
argv size cap that pushes prompts onto stdin) sits behind a platform check
with a working POSIX branch, and the workspace root defaults to
`~/Drop-AI/Source` off Windows.

Two things do not carry over:

- There is **no launchd or systemd equivalent** of the service installer.
  Run the processes yourself, or write your own units.
- The repo toolchain still has to be there. `Deploy/*.ps1` needs `pwsh`
  installed on the Mac; the pipeline being portable does not make those
  scripts portable.

---

## Quick verification

Run this before you start configuring. Anything missing here will surface
later as a confusing agent failure rather than a clear startup error.

```powershell
node --version      # v20+
npm --version
git --version
claude --version
gh auth status
dotnet --list-sdks
pwsh --version
az version
```

Next: [Getting started](getting-started.md).
