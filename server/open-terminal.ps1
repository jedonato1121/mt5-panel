param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Dir,
  [Parameter(Mandatory = $false)][string]$Login = ''
)

# Focus an already-running MT5 terminal for this installation, or start it.
# Prints exactly one word on success: focused | running | launched
$ErrorActionPreference = 'Stop'

$exeFull = [System.IO.Path]::GetFullPath($Exe)

if (-not (Test-Path -LiteralPath $exeFull)) {
  Write-Error "terminal64.exe not found: $exeFull"
  exit 3
}

$name = [System.IO.Path]::GetFileNameWithoutExtension($exeFull)
$running = @()
try {
  $running = @(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object {
    try {
      $_.Path -and ([System.IO.Path]::GetFullPath($_.Path) -ieq $exeFull)
    } catch { $false }
  })
} catch { }

if ($running.Count -gt 0) {
  $target = $running | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $target) { $target = $running | Select-Object -First 1 }

  $ok = $false
  if ($target.MainWindowHandle -ne 0) {
    try {
      $wsh = New-Object -ComObject WScript.Shell
      $ok = [bool]$wsh.AppActivate($target.Id)
    } catch { }
    if (-not $ok) {
      try {
        Add-Type -Namespace Mt5Panel -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'@
        [Mt5Panel.Win]::ShowWindow($target.MainWindowHandle, 9) | Out-Null
        [Mt5Panel.Win]::SetForegroundWindow($target.MainWindowHandle) | Out-Null
        $ok = $true
      } catch { }
    }
  }

  if ($ok) { Write-Output 'focused' } else { Write-Output 'running' }
  exit 0
}

# Not running: start it detached from this helper process.
Start-Process -FilePath $Exe -WorkingDirectory $Dir
Write-Output 'launched'
exit 0
