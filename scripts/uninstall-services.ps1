<#
.SYNOPSIS
    Removes the v2 pipeline Windows services (DropCloudWorkerV2,
    DropCloudManagerV2). The v1 services (DropCloudWorker,
    DropCloudManager) are NEVER touched.

.DESCRIPTION
    Stops and removes only the two v2-suffixed nssm services. Services
    that are not installed are reported and skipped, so running this on
    a clean machine is safe.

.EXAMPLE
    .\uninstall-services.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$nssm = $env:NSSM_PATH
if ([string]::IsNullOrWhiteSpace($nssm)) {
    $nssm = 'C:\Drop-AI\Pipeline\nssm.exe'
}
if (-not (Test-Path -LiteralPath $nssm)) {
    throw "nssm executable not found at '$nssm'. Set the NSSM_PATH environment variable or place nssm at C:\Drop-AI\Pipeline\nssm.exe."
}

$v2Services = @('DropCloudWorkerV2', 'DropCloudManagerV2')

foreach ($name in $v2Services) {
    & $nssm status $name | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Service '$name' not installed - skipping"
        continue
    }
    Write-Host "Stopping '$name'"
    & $nssm stop $name confirm | Out-Null
    Write-Host "Removing '$name'"
    & $nssm remove $name confirm | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "nssm remove '$name' failed (exit $LASTEXITCODE)"
    }
    Write-Host "Removed '$name'"
}
