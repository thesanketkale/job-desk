<#
.SYNOPSIS
  Creates a self-signed code-signing certificate for Job Desk and exports it
  for electron-builder (a private .pfx) and for a machine to trust it (a
  public .cer).

.DESCRIPTION
  Self-signing does not buy the reputation a paid, CA-issued certificate
  would — Windows does not trust it anywhere by default, and SmartScreen's
  "Windows protected your PC" screen would still appear on a machine that has
  never seen this certificate. What it does buy: import the public half
  (the .cer) into Trusted Root once, on the one machine this app actually
  runs on, and every build signed with the matching private key — the
  installer, the portable .exe, and every update after it — installs
  without that screen, because the signer is now something that machine
  already trusts. It is not portable to any other machine without repeating
  that one import.

  Run this once. Re-running creates a NEW certificate with a new thumbprint —
  a machine that trusted the old one would need the new .cer imported too,
  and anything already signed with the old key stops being trusted the
  moment the old certificate is removed from that machine's store.

.NOTES
  The .pfx holds the private key and is exported alongside a randomly
  generated password, written once to pfx-password.txt in the same folder.
  Both are secrets: scripts/signing/ is gitignored, and neither file should
  ever be committed, emailed unencrypted, or posted anywhere. Move the
  password into a password manager and delete pfx-password.txt once you
  have; the .pfx itself needs to stay on disk for every future build.
#>
param(
  [string]$Subject = 'CN=Job Desk, O=Sanket Kale',
  [string]$OutDir = "$PSScriptRoot\signing",
  [int]$YearsValid = 5
)

$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$existing = Get-ChildItem Cert:\CurrentUser\My |
  Where-Object { $_.Subject -eq $Subject -and $_.NotAfter -gt (Get-Date) }
if ($existing) {
  Write-Host "A certificate for '$Subject' already exists and has not expired"
  Write-Host "(thumbprint $($existing[0].Thumbprint))."
  Write-Host 'Remove it from certmgr.msc under Personal > Certificates first if you want a fresh one.'
  exit 1
}

$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $Subject `
  -KeyUsage DigitalSignature `
  -FriendlyName 'Job Desk code signing' `
  -CertStoreLocation Cert:\CurrentUser\My `
  -NotAfter (Get-Date).AddYears($YearsValid) `
  -KeyExportPolicy Exportable `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256

$pfxPassword = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$securePwd = ConvertTo-SecureString -String $pfxPassword -Force -AsPlainText

$pfxPath = Join-Path $OutDir 'jobdesk-signing.pfx'
$cerPath = Join-Path $OutDir 'jobdesk-signing.cer'
$pwdPath = Join-Path $OutDir 'pfx-password.txt'
$b64Path = Join-Path $OutDir 'jobdesk-signing.pfx.base64.txt'

Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $securePwd | Out-Null
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null
Set-Content -Path $pwdPath -Value $pfxPassword -NoNewline

# Base64 form, for pasting into the CSC_LINK GitHub Actions secret — electron-
# builder accepts CSC_LINK as a file path, a URL, or a data: URL, and a
# repository secret cannot point at a path that only exists on this machine.
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pfxPath))
Set-Content -Path $b64Path -Value "data:application/x-pkcs12;base64,$b64" -NoNewline

Write-Host ''
Write-Host 'Created, all under scripts\signing\ (gitignored):'
Write-Host "  jobdesk-signing.pfx              private key - keep secret, never commit or share"
Write-Host "  jobdesk-signing.cer              public certificate - safe to share, Srishti needs this one"
Write-Host "  pfx-password.txt                 the .pfx password in plain text - move to a password manager, then delete this file"
Write-Host "  jobdesk-signing.pfx.base64.txt    the .pfx as a data: URL, for the CSC_LINK GitHub secret"
Write-Host ''
Write-Host 'Thumbprint:' $cert.Thumbprint
Write-Host ''
Write-Host 'Next steps are in SETUP.md (Signing the build) and GUIDE.md (Installing it).'
