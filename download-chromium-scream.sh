#!/usr/bin/env bash
# Official development snapshot with WebRTC SCReAM v2 launch settings.
# DualPI2 is a network queue discipline, configured separately on the bottleneck.
# References:
# https://chromium.googlesource.com/external/webrtc/+/refs/heads/master/api/transport/goog_cc_factory.cc
# https://datatracker.ietf.org/meeting/124/materials/slides-124-hackathon-sessd-l4s-interop-02
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-}" in
  '') launch=false ;;
  --launch) launch=true; shift ;;
  *) echo "Usage: $0 [--launch [browser arguments...]]" >&2; exit 2 ;;
esac

"$script_dir/download-chromium.sh"
browser="$script_dir/.chromium/latest/chrome"
trials='WebRTC-RFC8888CongestionControlFeedback/Enabled,offer:true,force_send:true/WebRTC-Bwe-ScreamV2/Enabled/'

if [[ "$launch" == true ]]; then
  exec "$browser" \
    --user-data-dir="$script_dir/.chromium/scream-profile" \
    --force-fieldtrials="$trials" \
    --enable-logging=stderr \
    --vmodule=scream_v2=1 \
    "$@"
fi

echo 'Ready. Launch with SCReAM v2 and RFC 8888 feedback:'
printf '  %q --launch\n' "$script_dir/download-chromium-scream.sh"
echo 'SCReAM requires negotiated RFC 8888 feedback; enable it at both peers.'
echo 'DualPI2 must be configured separately on the network bottleneck.'
