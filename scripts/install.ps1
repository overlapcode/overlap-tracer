# Overlap tracer installer for Windows
# Usage: irm https://overlap.dev/install.ps1 | iex
$ErrorActionPreference = "Stop"

$Repo = "overlapcode/overlap-tracer"
$BinaryName = "overlap.exe"

# ── Detect architecture ──────────────────────────────────────────────────

$Arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else {
    Write-Host "  ✗ 32-bit Windows is not supported." -ForegroundColor Red
    exit 1
}

$AssetName = "overlap-windows-$Arch.exe"

# ── Install directory ────────────────────────────────────────────────────

$InstallDir = Join-Path $env:USERPROFILE ".overlap\bin"
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# ── Get latest release ───────────────────────────────────────────────────

Write-Host ""
Write-Host "  Overlap tracer installer" -ForegroundColor White
Write-Host ""

try {
    $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
    $Version = $Release.tag_name
} catch {
    Write-Host "  ✗ Could not determine latest release." -ForegroundColor Red
    Write-Host "    Check: https://github.com/$Repo/releases"
    exit 1
}

$DownloadUrl = "https://github.com/$Repo/releases/download/$Version/$AssetName"
$DestPath = Join-Path $InstallDir $BinaryName

Write-Host "  Platform:  windows-$Arch" -ForegroundColor DarkGray
Write-Host "  Version:   $Version" -ForegroundColor DarkGray
Write-Host "  Install:   $DestPath" -ForegroundColor DarkGray
Write-Host ""

# ── Download ─────────────────────────────────────────────────────────────

Write-Host "  Downloading $AssetName..."
try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $DestPath -UseBasicParsing
} catch {
    Write-Host "  ✗ Download failed. Binary may not exist for windows-$Arch." -ForegroundColor Red
    Write-Host "    Check: https://github.com/$Repo/releases/tag/$Version"
    exit 1
}

Write-Host "  ✓ Installed to $DestPath" -ForegroundColor Green

# ── Add to PATH ──────────────────────────────────────────────────────────

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$InstallDir;$UserPath", "User")
    $env:Path = "$InstallDir;$env:Path"
    Write-Host "  ✓ Added $InstallDir to your PATH" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Note: Restart your terminal for PATH changes to take effect." -ForegroundColor Yellow
} else {
    Write-Host "  ✓ Already on PATH" -ForegroundColor Green
}

Write-Host ""
Write-Host "  Get started:" -ForegroundColor White
Write-Host "    overlap join"
Write-Host ""
