# Findings: 3 → 1 → 2 Mbps

The trace repeats every 36 seconds: 12 seconds at each capacity. Both
directions have 25 ms added delay. Run each test separately.

**FIFO, 100 packets:** SCReAM slowed down despite zero drops and zero ECN
marks. Logs showed `is_virtual_ce=1`: rising delay triggered congestion
control before the buffer filled.

```bash
python3 video_test.py --trace traces/3-1-2mbps.trace --queue fifo --queue-packets 100
```

**FIFO, 5 packets:** the smaller buffer produced actual drops. At about
13.3 seconds, the snapshot showed 47 forward and 8 reverse drops, with no
ECN marks. This run includes loss; it is not evidence of delay-only slowdown.

```bash
python3 video_test.py --trace traces/3-1-2mbps.trace --queue fifo --queue-packets 5
```

**DualPI2, 100 packets:** unlike FIFO, it can signal congestion with ECN
marks. SCReAM remains the sender's controller in both cases; the queue
policy changes. Use the same buffer size for comparison.

```bash
python3 video_test.py --trace traces/3-1-2mbps.trace --queue dualpi2 --queue-packets 100
```

**Finding:** SCReAM can react to queueing delay without drops or ECN marks.
These observations alone do not establish which queue performs better.
Results are in `output/`; save them before another run overwrites them.
