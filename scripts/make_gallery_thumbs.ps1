#requires -Version 5.1
<#
.SYNOPSIS
  Generate gallery thumbnails and point the project pages at them.

.DESCRIPTION
  Project gallery grids show images at roughly 340x220, and the projects
  index cards at roughly 350x260. Loading the full 1600px "-web.jpg" files
  into those slots is what pushed 115 Bear Den Ct to 11.25 MB.

  This script:
    1. finds every image used in a .gallery-thumb (project pages) or a
       .card-photo (projects/index.html),
    2. writes a 700px-wide "-thumb.jpg" beside the original if missing,
    3. repoints the markup at the thumbnail, keeping the full-size file in a
       data-full attribute,
    4. patches the lightbox so it still opens the full-size original.

  The .gallery-main image is deliberately left at full size - it renders
  full-width and is the first thing a visitor sees.

  Safe to re-run: work already done is skipped. Run it after adding photos
  to a project gallery.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\make_gallery_thumbs.ps1 -WhatIf
  Show what would change without touching anything.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\make_gallery_thumbs.ps1
  Generate thumbnails and update the HTML.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  # Repo root. Defaults to the parent of this script's folder.
  [string]$Root,
  # Width of generated thumbnails. 700px covers the ~350px slots on 2x screens.
  [int]$TargetWidth = 700,
  # JPEG quality for thumbnails.
  [int]$Quality = 80,
  # Sources smaller than this are already light enough to serve as-is.
  [int]$MinSourceKB = 120
)

Add-Type -AssemblyName System.Drawing

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
if (-not (Test-Path (Join-Path $Root 'projects'))) {
  throw "Does not look like the site repo (no projects/ folder): $Root"
}
Set-Location $Root
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# Pages that are not public project pages.
$excluded = @('leads.html', '__forms.html', 'index.html')

function Get-ProjectPages {
  Get-ChildItem (Join-Path $Root 'projects') -Filter *.html |
    Where-Object { $_.Name -notin $excluded }
}

function ConvertTo-ThumbSrc([string]$src) {
  # ../photos/.../foo-web.jpg -> ../photos/.../foo-thumb.jpg
  $dir  = $src.Substring(0, $src.LastIndexOf('/') + 1)
  $file = $src.Substring($src.LastIndexOf('/') + 1)
  $base = [System.IO.Path]::GetFileNameWithoutExtension($file)
  if ($base -match '-web$') { $base = $base -replace '-web$', '' }
  return ($dir + $base + '-thumb.jpg')
}

