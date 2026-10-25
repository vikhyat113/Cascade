#!/usr/bin/env bash
# Build the NightWay debug APK (spec §12 Phase 1). Works in Git Bash on Windows, macOS and Linux.
#   scripts/build-apk.sh            build
#   scripts/build-apk.sh --install  build and install on the USB-connected phone
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/frontend"
npm run build
npx cap sync android
cd android
if [[ "${OS:-}" == "Windows_NT" ]]; then
  # tools installed per-user in Phase 0 (ENVIRONMENT.md); a shell opened before that has no JAVA_HOME yet
  LAD="$(cygpath -u "${LOCALAPPDATA:-}")"
  [[ -n "${JAVA_HOME:-}" ]] || export JAVA_HOME="$(ls -d "$LAD"/nightway-tools/jdk17/jdk-17* | head -1)"
  [[ -n "${ANDROID_HOME:-}" ]] || export ANDROID_HOME="$LAD/Android/Sdk"
fi
sh ./gradlew assembleDebug
APK="$ROOT/frontend/android/app/build/outputs/apk/debug/app-debug.apk"
echo
echo "APK: $APK"
if [[ "${1:-}" == "--install" ]]; then adb install -r "$APK"; fi
