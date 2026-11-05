<#
.SYNOPSIS
    Registers the v2 pipeline processes (worker-api + orchestrator, manager-api)
    as Windows services via nssm.

.DESCRIPTION
    Creates two services:
      - DropCloudWorkerV2  -> npm run start         (port 4101)
      - DropCloudManagerV2 -> npm run start:manager (port 4102)

    The v1 services (DropCloudWorker / DropCloudManager) are never touched.

    The service account must be supplied with a domain or local prefix
    (e.g. ".\service-acct" or "DOMAIN\service-acct"). nssm exits with code 6
    on a bare username, so we fail fast with a clear error if one is passed.

    Default StartType is Manual. Pass -StartType Automatic to opt into
    boot-time start.

    Re-running the script against an existing v2 install stops and removes
    the previous registration before re-creating it, so the script is
    idempotent.

.PARAMETER User
    The Windows account the services run under. MUST contain a "\"
    separator (e.g. ".\agent" for a local account, "CORP\agent" for a
    domain account).

.PARAMETER Password
    SecureString for the service account password. nssm requires this for
    non-system accounts.

.PARAMETER StartType
    "Manual" (default) or "Automatic". Manual matches the operator-opt-in
    policy for v2: the operator decides when to start the services.

.EXAMPLE
    $pw = Read-Host -AsSecureString
    .\install-services.ps1 -User '.\agent' -Password $pw

.EXAMPLE
    .\install-services.ps1 -User 'CORP\agent' -Password $pw -StartType Automatic
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$User,

    [Parameter(Mandatory = $true)]
    [System.Security.SecureString]$Password,

    [ValidateSet('Manual', 'Automatic')]
    [string]$StartType = 'Manual'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($User -notmatch '\\') {
    throw "User '$User' is a bare username. nssm exits 6 on bare names. Qualify with a prefix, e.g. '.\$User' (local) or 'DOMAIN\$User'."
}

$nssm = $env:NSSM_PATH
if ([string]::IsNullOrWhiteSpace($nssm)) {
    $nssm = 'C:\Drop-AI\Pipeline\nssm.exe'
}
if (-not (Test-Path -LiteralPath $nssm)) {
    throw "nssm executable not found at '$nssm'. Set the NSSM_PATH environment variable or place nssm at C:\Drop-AI\Pipeline\nssm.exe."
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path

$npmCmd = $env:NPM_CMD
if ([string]::IsNullOrWhiteSpace($npmCmd)) {
    $npmObj = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
    if (-not $npmObj) {
        throw "npm.cmd not found on PATH. Install Node.js 20+ and ensure npm is available, or set the NPM_CMD environment variable to the npm.cmd path."
    }
    $npmCmd = $npmObj.Source
}

$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password)
try {
    $plainPassword = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

$nssmStartValue = if ($StartType -eq 'Automatic') { 'SERVICE_AUTO_START' } else { 'SERVICE_DEMAND_START' }

$logDir = Join-Path $repoRoot 'shared\.cache'
if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

$services = @(
    [pscustomobject]@{
        Name      = 'DropCloudWorkerV2'
        NpmScript = 'start'
        PortEnv   = 'WORKER_API_PORT'
        Port      = 4101
    },
    [pscustomobject]@{
        Name      = 'DropCloudManagerV2'
        NpmScript = 'start:manager'
        PortEnv   = 'MANAGER_API_PORT'
        Port      = 4102
    }
)

function Invoke-Nssm {
    param([string[]]$NssmArgs)
    & $nssm @NssmArgs
    return $LASTEXITCODE
}

foreach ($svc in $services) {
    $name = $svc.Name

    & $nssm status $name | Out-Null
    $existed = ($LASTEXITCODE -eq 0)
    if ($existed) {
        Write-Host "Stopping existing $name"
        & $nssm stop $name confirm | Out-Null
        Write-Host "Removing existing $name"
        $rc = Invoke-Nssm -NssmArgs @('remove', $name, 'confirm')
        if ($rc -ne 0) {
            throw "nssm remove '$name' failed (exit $rc)"
        }
    }

    Write-Host "Installing $name -> $npmCmd run $($svc.NpmScript) (port $($svc.Port))"
    $rc = Invoke-Nssm -NssmArgs @('install', $name, $npmCmd, 'run', $svc.NpmScript)
    if ($rc -ne 0) {
        throw "nssm install '$name' failed (exit $rc)"
    }

    $rc = Invoke-Nssm -NssmArgs @('set', $name, 'AppDirectory', $repoRoot)
    if ($rc -ne 0) { throw "nssm set AppDirectory failed for '$name' (exit $rc)" }

    $rc = Invoke-Nssm -NssmArgs @('set', $name, 'Start', $nssmStartValue)
    if ($rc -ne 0) { throw "nssm set Start failed for '$name' (exit $rc)" }

    $rc = Invoke-Nssm -NssmArgs @('set', $name, 'ObjectName', $User, $plainPassword)
    if ($rc -ne 0) { throw "nssm set ObjectName failed for '$name' (exit $rc; nssm returns 6 for a bare username)" }

    $rc = Invoke-Nssm -NssmArgs @('set', $name, 'AppEnvironmentExtra', ("{0}={1}" -f $svc.PortEnv, $svc.Port))
    if ($rc -ne 0) { throw "nssm set AppEnvironmentExtra failed for '$name' (exit $rc)" }

    $rc = Invoke-Nssm -NssmArgs @('set', $name, 'AppStdout', (Join-Path $logDir ("{0}.out.log" -f $name)))
    if ($rc -ne 0) { throw "nssm set AppStdout failed for '$name' (exit $rc)" }

    $rc = Invoke-Nssm -NssmArgs @('set', $name, 'AppStderr', (Join-Path $logDir ("{0}.err.log" -f $name)))
    if ($rc -ne 0) { throw "nssm set AppStderr failed for '$name' (exit $rc)" }

    Write-Host "Installed $name (User=$User, StartType=$StartType)"
}

$plainPassword = $null
[System.GC]::Collect()

Write-Host "Done. v2 services registered but not started. Use 'nssm start <name>' or services.msc when ready."
