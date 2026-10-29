"""Record Mahimahi queue counters with the PID of the queue that emitted them.

A Unix datagram socket supplies kernel-authenticated writer credentials. This
keeps the two queues' cumulative counters separate even though mm-link's
uplink and downlink processes inherit the same stdout. No root capture needed.
"""

import json
import re
import socket
import struct
import threading
import time


class NetworkLog:
    def __init__(self, runtime, output_path=None, configuration=None):
        self.runtime = runtime
        self.output_path = output_path or runtime / 'mahimahi.jsonl'
        self.output_path.write_text('')
        self.configuration = configuration or {}
        self.reader, self.writer = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
        self.reader.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        self.reader.settimeout(0.2)
        self.stop = threading.Event()
        self.pending = {}
        self.queues = {}
        self.last_snapshot = 0
        self.error = None
        self.write_snapshot()
        self.thread = threading.Thread(target=self.run, name='mahimahi-log', daemon=True)
        self.thread.start()

    def queue_direction(self, pid):
        try:
            addresses = json.loads((self.runtime / 'addresses.json').read_text())
            return 'uplink' if pid == addresses['uplink_pid'] else 'downlink'
        except (OSError, KeyError, ValueError):
            return 'unknown'

    def record_queue_line(self, pid, line):
        match = re.search(r'\[QUEUE_STATS\] (.*)', line)
        if not match:
            return
        fields = dict(re.findall(r'(\w+)=([-\d.]+)', match.group(1)))
        if not {'t_ms', 'ecn_mark', 'drop', 'q_pkts'} <= fields.keys():
            return
        sample = {
            'unix_time_ms': round(time.time() * 1000),
            'pid': pid,
            'direction': self.queue_direction(pid),
            **{key: float(value) if '.' in value else int(value) for key, value in fields.items()},
        }
        self.queues[pid] = sample

    def write_snapshot(self):
        for pid, sample in self.queues.items():
            sample['direction'] = self.queue_direction(pid)
        queues = list(self.queues.values())
        temporary = self.runtime / 'network-stats.tmp'
        snapshot = {
            'unix_time_ms': round(time.time() * 1000),
            'configuration': self.configuration,
            'queues': queues,
            'dropped_packets': sum(queue['drop'] for queue in queues),
            'ecn_mark_operations': sum(queue['ecn_mark'] for queue in queues),
        }
        temporary.write_text(json.dumps(snapshot))
        temporary.replace(self.runtime / 'network-stats.json')
        with self.output_path.open('a') as output:
            output.write(json.dumps(snapshot) + '\n')
        self.last_snapshot = time.monotonic()

    def run(self):
        try:
            self.record()
        except Exception as error:
            self.error = error

    def record(self):
        credentials_size = struct.calcsize('3i')
        with (self.runtime / 'sender.log').open('wb') as raw_log:
            while True:
                try:
                    payload, ancillary, flags, _ = self.reader.recvmsg(
                        262144, socket.CMSG_SPACE(credentials_size),
                    )
                except socket.timeout:
                    if self.stop.is_set():
                        break
                    if time.monotonic() - self.last_snapshot >= 1:
                        self.write_snapshot()
                    raw_log.flush()
                    continue
                if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
                    raise RuntimeError('Truncated Mahimahi logging datagram')
                pid = next(
                    struct.unpack('3i', data[:credentials_size])[0]
                    for level, kind, data in ancillary
                    if level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS
                )
                raw_log.write(payload)
                text = self.pending.get(pid, '') + payload.decode(errors='replace')
                lines = text.split('\n')
                self.pending[pid] = lines.pop()
                for line in lines:
                    self.record_queue_line(pid, line)
                if time.monotonic() - self.last_snapshot >= 1:
                    self.write_snapshot()
                    raw_log.flush()
            for pid, line in self.pending.items():
                self.record_queue_line(pid, line)
            self.write_snapshot()

    def close(self):
        self.writer.close()
        self.stop.set()
        self.thread.join(timeout=5)
        self.reader.close()
