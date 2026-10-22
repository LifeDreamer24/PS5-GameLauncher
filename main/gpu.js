const { execFile } = require('child_process');
const path = require('path');

// Windows' per-user graphics preference for this launcher executable only.
// Keep Windows as the source of truth so changes in its Settings app are reflected.
function gpuPreference(preference) {
  if (process.platform !== 'win32') return Promise.resolve({ supported: false });
  if (preference !== undefined && ![0, 1, 2].includes(preference)) {
    return Promise.reject(new Error('Invalid GPU preference'));
  }
  const executable = Buffer.from(process.execPath, 'utf8').toString('base64');
  const script = `
$ErrorActionPreference = 'Stop'
$name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${executable}'))
$key = $null
try {
  $key = [Microsoft.Win32.Registry]::CurrentUser.${preference === undefined ? 'OpenSubKey' : 'CreateSubKey'}('Software\\Microsoft\\DirectX\\UserGpuPreferences')
  $value = ''
  if ($null -ne $key) { $value = [string]$key.GetValue($name, '') }
  ${preference === undefined ? '' : `
  # Preserve fields owned by Windows or other software in this same value.
  $parts = @($value.Split(';') | Where-Object { $_.Trim() -ne '' -and $_.Trim() -notmatch '^GpuPreference=' })
  ${preference === 0 ? '' : `$parts += 'GpuPreference=${preference}'`}
  if ($parts.Count -eq 0) {
    $key.DeleteValue($name, $false)
  } else {
    $key.SetValue($name, ($parts -join ';') + ';', [Microsoft.Win32.RegistryValueKind]::String)
  }
  $value = [string]$key.GetValue($name, '')
  `}
  $selected = 0
  foreach ($part in $value.Split(';')) {
    if ($part.Trim() -match '^GpuPreference=([012])$') { $selected = [int]$Matches[1] }
  }
  @{ supported = $true; preference = $selected } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $key) { $key.Dispose() }
}
`;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 10000 }, (error, stdout) => {
        if (error) return reject(new Error('Could not access the Windows GPU preference. Please try again or use Windows Graphics settings.'));
        try { resolve(JSON.parse(stdout.trim())); } catch { reject(new Error('Could not read the Windows GPU preference.')); }
      });
  });
}

module.exports = { gpuPreference };
