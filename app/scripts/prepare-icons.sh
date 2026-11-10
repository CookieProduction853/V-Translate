#!/usr/bin/env bash
# Developer format conversion only; the distributed app needs no ImageMagick.
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if command -v magick >/dev/null 2>&1; then
  icon_converter=magick
elif command -v convert >/dev/null 2>&1; then
  icon_converter=convert
else
  echo 'Install ImageMagick to convert the supplied PNG into Windows ICO sizes.' >&2
  exit 1
fi
icon_source="$project_root/assets/app-icon.png"
if [ -f "$project_root/assets/TASK BAR ICON.png" ]; then
  icon_source="$project_root/assets/TASK BAR ICON.png"
fi
"$icon_converter" "$icon_source" \
  -define icon:auto-resize=256,128,64,48,32,24,16 \
  "$project_root/assets/app-icon.ico"
