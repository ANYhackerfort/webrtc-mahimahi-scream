# Code guide

## `server.mjs`

Local web server for the test. It serves the page, relays WebRTC setup
messages between browsers, saves sender/receiver statistics, and supplies
live statistics to the graphs. Video packets travel directly between the
browsers through Mahimahi, not through this server.

- `connectEvents()`: opens a persistent connection for signaling messages.
- `relaySignal()`: forwards offers, answers, ICE candidates, and Start/Stop commands.
- `recordTelemetry()`: saves browser samples to `output/sender.jsonl` or `receiver.jsonl`.
- `serveNetworkStats()`: returns the latest Mahimahi and browser samples for the display.
- `handleRequest()`: routes requests to these functions or serves page assets.

## `video_test.py`

Mahimahi-only launcher: starts the emulator, both browsers, and the server,
then stops its processes on exit. Every function below supports this run.

- `main()`: reads `--trace`, `--queue`, `--queue-packets`, `--delay-ms`, `--video`, and `--output-dir`.
- `run_mahimahi_test()`: starts Mahimahi's bandwidth/delay emulation, queue logger, server, and receiver. It always uses Mahimahi.
- `run_inside_mahimahi()`: runs inside the emulator, records its addresses, then launches the sender.
- `browser_command()`: builds Chromium arguments, including SCReAM/RFC 8888 settings, Y4M input, and separate browser profiles.
- `find_trace()`: selects the supplied trace or the default 1 Mbps trace.
- `prepare_video()`: uses a supplied Y4M file or generates the default test pattern.
- `wait_until()` / `server_ready()`: wait for startup readiness and detect failures.
- `TestProcesses.start()` / `wait()` / `close()`: launch, monitor, and clean up process groups.

Useful settings near the top: `SCREAM_TRIALS`, `DEFAULT_TRACE`, `BROWSER`, and `PORT`.
