#!/usr/bin/env bash
# Download the latest official Chromium development snapshot (Linux x64).
set -euo pipefail

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo 'This script requires Linux x86_64.' >&2
  exit 1
fi
for tool in curl unzip; do
  command -v "$tool" >/dev/null || { echo "Missing dependency: $tool" >&2; exit 1; }
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
base_url='https://commondatastorage.googleapis.com/chromium-browser-snapshots/Linux_x64'
revision="$(curl --fail --silent --show-error --location "$base_url/LAST_CHANGE")"
[[ "$revision" =~ ^[0-9]+$ ]] || { echo 'Invalid snapshot revision.' >&2; exit 1; }
destination="$script_dir/.chromium/$revision"
if [[ ! -x "$destination/chrome-linux/chrome" ]]; then
  mkdir -p "$script_dir/.chromium"
  temporary_dir="$(mktemp -d "$script_dir/.chromium/download.XXXXXX")"
  trap 'rm -rf -- "$temporary_dir"' EXIT
  echo "Downloading Chromium snapshot $revision..."
  curl --fail --location --retry 3 --output "$temporary_dir/chrome-linux.zip" \
    "$base_url/$revision/chrome-linux.zip"
  unzip -q "$temporary_dir/chrome-linux.zip" -d "$temporary_dir"
  mkdir -p "$destination"
  mv "$temporary_dir/chrome-linux" "$destination/"
fi
ln -sfn "$revision/chrome-linux" "$script_dir/.chromium/latest"
echo "Downloaded to: $destination/chrome-linux"
"$destination/chrome-linux/chrome" --version
