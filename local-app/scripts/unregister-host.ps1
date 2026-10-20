[CmdletBinding()]
param([ValidateSet('Chrome', 'Edge', 'Both')][string]$Browser = 'Chrome')
$ErrorActionPreference = 'Stop'
$browsers = @()
if ($Browser -eq 'Chrome' -or $Browser -eq 'Both') { $browsers += 'Google\Chrome' }
if ($Browser -eq 'Edge' -or $Browser -eq 'Both') { $browsers += 'Microsoft\Edge' }
foreach ($name in $browsers) {
  $key = "HKCU:\Software\$name\NativeMessagingHosts\com.chatgpt_backup.sync"
  if (Test-Path $key) { Remove-Item -LiteralPath $key }
}
$chrome = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.chatgpt_backup.sync'
$edge = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.chatgpt_backup.sync'
if (!(Test-Path $chrome) -and !(Test-Path $edge)) {
  $manifest = Join-Path $env:LOCALAPPDATA 'ChatGPTBackup\host\com.chatgpt_backup.sync.json'
  if (Test-Path $manifest) { Remove-Item -LiteralPath $manifest }
}
Write-Output "Unregistered $Browser. Database, logs, key and launcher were kept. No data was deleted."
