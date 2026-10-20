[CmdletBinding()]
param(
  [string]$ExtensionId,
  [ValidateSet('Chrome', 'Edge', 'Both')][string]$Browser = 'Chrome'
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (!$ExtensionId) {
  $ExtensionId = (Get-Content (Join-Path $repo '.local\extension-id.txt') -Raw).Trim()
}
if ($ExtensionId -cnotmatch '^[a-p]{32}$') { throw 'ExtensionId must contain exactly 32 lowercase letters a-p.' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$version = & $node --version
if ($LASTEXITCODE -ne 0 -or [int]($version.TrimStart('v').Split('.')[0]) -lt 24) {
  throw 'Node.js 24 or newer is required.'
}
$hostDirectory = Join-Path $repo 'local-app\host'
$launcher = Join-Path $hostDirectory 'run-host.cmd'
$origin = "chrome-extension://$ExtensionId/"
$utf8 = New-Object System.Text.UTF8Encoding($false)
$cmd = "@echo off`r`n`"$($node.Replace('%', '%%'))`" --disable-warning=ExperimentalWarning `"%~dp0main.ts`" %*`r`n"
[System.IO.File]::WriteAllText($launcher, $cmd, $utf8)
[System.IO.File]::WriteAllText((Join-Path $hostDirectory 'allowed-origin.txt'), $origin, $utf8)
$directory = Join-Path $env:LOCALAPPDATA 'ChatGPTBackup\host'
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$manifestPath = Join-Path $directory 'com.chatgpt_backup.sync.json'
$manifest = @{
  name = 'com.chatgpt_backup.sync'
  description = 'Local ChatGPT Backup sync host'
  path = $launcher
  type = 'stdio'
  allowed_origins = @($origin)
} | ConvertTo-Json
[System.IO.File]::WriteAllText($manifestPath, $manifest, $utf8)
$browsers = @()
if ($Browser -eq 'Chrome' -or $Browser -eq 'Both') { $browsers += 'Google\Chrome' }
if ($Browser -eq 'Edge' -or $Browser -eq 'Both') { $browsers += 'Microsoft\Edge' }
foreach ($name in $browsers) {
  $key = "HKCU:\Software\$name\NativeMessagingHosts\com.chatgpt_backup.sync"
  New-Item -Path $key -Force | Out-Null
  Set-Item -Path $key -Value $manifestPath
}
Write-Output "Registered for $Browser (current user only)."
Write-Output "Extension ID: $ExtensionId"
Write-Output "Manifest: $manifestPath"
Write-Output "Launcher: $launcher"
Write-Output "Node: $node ($version)"
