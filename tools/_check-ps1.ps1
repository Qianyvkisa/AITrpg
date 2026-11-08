$ErrorActionPreference = 'Stop'
$files = @('D:\Tool\AIrpg\release.ps1', 'D:\Tool\AIrpg\start.ps1')
foreach ($f in $files) {
  $errs = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$errs)
  if ($errs -and $errs.Count) {
    Write-Output "$f : PARSE ERRORS = $($errs.Count)"
    $errs | Select-Object -First 5 | ForEach-Object { Write-Output ("   line " + $_.Extent.StartLineNumber + ": " + $_.Message) }
  } else {
    Write-Output "$f : OK"
  }
}
