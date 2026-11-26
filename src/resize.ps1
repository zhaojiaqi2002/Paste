# PNG conversion and thumbnail generation for Windows (no npm image deps).
#   -File resize.ps1 -Mode convert -In a.jpg -Out a.png
#   -File resize.ps1 -Mode resize  -In a.png -Out t.png -Max 480

param(
  [Parameter(Mandatory = $true)][string]$Mode,
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Max = 480
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$source = [System.Drawing.Image]::FromFile($In)
try {
  if ($Mode -eq 'convert') {
    $source.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    return
  }

  $ratio = [Math]::Min([double]$Max / $source.Width, [double]$Max / $source.Height)
  if ($ratio -gt 1) { $ratio = 1 }
  $w = [Math]::Max(1, [int][Math]::Round($source.Width * $ratio))
  $h = [Math]::Max(1, [int][Math]::Round($source.Height * $ratio))

  $bitmap = New-Object System.Drawing.Bitmap($w, $h)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.DrawImage($source, 0, 0, $w, $h)
  } finally {
    $graphics.Dispose()
  }
  try { $bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose() }
} finally {
  $source.Dispose()
}
