<#
.SYNOPSIS
    Gives the unpackaged CephableDesk.exe a package identity so Windows AI will talk to it.

.DESCRIPTION
    Phi Silica and Windows OCR are gated on the `systemAIModels` capability. Capabilities are
    granted to a package identity, and an unpackaged Win32 process has none - so GetReadyState()
    throws UnauthorizedAccessException even on a Copilot+ PC with a working NPU. There is no
    setting to flip, because there is no package for a setting to apply to.

    The fix is identity, not packaging. This script builds a manifest-only MSIX (no payload, not a
    packaged build of the app), signs it with a local development certificate, and registers it
    against your existing build output directory. Afterwards `dotnet build`, F5 and launching the
    .exe straight out of bin\ all work exactly as they did.

    Read before running - it makes two changes to your machine, both reversible with -Remove:
      1. Creates a self-signed code-signing certificate (CN=Cephable Desk Sample Dev) in your
         per-user certificate store, and copies its public half into Trusted People so Windows
         will accept the package. Per-user; no elevation; nothing is trusted machine-wide.
      2. Registers the identity package for your user account. It is hidden from the Start menu
         and installed-apps list (AppListEntry="none").

.PARAMETER Configuration
    Build configuration whose output gets the identity. Default Debug.

.PARAMETER Remove
    Undo everything: unregister the package and delete the development certificate.

.EXAMPLE
    .\packaging\enable-windows-ai.ps1

.EXAMPLE
    .\packaging\enable-windows-ai.ps1 -Remove
#>
[CmdletBinding()]
param(
    [string]$Configuration = 'Debug',
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$PackageName = 'Cephable.CephableDeskSample'
$CertSubject = 'CN=Cephable Desk Sample Dev'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
# The manifest lives alone in identity\ so makeappx has nothing else to sweep in: an identity
# package should carry no payload at all.
$IdentityDir = Join-Path $PSScriptRoot 'identity'

function Find-BuildOutput {
    # The RID-specific folder is where WinUI actually puts the exe. Newest wins, so the script
    # follows whichever architecture you last built.
    $candidates = Get-ChildItem -Path (Join-Path $ProjectRoot "bin\$Configuration") -Recurse `
        -Filter 'CephableDesk.exe' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
    if (-not $candidates) {
        throw "No CephableDesk.exe under bin\$Configuration. Build first: dotnet build -c $Configuration -r win-x64"
    }
    return Split-Path -Parent $candidates[0].FullName
}

function Get-DevCert {
    Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $CertSubject } | Select-Object -First 1
}

# ── remove ───────────────────────────────────────────────────────────────────
if ($Remove) {
    $pkg = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue
    if ($pkg) {
        Write-Host "Unregistering $($pkg.PackageFullName)..."
        Remove-AppxPackage -Package $pkg.PackageFullName
    } else {
        Write-Host "Identity package is not registered."
    }

    foreach ($store in 'Cert:\CurrentUser\My', 'Cert:\CurrentUser\TrustedPeople') {
        Get-ChildItem $store | Where-Object { $_.Subject -eq $CertSubject } | ForEach-Object {
            Write-Host "Removing certificate $($_.Thumbprint) from $store..."
            Remove-Item $_.PSPath -Force
        }
    }

    Write-Host ""
    Write-Host "Done. The app still runs; Windows AI will report that it refused this app again." -ForegroundColor Green
    return
}

# ── enable ───────────────────────────────────────────────────────────────────
$outputDir = Find-BuildOutput
Write-Host "Build output: $outputDir"

# 1. Development certificate.
$cert = Get-DevCert
if (-not $cert) {
    Write-Host "Creating development certificate $CertSubject..."
    $cert = New-SelfSignedCertificate -Type Custom -Subject $CertSubject `
        -KeyUsage DigitalSignature -FriendlyName 'Cephable Desk sample (dev signing)' `
        -CertStoreLocation 'Cert:\CurrentUser\My' `
        -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
} else {
    Write-Host "Reusing certificate $($cert.Thumbprint)."
}

# Windows will not register a package whose signer it does not trust. CERT_E_UNTRUSTEDROOT
# (0x800B0109) is what you get without this, and the message does not explain itself.
if (-not (Get-ChildItem Cert:\CurrentUser\TrustedPeople | Where-Object { $_.Thumbprint -eq $cert.Thumbprint })) {
    Write-Host "Trusting the certificate for this user (Trusted People)..."
    $cer = Join-Path $env:TEMP "cephable-desk-dev.cer"
    Export-Certificate -Cert $cert -FilePath $cer | Out-Null
    Import-Certificate -FilePath $cer -CertStoreLocation Cert:\CurrentUser\TrustedPeople | Out-Null
    Remove-Item $cer -Force
}

# 2. Locate the SDK tools.
function Find-SdkTool([string]$name) {
    $tool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse -Filter $name -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\(x64|x86)\\' } | Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $tool) { throw "$name not found. Install the Windows SDK." }
    return $tool.FullName
}
$makeAppx = Find-SdkTool 'makeappx.exe'
$signTool = Find-SdkTool 'signtool.exe'

# 3. Pack. /nv skips validating the referenced image paths, which is expected for an identity
#    package: AppListEntry="none" means Windows never needs the logos.
$msix = Join-Path $env:TEMP 'CephableDeskIdentity.msix'
Write-Host "Packing identity package..."
& $makeAppx pack /o /d $IdentityDir /nv /p $msix | Out-Null
if ($LASTEXITCODE -ne 0) { throw "makeappx failed with exit code $LASTEXITCODE" }

# 4. Sign.
Write-Host "Signing..."
& $signTool sign /fd SHA256 /sha1 $cert.Thumbprint /s My $msix | Out-Null
if ($LASTEXITCODE -ne 0) { throw "signtool failed with exit code $LASTEXITCODE" }

# 5. Register against the build output. Re-registering the same version is an error, so clear any
#    previous registration first.
$existing = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue
if ($existing) { Remove-AppxPackage -Package $existing.PackageFullName }

Write-Host "Registering identity for $outputDir..."
Add-AppxPackage -Path $msix -ExternalLocation $outputDir

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "Launch the app from $outputDir and the Phi Silica / Windows OCR pills should now say"
Write-Host "'on device' instead of 'unavailable'."
Write-Host ""
Write-Host "Re-run this after switching Configuration or architecture - the identity is bound to one"
Write-Host "output directory. Undo with: .\packaging\enable-windows-ai.ps1 -Remove"
