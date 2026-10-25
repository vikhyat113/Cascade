# Environment (Phase 0)

Recorded 2026-10-26 on the build laptop.

| Item | Version / path | How it got here |
|---|---|---|
| OS | Windows 11 Home 10.0.26300 (x64) | – |
| git | 2.51.0.windows.2 | already installed |
| Node.js / npm | v25.6.1 / 11.9.0 | already installed (newer than LTS; works with Vite 6 and Capacitor 6) |
| Python | 3.14.3 (+ pip 26) | already installed |
| Python packages | osmnx 2.1.1, shapely 2.2, requests (via deps), numpy, scipy, fastapi… in `backend/.venv` | installed earlier into the project venv (`backend/requirements-data.txt`) |
| JDK 17 | Eclipse Temurin 17.0.20.1+1 at `%LOCALAPPDATA%\nightway-tools\jdk17\jdk-17.0.20.1+1` | **installed now**: official zip from api.adoptium.net, no admin rights needed (Java 8 is also on the machine; JAVA_HOME points at 17) |
| Android SDK | `%LOCALAPPDATA%\Android\Sdk` | **installed now**: Google command-line tools 11076708, licenses accepted |
| SDK packages | platform-tools 37.0.1 (adb 1.0.41), platforms;android-34, build-tools;34.0.0 | `sdkmanager` |
| Env vars (user scope) | `JAVA_HOME`, `ANDROID_HOME`, PATH += jdk\bin, platform-tools, cmdline-tools\latest\bin | set with `[Environment]::SetEnvironmentVariable(..., "User")`. Open a new terminal to pick them up. |

Why zips instead of winget: the Temurin and Android installers want admin/UAC; the official zips install per-user with no prompt.

## Phone

| Item | Value |
|---|---|
| Model | POCO X6 Pro 5G (USB VID 2717 / PID FF40 = Xiaomi, file-transfer mode) |
| Android version | not read yet (adb still not connected; HyperOS on Android 14 expected for this model) |
| `adb devices` | **empty at Phase 0**: Windows sees the phone only as a file-transfer (MTP) device, so USB debugging is off |

To enable (Xiaomi / POCO, HyperOS): Settings → About phone → tap **OS version** 7 times → back → Additional settings → Developer options → turn on **USB debugging** and **Install via USB** (Xiaomi asks you to be signed in to a Mi account for "Install via USB"). Reconnect the cable and accept the "Allow USB debugging?" prompt on the phone.

## Re-check commands

```bash
java -version            # 17.0.20.1
adb devices -l           # phone listed as "device"
adb shell getprop ro.build.version.release
adb reverse tcp:8787 tcp:8787   # when the dispatch server runs (Phase 4)
```

## How the APK gets onto this phone (Phase 1 result)

`adb` still lists no device (Windows sees the phone as file-transfer only, product ID FF40), and Xiaomi's "Install via USB" is blocked. So installs go over **USB file transfer**:

```powershell
bash scripts/build-apk.sh                                          # build
powershell -ExecutionPolicy Bypass -File scripts\push-apk.ps1      # copy to the phone's Download folder
```
On the phone: **Files → Downloads → NightWay.apk → Install/Update → Open**. Verified working on 2026-10-26 (the Phase 1 build opens).
Consequence: no `adb reverse`, so the phone reaches the laptop's dispatch server over **Wi-Fi** (laptop LAN IP set in the Demo drawer) instead of USB.