function Resolve-SitePath([string]$pageDir, [string]$src) {
  return [System.IO.Path]::GetFullPath((Join-Path $pageDir ($src -replace '/', '\')))
}

function New-Thumbnail([string]$srcFull, [string]$dstFull, [int]$w, [int]$q) {
  $img = [System.Drawing.Image]::FromFile($srcFull)
  try {
    if ($img.Width -le $w) { return $false }   # already small enough
    $nh  = [int][math]::Round($img.Height * ($w / $img.Width))
    $bmp = New-Object System.Drawing.Bitmap($w, $nh)
    try {
      $bmp.SetResolution(72, 72)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.DrawImage($img, 0, 0, $w, $nh)
      } finally { $g.Dispose() }

      $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
               Where-Object { $_.MimeType -eq 'image/jpeg' }
      $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
      $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
                       [System.Drawing.Imaging.Encoder]::Quality, [int64]$q)
      $bmp.Save($dstFull, $codec, $ep)
      $ep.Dispose()
    } finally { $bmp.Dispose() }
  } finally { $img.Dispose() }
  return $true
}

# --------------------------------------------------------------------------
# Step 1: generate any missing thumbnails
# --------------------------------------------------------------------------
$sources = New-Object System.Collections.Generic.HashSet[string]

foreach ($page in Get-ProjectPages) {
  $html = [System.IO.File]::ReadAllText($page.FullName)
  foreach ($m in [regex]::Matches($html,
      '(?is)<div class="gallery-thumb"[^>]*>\s*<img\b[^>]*?\bsrc="([^"]+)"')) {
    $s = $m.Groups[1].Value
    if ($s -match '-thumb\.jpg$' -or $s -notmatch '^\.\./photos/') { continue }
    [void]$sources.Add((Resolve-SitePath $page.DirectoryName $s))
  }
}

$indexPath = Join-Path $Root 'projects\index.html'
$indexHtml = [System.IO.File]::ReadAllText($indexPath)
foreach ($m in [regex]::Matches($indexHtml,
    '(?is)<div class="card-photo">.*?<img\b[^>]*?\bsrc="([^"]+)"')) {
  $s = $m.Groups[1].Value
  if ($s -match '-thumb\.jpg$' -or $s -notmatch '^\.\./photos/') { continue }
  [void]$sources.Add((Resolve-SitePath (Split-Path $indexPath) $s))
}

$made = 0; $savedBytes = 0
foreach ($src in ($sources | Sort-Object)) {
  if (-not (Test-Path $src)) { Write-Warning "missing source: $src"; continue }
  $file = Get-Item $src
  if ($file.Length / 1KB -lt $MinSourceKB) { continue }

  $dirName = [System.IO.Path]::GetDirectoryName($src)
  $base    = [System.IO.Path]::GetFileNameWithoutExtension($src) -replace '-web$', ''
  $dst     = Join-Path $dirName ($base + '-thumb.jpg')
  if (Test-Path $dst) { continue }

  if ($PSCmdlet.ShouldProcess((Split-Path $dst -Leaf), 'create thumbnail')) {
    if (New-Thumbnail $src $dst $TargetWidth $Quality) {
      $made++
      $savedBytes += ($file.Length - (Get-Item $dst).Length)
      Write-Verbose "thumb: $($dst.Replace($Root + '\', ''))"
    }
  } else { $made++ }
}

# --------------------------------------------------------------------------
# Step 1b: repair thumbnails the markup already points at but that are gone
# (e.g. a thumbnail deleted by hand after the markup was converted).
# --------------------------------------------------------------------------
$repaired = 0
$allPages = @(Get-ProjectPages | ForEach-Object { $_.FullName }) + $indexPath
foreach ($pagePath in $allPages) {
  $pageDir = Split-Path $pagePath
  $body    = [System.IO.File]::ReadAllText($pagePath)
  foreach ($m in [regex]::Matches($body, '(?i)\bsrc="([^"]*-thumb\.jpg)"')) {
    $thumbSrc  = $m.Groups[1].Value
    $thumbFull = Resolve-SitePath $pageDir $thumbSrc
    if (Test-Path $thumbFull) { continue }

    # Recover the full-size original: prefer this img's data-full, else guess.
    $tail     = [regex]::Escape($thumbSrc)
    $withFull = [regex]::Match($body, "src=`"$tail`"\s+data-full=`"([^`"]+)`"")
    $srcGuess = if ($withFull.Success) { $withFull.Groups[1].Value }
                else { $thumbSrc -replace '-thumb\.jpg$', '-web.jpg' }
    $srcFull  = Resolve-SitePath $pageDir $srcGuess
    if (-not (Test-Path $srcFull)) {
      Write-Warning "cannot rebuild $thumbSrc - original not found"
      continue
    }
    if ($PSCmdlet.ShouldProcess((Split-Path $thumbFull -Leaf), 'rebuild missing thumbnail')) {
      if (New-Thumbnail $srcFull $thumbFull $TargetWidth $Quality) { $repaired++ }
    } else { $repaired++ }
  }
}

# --------------------------------------------------------------------------
# Step 2: repoint markup at the thumbnails, keep full size for the lightbox
# --------------------------------------------------------------------------
$script:swaps = 0; $script:jsPatches = 0; $filesTouched = 0

foreach ($page in Get-ProjectPages) {
  $html = [System.IO.File]::ReadAllText($page.FullName)
  $orig = $html
  $pageDir = $page.DirectoryName

  $html = [regex]::Replace($html,
    '(?is)(<div class="gallery-thumb"[^>]*>\s*<img\b)([^>]*?)\bsrc="([^"]+)"',
    {
      param($m)
      $src = $m.Groups[3].Value
      if ($src -match '-thumb\.jpg$' -or $src -notmatch '^\.\./photos/') { return $m.Value }
      $thumb = ConvertTo-ThumbSrc $src
      if (-not (Test-Path (Resolve-SitePath $pageDir $thumb))) { return $m.Value }
      $script:swaps++
      return ($m.Groups[1].Value + $m.Groups[2].Value +
              'src="' + $thumb + '" data-full="' + $src + '"')
    })

  # The lightbox reads the grid image's src, so it must prefer data-full.
  # Covers the imgs[i] / imgs[idx] / imgs[cur] variants across the pages.
  # 117-bear-den-ct.html drives its lightbox from a hardcoded full-size
  # photos[] array and correctly matches nothing here.
  $html = [regex]::Replace($html,
    'lbImg\.src\s*=\s*imgs\[([A-Za-z_][A-Za-z0-9_]*)\]\.src\s*;',
    {
      param($m)
      $v = $m.Groups[1].Value
      $script:jsPatches++
      return "lbImg.src = imgs[$v].getAttribute('data-full') || imgs[$v].src;"
    })

  if ($html -ne $orig) {
    if ($PSCmdlet.ShouldProcess($page.Name, 'update markup')) {
      [System.IO.File]::WriteAllText($page.FullName, $html, $utf8NoBom)
    }
    $filesTouched++
  }
}

# projects/index.html cards (no lightbox, so no data-full needed)
$idx = [System.IO.File]::ReadAllText($indexPath)
$idxOrig = $idx
$idxDir = Split-Path $indexPath
$idx = [regex]::Replace($idx,
  '(?is)(<div class="card-photo">.*?<img\b)([^>]*?)\bsrc="([^"]+)"',
  {
    param($m)
    $src = $m.Groups[3].Value
    if ($src -match '-thumb\.jpg$' -or $src -notmatch '^\.\./photos/') { return $m.Value }
    $thumb = ConvertTo-ThumbSrc $src
    if (-not (Test-Path (Resolve-SitePath $idxDir $thumb))) { return $m.Value }
    $script:swaps++
    return ($m.Groups[1].Value + $m.Groups[2].Value + 'src="' + $thumb + '"')
  })
if ($idx -ne $idxOrig) {
  if ($PSCmdlet.ShouldProcess('projects/index.html', 'update markup')) {
    [System.IO.File]::WriteAllText($indexPath, $idx, $utf8NoBom)
  }
  $filesTouched++
}

# --------------------------------------------------------------------------
Write-Output ''
if ($made -eq 0 -and $repaired -eq 0 -and $script:swaps -eq 0 -and $script:jsPatches -eq 0) {
  Write-Output 'Nothing to do - every gallery image already has a thumbnail.'
} else {
  Write-Output ('Thumbnails created : {0}' -f $made)
  if ($repaired -gt 0) { Write-Output ('Thumbnails repaired: {0}' -f $repaired) }
  Write-Output ('Images repointed   : {0}' -f $script:swaps)
  Write-Output ('Lightbox patches   : {0}' -f $script:jsPatches)
  Write-Output ('HTML files updated : {0}' -f $filesTouched)
  if ($savedBytes -gt 0) {
    Write-Output ('Page weight saved  : {0} MB' -f [math]::Round($savedBytes / 1MB, 2))
  }
  Write-Output ''
  Write-Output 'Review with "git diff", then commit and push to deploy.'
}
