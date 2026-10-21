#!/usr/bin/env bash
# sim.sh: iOS Simulator (xcrun simctl + idb) and Android emulator (adb).
# Coordinates: iOS device points; Android device pixels.
#   sim.sh detect                  -> platform and device ID
#   sim.sh env                     -> shell exports for explicit device selection
#   sim.sh boot [device]
#   sim.sh build                   -> project scripts/sim-build.sh; exit 3 if absent
#   sim.sh install <app|apk>
#   sim.sh open <url|bundle-id>
#   sim.sh tap <x> <y>             -> requires idb for iOS
#   sim.sh type "<text>"
#   sim.sh settle [timeout_s]      -> compare successive screenshots until stable
#   sim.sh shot <out.png>
#   sim.sh log <out.log> [process] -> incremental logs; Android uses a tag filter
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM="${SIM_PLATFORM:-}"; DEVICE="${SIM_DEVICE:-}"
STAMP_DIR="${SIM_STATE_DIR:-.devloop/sim-state}"

detect() {
  if command -v xcrun >/dev/null 2>&1 && xcrun simctl list devices booted 2>/dev/null | grep -q "(Booted)"; then
    PLATFORM=ios; DEVICE=$(xcrun simctl list devices booted | grep Booted | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
  elif command -v adb >/dev/null 2>&1 && adb devices | awk '$1 ~ /^emulator-/ && $2=="device"{found=1} END{exit !found}'; then
    PLATFORM=android; DEVICE=$(adb devices | awk '$1 ~ /^emulator-/ && $2=="device"{print $1; exit}')
  else PLATFORM=none; DEVICE=""; fi
  echo "$PLATFORM $DEVICE"
}
need() {
  if [ -z "$PLATFORM" ]; then read -r PLATFORM DEVICE < <(detect); fi
  case "$PLATFORM" in ios|android) ;; *) echo "no supported simulator/emulator booted" >&2; exit 2;; esac
  [ -n "$DEVICE" ] || { echo "SIM_DEVICE is required with SIM_PLATFORM" >&2; exit 2; }
}
arg() { local required="$1"; shift; [ $# -ge "$required" ] || { echo "usage: see header of $0" >&2; exit 1; }; }

cmd="${1:-help}"; shift || true
case "$cmd" in
  help|--help|-h)
    sed -n '2,15p' "$0"
    printf '\nFull plugin guide: use the help skill.\n'
    exit 0 ;;
  detect) detect ;;
  env) read -r PLATFORM DEVICE < <(detect); printf "export SIM_PLATFORM=%q SIM_DEVICE=%q\n" "$PLATFORM" "$DEVICE" ;;
  boot)
    if [ "$PLATFORM" = ios ] || { [ -z "$PLATFORM" ] && command -v xcrun >/dev/null; }; then xcrun simctl boot "${1:-iPhone 15}" 2>/dev/null || true; open -a Simulator
    else emulator -avd "${1:-$(emulator -list-avds | head -1)}" -no-snapshot-load >/dev/null 2>&1 & fi ;;
  build)
    [ -x ./scripts/sim-build.sh ] || { echo "no ./scripts/sim-build.sh — add a repo script that builds and installs on the simulator" >&2; exit 3; }
    ./scripts/sim-build.sh ;;
  install) arg 1 "$@"; need
    case $PLATFORM in ios) xcrun simctl install "$DEVICE" "$1";; android) adb -s "$DEVICE" install -r "$1";; esac ;;
  open) arg 1 "$@"; need
    case $PLATFORM in
      ios) if [[ "$1" == *://* ]]; then xcrun simctl openurl "$DEVICE" "$1"; else xcrun simctl launch "$DEVICE" "$1"; fi ;;
      android) if [[ "$1" == *://* ]]; then adb -s "$DEVICE" shell am start -a android.intent.action.VIEW -d "$1"; else adb -s "$DEVICE" shell monkey -p "$1" 1 >/dev/null; fi ;;
    esac ;;
  tap) arg 2 "$@"; need
    case $PLATFORM in
      ios) command -v idb >/dev/null || { echo "tap on iOS needs idb (device-point coordinates). Install: brew tap facebook/fb && brew install idb-companion && pip install fb-idb" >&2; exit 4; }
           idb ui tap --udid "$DEVICE" "$1" "$2" ;;
      android) adb -s "$DEVICE" shell input tap "$1" "$2" ;;
    esac ;;
  type) arg 1 "$@"; need
    case $PLATFORM in
      ios) if command -v idb >/dev/null; then idb ui text --udid "$DEVICE" "$1"
           else osascript -e 'tell application "Simulator" to activate' -e 'on run argv' -e 'tell application "System Events" to keystroke item 1 of argv' -e 'end run' "$1"; fi ;;
      android) # input text supports escaped ASCII; spaces become %s and special characters are escaped
           t=$(printf %s "$1" | sed -e 's/[][\\&<>()|;*~"'"'"'`$]/\\&/g' -e 's/ /%s/g'); adb -s "$DEVICE" shell input text "$t" ;;
    esac ;;
  shot) arg 1 "$@"; need
    mkdir -p "$(dirname "$1")"
    case $PLATFORM in
      ios) xcrun simctl io "$DEVICE" screenshot "$1" >/dev/null ;;
      android) adb -s "$DEVICE" exec-out screencap -p > "$1" ;;
    esac; [ -s "$1" ] || { echo "screenshot failed" >&2; exit 5; }; echo "$1" ;;
  settle) need
    timeout="${1:-5}"; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT; t0=$(date +%s)
    export SIM_PLATFORM="$PLATFORM" SIM_DEVICE="$DEVICE"
    "$0" shot "$tmp/a.png" >/dev/null
    while :; do
      sleep 0.3; "$0" shot "$tmp/b.png" >/dev/null
      set +e; python3 "$HERE/imgdiff.py" --same "$tmp/a.png" "$tmp/b.png"; rc=$?; set -e
      case $rc in 0) break;; 1) mv "$tmp/b.png" "$tmp/a.png";; *) echo "imgdiff error (rc=$rc)" >&2; exit 6;; esac
      [ $(( $(date +%s) - t0 )) -lt "$timeout" ] || { echo "settle timeout: screen still changing" >&2; exit 7; }
    done ;;
  log) arg 1 "$@"; need
    mkdir -p "$STAMP_DIR" "$(dirname "$1")"
    device_key=$(printf '%s' "$PLATFORM:$DEVICE" | shasum -a 256 | cut -c1-16)
    STAMP="$STAMP_DIR/$device_key.log-stamp"
    proc="${2:-}"
    case $PLATFORM in
      ios) start=$(cat "$STAMP" 2>/dev/null || date -v-2M '+%Y-%m-%d %H:%M:%S'); next_stamp=$(date '+%Y-%m-%d %H:%M:%S')
           args=(--start "$start" --style compact)
           if [ -n "$proc" ]; then
             escaped="${proc//\\/\\\\}"; escaped="${escaped//\"/\\\"}"
             args+=(--predicate "process == \"$escaped\"")
           fi
           xcrun simctl spawn "$DEVICE" log show "${args[@]}" > "$1"
           printf '%s\n' "$next_stamp" > "$STAMP" ;;
      android) python3 "$HERE/android_logs.py" --device "$DEVICE" --out "$1" --state-dir "$STAMP_DIR" --filter "$proc" ;;
    esac ;;
  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
