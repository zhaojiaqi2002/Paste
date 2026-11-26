# Copies an item back to the Windows clipboard.
#   powershell.exe -Sta -File copy-win.ps1 -Mode text  -Value <file>
#   powershell.exe -Sta -File copy-win.ps1 -Mode image -Value <png>
#   powershell.exe -Sta -File copy-win.ps1 -Mode files -Paths <a> <b>
# Exits non-zero on failure so the caller can report it.

param(
  [Parameter(Mandatory = $true)][string]$Mode,
  [string]$Value,
  [string[]]$Paths
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

switch ($Mode) {
  'text' {
    $text = [System.IO.File]::ReadAllText($Value, [System.Text.Encoding]::UTF8)
    [System.Windows.Forms.Clipboard]::SetText($text)
  }
  'image' {
    $img = [System.Drawing.Image]::FromFile($Value)
    try { [System.Windows.Forms.Clipboard]::SetImage($img) } finally { $img.Dispose() }
  }
  'files' {
    if (-not $Paths -or $Paths.Count -eq 0) { throw 'no paths' }
    $collection = New-Object System.Collections.Specialized.StringCollection
    foreach ($p in $Paths) { [void]$collection.Add($p) }
    [System.Windows.Forms.Clipboard]::SetFileDropList($collection)
  }
  default { throw "unknown mode $Mode" }
}

Write-Output 'ok'
