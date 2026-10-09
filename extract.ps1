$zip = 'C:\Users\VIDYA UTKARSH 1\Desktop\project.zip'
$dest = 'C:\Users\VIDYA UTKARSH 1\Desktop\project'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead($zip)
foreach ($e in $z.Entries) {
  if ($e.FullName -match 'node_modules') { continue }
  $rel = $e.FullName -replace '^project/', '' -replace '^project\\', ''
  if ([string]::IsNullOrWhiteSpace($rel)) { continue }
  $out = Join-Path $dest $rel
  if ($e.FullName.EndsWith('/') -or $e.FullName.EndsWith('\')) {
    New-Item -ItemType Directory -Force -Path $out | Out-Null
    continue
  }
  $dir = [System.IO.Path]::GetDirectoryName($out)
  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $out, $true)
}
$z.Dispose()
Write-Output 'EXTRACTED'
Get-ChildItem -Recurse $dest -File | Where-Object { $_.FullName -notmatch 'node_modules' } | ForEach-Object { $_.FullName.Replace($dest, '') }
