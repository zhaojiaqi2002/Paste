# Windows clipboard watcher. Long-lived; one JSON object per line on stdout.
#
# GetClipboardSequenceNumber() is the Windows equivalent of NSPasteboard.changeCount:
# it changes only on real clipboard activity, so idle cost is one P/Invoke per tick.
#
#   powershell.exe -Sta -File watcher-win.ps1 -TmpDir <dir>
#
# Requires an STA thread for the WinForms clipboard API.

param([string]$TmpDir = $env:TEMP)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ('Paste.Native' -as [type])) {
  Add-Type -Namespace Paste -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetClipboardSequenceNumber();
'@
}

function Emit($obj) {
  try {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
    [Console]::Out.Flush()
  } catch { exit 0 }
}

function Read-Image([uint32]$seq) {
  $formats = @(
    @{ Name = 'PNG';  Format = [System.Windows.Forms.DataFormats]::Png;      Ext = 'png' },
    @{ Name = 'DIB';  Format = [System.Windows.Forms.DataFormats]::Dib;      Ext = 'png' },
    @{ Name = 'BMP';  Format = [System.Windows.Forms.DataFormats]::Bitmap;   Ext = 'png' }
  )
  foreach ($f in $formats) {
    try {
      if (-not [System.Windows.Forms.Clipboard]::ContainsData($f.Format)) { continue }
      $img = [System.Windows.Forms.Clipboard]::GetImage()
      if ($null -eq $img) { continue }
      $path = Join-Path $TmpDir ("clip-$seq.png")
      $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
      $img.Dispose()
      return $path
    } catch { }
  }
  return $null
}

function Snapshot([uint32]$seq) {
  $data = $null
  try { $data = [System.Windows.Forms.Clipboard]::GetDataObject() } catch { $data = $null }
  if ($null -eq $data) { return @{ t = 'none' } }

  try {
    if ($data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
      $files = $data.GetData([System.Windows.Forms.DataFormats]::FileDrop)
      if ($files -and $files.Count -gt 0) {
        return @{ t = 'files'; paths = @($files | Select-Object -First 50) }
      }
    }
  } catch { }

  $img = Read-Image $seq
  if ($img) { return @{ t = 'image'; path = $img } }

  try {
    if ($data.GetDataPresent([System.Windows.Forms.DataFormats]::UnicodeText)) {
      $text = $data.GetData([System.Windows.Forms.DataFormats]::UnicodeText)
      if ($null -ne $text) {
        $text = [string]$text
        if ($text.Length -eq 0) { return @{ t = 'none' } }
        return @{ t = 'text'; text = $text }
      }
    }
  } catch { }

  return @{ t = 'none' }
}

$last = [Paste.Native]::GetClipboardSequenceNumber()
Emit (Snapshot $last)
$lastTick = Get-Date

while ($true) {
  try {
    $seq = [Paste.Native]::GetClipboardSequenceNumber()
    if ($seq -ne $last) {
      $last = $seq
      Emit (Snapshot $seq)
      $lastTick = Get-Date
    } elseif (((Get-Date) - $lastTick).TotalMilliseconds -gt 20000) {
      $lastTick = Get-Date
      Emit @{ t = 'tick'; cc = $seq }
    }
  } catch {
    Emit @{ t = 'error'; message = $_.Exception.Message }
  }
  Start-Sleep -Milliseconds 350
}
