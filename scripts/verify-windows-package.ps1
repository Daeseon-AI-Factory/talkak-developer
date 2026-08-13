$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$releaseDirectory = Join-Path $repositoryRoot "src-tauri/target/release"
$bundleDirectory = Join-Path $releaseDirectory "bundle/nsis"
$releaseExecutable = Join-Path $releaseDirectory "talkak-dev.exe"
$installDirectory = Join-Path $env:LOCALAPPDATA "Talkak Dev"
$installedExecutable = Join-Path $installDirectory "talkak-dev.exe"
$uninstaller = Join-Path $installDirectory "uninstall.exe"
$e2eDataDirectory = Join-Path $env:LOCALAPPDATA "main/talkak-windows-ci"
$installAttempted = $false
$profileOwnedByThisRun = $false
$testError = $null
$cleanupErrors = @()

try {
  if (-not (Test-Path -LiteralPath $releaseExecutable -PathType Leaf)) {
    throw "Windows release executable was not created: $releaseExecutable"
  }

  $installer = Get-ChildItem -LiteralPath $bundleDirectory -Filter "*-setup.exe" -File |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1

  if ($null -eq $installer -or $installer.Length -le 0) {
    throw "A non-empty NSIS installer was not created in $bundleDirectory"
  }

  if (Test-Path -LiteralPath $installDirectory) {
    throw "Clean-install precondition failed because the install directory already exists: $installDirectory"
  }
  if (Test-Path -LiteralPath $e2eDataDirectory) {
    throw "Clean E2E profile precondition failed because the data directory already exists: $e2eDataDirectory"
  }
  $profileOwnedByThisRun = $true

  $installAttempted = $true
  $installProcess = Start-Process -FilePath $installer.FullName -ArgumentList "/S" -PassThru -Wait
  if ($installProcess.ExitCode -ne 0) {
    throw "The NSIS installer exited with code $($installProcess.ExitCode)"
  }
  if (-not (Test-Path -LiteralPath $installedExecutable -PathType Leaf)) {
    throw "The installed Talkak executable was not found: $installedExecutable"
  }
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    throw "The NSIS uninstaller was not found: $uninstaller"
  }

  $env:TALKAK_WINDOWS_APP = $installedExecutable
  & pnpm e2e:windows
  if ($LASTEXITCODE -ne 0) {
    throw "The installed Windows product E2E suite exited with code $LASTEXITCODE"
  }

  Write-Host "WINDOWS_PRODUCT_E2E_OK: $($installer.FullName) -> $installedExecutable"
} catch {
  $testError = $_
} finally {
  try {
    Remove-Item Env:TALKAK_WINDOWS_APP -ErrorAction SilentlyContinue
  } catch {
    $cleanupErrors += "Could not clear TALKAK_WINDOWS_APP: $($_.Exception.Message)"
  }

  if ($installAttempted -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    try {
      $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList "/S" -PassThru -Wait
      if ($uninstallProcess.ExitCode -ne 0) {
        $cleanupErrors += "The NSIS uninstaller exited with code $($uninstallProcess.ExitCode)"
      }
    } catch {
      $cleanupErrors += "The NSIS uninstaller could not run: $($_.Exception.Message)"
    }
  }

  if ($installAttempted -and (Test-Path -LiteralPath $installDirectory)) {
    $cleanupErrors += "The installation attempt left its directory behind: $installDirectory"
    try {
      Remove-Item -LiteralPath $installDirectory -Recurse -Force
    } catch {
      $cleanupErrors += "The residual installation directory could not be removed: $($_.Exception.Message)"
    }
  }

  if ($profileOwnedByThisRun -and (Test-Path -LiteralPath $e2eDataDirectory)) {
    try {
      Remove-Item -LiteralPath $e2eDataDirectory -Recurse -Force
    } catch {
      $cleanupErrors += "The isolated E2E profile could not be removed: $($_.Exception.Message)"
    }
  }

  if ($cleanupErrors.Count -gt 0) {
    $cleanupMessage = $cleanupErrors -join "; "
    if ($null -eq $testError) {
      $testError = $cleanupMessage
    } else {
      $primaryMessage = if ($testError -is [System.Management.Automation.ErrorRecord]) {
        $testError.Exception.Message
      } else {
        [string]$testError
      }
      $testError = "$primaryMessage Cleanup failures: $cleanupMessage"
    }
  }
}

if ($null -ne $testError) {
  throw $testError
}
