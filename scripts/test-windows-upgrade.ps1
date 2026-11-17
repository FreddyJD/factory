$ErrorActionPreference = 'Stop'
$legacy = Join-Path $env:LOCALAPPDATA 'Git Factory'
$oldProduct = 'HKCU:\Software\freddyjd\Git Factory'
$oldUninstall = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Git Factory'
$newProduct = 'HKCU:\Software\freddyjd\factory'
$newUninstall = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\factory'
$installer = Get-ChildItem 'src-tauri/target/release/bundle/nsis/factory_*-setup.exe' | Select-Object -First 1
if (!$installer) { throw 'Renamed installer missing' }
if ((Test-Path $oldProduct) -or (Test-Path $newProduct) -or (Test-Path $legacy)) {
  throw 'Upgrade fixture requires a clean CI runner, not an existing installation'
}
New-Item -ItemType Directory -Force $legacy | Out-Null
Copy-Item 'src-tauri/target/release/git-factory.exe' (Join-Path $legacy 'git-factory.exe')
New-Item -Force $oldProduct | Out-Null
Set-Item -Path $oldProduct -Value $legacy
New-Item -Force $oldUninstall | Out-Null
New-ItemProperty $oldUninstall -Name 'MainBinaryName' -Value 'git-factory.exe' -PropertyType String | Out-Null
New-ItemProperty $oldUninstall -Name 'DisplayName' -Value 'Git Factory' -PropertyType String | Out-Null
$process = Start-Process -FilePath $installer.FullName -ArgumentList '/S', '/NS' -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Installer failed with exit code $($process.ExitCode)" }
if (!(Test-Path (Join-Path $legacy 'git-factory.exe'))) { throw 'Previous application location was not retained' }
if (!(Test-Path (Join-Path $legacy 'factory-cli.exe'))) { throw 'Console integration executable missing' }
if (!(Test-Path $newProduct)) { throw 'New factory product registration missing' }
if ((Get-Item $newProduct).GetValue('') -ne $legacy) { throw 'Installer did not adopt the previous install path' }
if ((Get-ItemProperty $newUninstall).DisplayName -ne 'factory') { throw 'Application name is not lowercase factory' }
if ((Test-Path $oldProduct) -or (Test-Path $oldUninstall)) { throw 'Legacy installer registration remains' }
Write-Output 'Legacy Git Factory install migrated to factory without a second installation.'
