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

Video flows sender → receiver; each direction has its own bottleneck.
Results: `output/{mahimahi,sender,receiver}.jsonl`.

## Verified network behavior

- **Mahimahi:** sender runs inside its network namespace, receiver outside; ICE candidates are restricted to the virtual link. Actual queue activity is recorded in `output/mahimahi.jsonl`.
- **SCReAM:** `ScreamV2:` updates in `.runtime/mahimahi/sender.log` show the controller running, not just a launch flag.
- **L4S:** both directions use DualPI2. ECT(1) and CE packets were verified at the receiver; SCReAM's `l4s_alpha` responds to congestion marks in the same log.

```bash
tail -f .runtime/mahimahi/sender.log | grep 'ScreamV2:'
```
