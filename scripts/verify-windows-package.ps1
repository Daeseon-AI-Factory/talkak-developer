param([switch]$ReleaseSmoke)

$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$releaseDirectory = Join-Path $repositoryRoot "src-tauri/target/release"
$bundleDirectory = Join-Path $releaseDirectory "bundle/nsis"
$releaseExecutable = Join-Path $releaseDirectory "talkak-dev.exe"
$installDirectory = Join-Path $env:LOCALAPPDATA "Talkak Dev"
$installedExecutable = Join-Path $installDirectory "talkak-dev.exe"
$uninstaller = Join-Path $installDirectory "uninstall.exe"
$profileIdentifier = if ($ReleaseSmoke) { "dev.talkak.desktop" } else { "main/talkak-windows-ci" }
$profileDirectory = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA $profileIdentifier))
$localAppDataRoot = [System.IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $profileDirectory.StartsWith($localAppDataRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "The selected profile is outside LOCALAPPDATA: $profileDirectory"
}
$installAttempted = $false
$profileOwnedByThisRun = $false
$projectOwnedByThisRun = $false
$projectDirectory = $null
$runnerTempRoot = $null
$appProcess = $null
$successMessage = $null
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
  if (Test-Path -LiteralPath $profileDirectory) {
    throw "Clean profile precondition failed because the data directory already exists: $profileDirectory"
  }
  $profileOwnedByThisRun = $true

  if (-not $ReleaseSmoke) {
    if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP) -or -not [System.IO.Path]::IsPathRooted($env:RUNNER_TEMP)) {
      throw "RUNNER_TEMP must be an absolute directory for the Windows product E2E"
    }
    if (-not (Test-Path -LiteralPath $env:RUNNER_TEMP -PathType Container)) {
      throw "RUNNER_TEMP must exist as a directory for the Windows product E2E: $env:RUNNER_TEMP"
    }
    $runnerTempRoot = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd([char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)) + [System.IO.Path]::DirectorySeparatorChar
    $projectDirectory = [System.IO.Path]::GetFullPath((Join-Path $runnerTempRoot "Talkak empty project-$([guid]::NewGuid().ToString("N"))"))
    if (-not $projectDirectory.StartsWith($runnerTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "The isolated E2E project must stay inside RUNNER_TEMP: $projectDirectory"
    }
    if (Test-Path -LiteralPath $projectDirectory) {
      throw "The isolated E2E project directory already exists: $projectDirectory"
    }
    New-Item -ItemType Directory -Path $projectDirectory | Out-Null
    $projectOwnedByThisRun = $true
  }

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

  if ($ReleaseSmoke) {
    $appProcess = Start-Process -FilePath $installedExecutable -PassThru
    if ($appProcess.WaitForExit(5000)) {
      throw "The installed Windows release exited during the launch smoke with code $($appProcess.ExitCode)"
    }
    $successMessage = "WINDOWS_RELEASE_INSTALL_LAUNCH_OK: $($installer.FullName) -> $installedExecutable"
  } else {
    $env:TALKAK_WINDOWS_APP = $installedExecutable
    $env:TALKAK_WINDOWS_PROJECT = $projectDirectory
    & pnpm e2e:windows
    if ($LASTEXITCODE -ne 0) {
      throw "The installed Windows product E2E suite exited with code $LASTEXITCODE"
    }
    $successMessage = "WINDOWS_PRODUCT_E2E_OK: $($installer.FullName) -> $installedExecutable"
  }
} catch {
  $testError = $_
} finally {
  foreach ($variable in @("TALKAK_WINDOWS_APP", "TALKAK_WINDOWS_PROJECT")) {
    try {
      Remove-Item "Env:$variable" -ErrorAction SilentlyContinue
    } catch {
      $cleanupErrors += "Could not clear $variable`: $($_.Exception.Message)"
    }
  }

  if ($null -ne $appProcess -and -not $appProcess.HasExited) {
    try {
      Stop-Process -Id $appProcess.Id -Force
      $appProcess.WaitForExit()
    } catch {
      $cleanupErrors += "The release smoke process could not be stopped: $($_.Exception.Message)"
    }
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

  if ($profileOwnedByThisRun -and $profileDirectory.StartsWith($localAppDataRoot, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $profileDirectory)) {
    try {
      Remove-Item -LiteralPath $profileDirectory -Recurse -Force
    } catch {
      $cleanupErrors += "The isolated profile could not be removed: $($_.Exception.Message)"
    }
  }

  if ($projectOwnedByThisRun -and $null -ne $runnerTempRoot -and $null -ne $projectDirectory -and $projectDirectory.StartsWith($runnerTempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $projectDirectory)) {
    try {
      Remove-Item -LiteralPath $projectDirectory -Recurse -Force
    } catch {
      $cleanupErrors += "The isolated E2E project could not be removed: $($_.Exception.Message)"
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

Write-Host $successMessage
