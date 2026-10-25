# Copy the debug APK into the phone's Download folder over USB file transfer (MTP).
# Use this when `adb install` is not possible (e.g. Xiaomi/POCO "Install via USB" blocked).
# Then on the phone: Files -> Downloads -> NightWay.apk -> Install (update) -> Open.
#   powershell -ExecutionPolicy Bypass -File scripts\push-apk.ps1
$apk = Join-Path $PSScriptRoot "..\frontend\android\app\build\outputs\apk\debug\app-debug.apk"
if (-not (Test-Path $apk)) { Write-Error "Build the APK first: bash scripts/build-apk.sh"; exit 1 }
$tmp = Join-Path $env:TEMP "NightWay.apk"
Copy-Item $apk $tmp -Force
$shell = New-Object -ComObject Shell.Application
$phone = $shell.Namespace(17).Items() | Where-Object { $_.Type -match "phone|Mobile|Portable" -or $_.Name -match "POCO|Xiaomi|Redmi|Android|Galaxy|Pixel" } | Select-Object -First 1
if (-not $phone) { Write-Error "No phone in This PC. Connect it and choose 'File transfer' on the phone."; exit 1 }
$storage = $phone.GetFolder.Items() | Select-Object -First 1
$dl = $storage.GetFolder.Items() | Where-Object { $_.Name -eq "Download" } | Select-Object -First 1
$old = $dl.GetFolder.Items() | Where-Object { $_.Name -eq "NightWay.apk" }
if ($old) { $old.InvokeVerb("delete") ; Start-Sleep -Seconds 2 }
$dl.GetFolder.CopyHere($tmp, 16)
Start-Sleep -Seconds 6
$f = $dl.GetFolder.Items() | Where-Object { $_.Name -eq "NightWay.apk" }
Write-Output ("Copied to " + $phone.Name + "\" + $storage.Name + "\Download\NightWay.apk (" + $f.ExtendedProperty("System.Size") + " bytes)")
