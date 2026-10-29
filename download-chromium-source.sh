#!/usr/bin/env bash
# Download current Chromium + its pinned WebRTC source/dependencies; no build.
# https://chromium.googlesource.com/chromium/src/+/main/docs/linux/build_instructions.md
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
destination="${1:-$script_dir/.chromium-source}"
for tool in git python3; do
  command -v "$tool" >/dev/null || { echo "Missing dependency: $tool" >&2; exit 1; }
done

mkdir -p "$destination"
destination="$(cd -- "$destination" && pwd)"
[[ "$destination" != *' '* ]] || { echo 'Choose a destination without spaces.' >&2; exit 1; }
depot_tools="$destination/depot_tools"
checkout="$destination/chromium"

if [[ ! -d "$depot_tools/.git" ]]; then
  git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git "$depot_tools"
fi
export PATH="$depot_tools:$PATH"
mkdir -p "$checkout"
cd -- "$checkout"

if [[ -f .gclient ]]; then
  gclient sync --nohooks --no-history
else
  fetch --nohooks --no-history chromium
fi

printf '\nChromium source: %s/src\n' "$checkout"
printf 'WebRTC / SCReAM: %s/src/third_party/webrtc/modules/congestion_controller/scream\n' "$checkout"
echo 'Download finished. Nothing was built. Rerun this script to sync/resume.'
