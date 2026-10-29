# WebRTC + Mahimahi

Download Chromium (SCReAM is enabled by the test launcher):

```bash
./download-chromium-scream.sh
```

Run with the **1 Mbps trace, 25 ms delay each way**. Click **Start/Stop**:

```bash
python3 video_test.py
```

Change the trace or one-way delay:

```bash
python3 video_test.py --trace /path/to/trace
python3 video_test.py --delay-ms 50
# Or both:
python3 video_test.py --trace /path/to/trace --delay-ms 50
```

Step capacity **3 → 1 → 2 Mbps**, 12 seconds each, repeating:

```bash
python3 video_test.py --trace traces/3-1-2mbps.trace
```

Compare queues (same 100-packet limit in both directions by default):

```bash
python3 video_test.py --queue fifo --queue-packets 100
python3 video_test.py --queue dualpi2 --queue-packets 100
```

Combine `--queue` with `--trace` and `--delay-ms`. FIFO uses tail drop;
it does not add ECN marks. Its displayed delay is the last delivered
packet's queueing + serialization time; outstanding includes in-service traffic.

The trace clock starts with the launcher, not the video's Start button.

Video flows sender → receiver; each direction has its own bottleneck.
Results: `output/{mahimahi,sender,receiver}.jsonl`.

## Verified network behavior

- **Mahimahi:** sender runs inside its network namespace, receiver outside; ICE candidates are restricted to the virtual link. Actual queue activity is recorded in `output/mahimahi.jsonl`.
- **SCReAM:** `ScreamV2:` updates in `.runtime/mahimahi/sender.log` show the controller running, not just a launch flag.
- **L4S (DualPI2 mode):** both directions use DualPI2. FIFO has no L4S AQM. ECT(1) and CE packets were verified at the receiver; SCReAM's `l4s_alpha` responds to congestion marks in the same log.

```bash
tail -f .runtime/mahimahi/sender.log | grep 'ScreamV2:'
```
