# Installs the optional extras ticked on the setup page (see installer.nsh):
#   -HidHide  HidHide (Nefarius): hides the real controller from games
#   -Viiper   VIIPER (+ usbip-win2): the virtual controller games see
#   -Obs      OBS Studio: clips, screenshots and recordings
# Each comes from the latest release on its official GitHub page. Output lines
# go to the setup's details list. Exit code: bit 1 = something failed,
# bit 2 = Windows needs a restart.

param([switch]$HidHide, [switch]$Viiper, [switch]$Obs)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is many times slower with its progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$work = Join-Path $env:TEMP 'PS5GameLauncher-setup'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$script:failed = $false
$script:restart = $false

function Say($text) { Write-Output $text }

function Get-LatestAsset([string]$repo, [scriptblock]$match) {
  $rel = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'PS5GameLauncher-Setup' }
  $asset = $rel.assets | Where-Object $match | Select-Object -First 1
  if (-not $asset) { throw "No Windows download in the latest $repo release ($($rel.tag_name))." }
  [pscustomobject]@{ Name = $asset.name; Url = $asset.browser_download_url; Size = $asset.size; Tag = $rel.tag_name }
}

# signer: the publisher that must have signed the download (part of its certificate subject).
function Get-Download($asset, [string]$signer) {
  $file = Join-Path $work $asset.Name
  Say ("  Downloading {0} ({1:N0} MB)..." -f $asset.Name, ($asset.Size / 1MB))
  Invoke-WebRequest -UseBasicParsing -Uri $asset.Url -OutFile $file
  $sig = Get-AuthenticodeSignature -FilePath $file
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch $signer) {
    Remove-Item $file -Force -ErrorAction SilentlyContinue
    throw "The download isn't signed by $signer (signature: $($sig.Status)). It was not run."
  }
  $file
}

# Start a program and wait for it alone (Start-Process -Wait would also wait for
# anything it leaves running, like VIIPER's server).
function Invoke-Setup([string]$file, [string[]]$arguments, [switch]$Elevated, [int]$minutes = 15) {
  $opts = @{ FilePath = $file; PassThru = $true }
  if ($arguments) { $opts.ArgumentList = $arguments }
  if ($Elevated) { $opts.Verb = 'RunAs' } # Windows asks for permission (drivers need it)
  $p = Start-Process @opts
  if (-not $p.WaitForExit($minutes * 60 * 1000)) { throw "Setup didn't finish within $minutes minutes." }
  $p.ExitCode
}

function Test-Service([string]$name) { [bool](Get-Service -Name $name -ErrorAction SilentlyContinue) }

function Step([string]$title, [scriptblock]$body) {
  Say "$title"
  try {
    & $body
  } catch {
    $msg = $_.Exception.Message
    if ($msg -match 'canceled by the user|1223') { $msg = 'Windows permission was declined.' }
    Say "  Failed: $msg"
    $script:failed = $true
  }
}

if ($HidHide) {
  Step 'HidHide' {
    $had = Test-Service 'HidHide'
    $asset = Get-LatestAsset 'nefarius/HidHide' { $_.name -match '^HidHide_.*_x64\.exe$' }
    $file = Get-Download $asset 'Nefarius'
    Say "  Installing $($asset.Tag)..."
    $code = Invoke-Setup $file @('/exenoui', '/qn', '/norestart') -Elevated
    if ($code -eq 1639) {
      # Didn't take the quiet switches: run its normal setup instead.
      $code = Invoke-Setup $file @() -Elevated
    }
    if ($code -eq 3010 -or $code -eq 1641) { $script:restart = $true }
    elseif ($code -ne 0) { throw "HidHide setup ended with code $code." }
    # Its driver only attaches to controllers after a restart.
    if (-not $had) { $script:restart = $true }
    Say '  HidHide is installed.'
  }
}

if ($Viiper) {
  Step 'VIIPER (virtual controller)' {
    $hadUsbip = Test-Service 'usbip2_ude'
    $asset = Get-LatestAsset 'Alia5/VIIPER' { $_.name -match '^viiper-windows-(amd64|x64)\.exe$' }
    $file = Get-Download $asset 'Peter Repukat'
    Say "  Installing $($asset.Tag) (it starts with Windows; USBIP comes with it)..."
    # Installs for this user (start with Windows, USBIP driver); asks for permission for the driver.
    $code = Invoke-Setup $file @('install', '--quiet', '--no-update')
    if ($code -ne 0) { throw "VIIPER setup ended with code $code." }
    if (-not $hadUsbip -and (Test-Service 'usbip2_ude')) { $script:restart = $true }
    Say '  VIIPER is installed.'
  }
}

if ($Obs) {
  Step 'OBS Studio' {
    $asset = Get-LatestAsset 'obsproject/obs-studio' { $_.name -match '^OBS-Studio-.*Windows.*Installer\.exe$' -and $_.name -notmatch 'arm64' }
    $file = Get-Download $asset 'OBS Project'
    Say "  Installing $($asset.Tag)..."
    $code = Invoke-Setup $file @('/S') -Elevated -minutes 20
    if ($code -ne 0) { throw "OBS setup ended with code $code." }
    Say '  OBS Studio is installed.'
  }
}

Remove-Item -Recurse -Force -Path $work -ErrorAction SilentlyContinue
$exit = 0
if ($script:failed) { $exit = $exit -bor 1 }
if ($script:restart) { $exit = $exit -bor 2; Say 'A restart is needed to finish.' }
exit $exit
