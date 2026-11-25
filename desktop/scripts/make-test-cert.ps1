# Creates a SELF-SIGNED code-signing certificate for testing the signing pipeline.
# It does NOT remove the SmartScreen warning for other people. Only a certificate from a trusted
# authority (or Azure Artifact Signing) does that. Use it to check that `npm run dist` signs every
# file correctly before you buy a real certificate.
#
#   powershell -ExecutionPolicy Bypass -File scripts\make-test-cert.ps1
#   set WIN_CERT_SHA1=<thumbprint printed below>    (PowerShell: $env:WIN_CERT_SHA1="...")
#   npm run dist
param([string]$Subject = "CN=Codixel Test Signing")
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $Subject `
  -CertStoreLocation Cert:\CurrentUser\My -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
  -NotAfter (Get-Date).AddYears(2)
Write-Host ""
Write-Host "Created test certificate: $($cert.Subject)"
Write-Host "Thumbprint (use as WIN_CERT_SHA1): $($cert.Thumbprint)"
Write-Host ""
Write-Host "To make THIS PC trust it (optional, test only):"
Write-Host "  Export-Certificate -Cert Cert:\CurrentUser\My\$($cert.Thumbprint) -FilePath test-cert.cer"
Write-Host "  Import-Certificate -FilePath test-cert.cer -CertStoreLocation Cert:\CurrentUser\TrustedPublisher"
Write-Host "Remove it later with: Remove-Item Cert:\CurrentUser\My\$($cert.Thumbprint)"
