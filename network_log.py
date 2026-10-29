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
        self.packet_logs = {}
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
        if self.configuration.get('queue') == 'droptail':
            self.read_fifo_logs()
        for pid, sample in self.queues.items():
            if isinstance(pid, int):
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

    def read_fifo_logs(self):
        """FIFO drops happen at enqueue, so +/-/d events account for all packets.

        Outstanding includes the packet currently being serialized. Departure
        delay includes queueing and serialization; it is not a current HOL age.
        """
        for direction in ['uplink', 'downlink']:
            path = self.runtime / f'{direction}.log'
            if not path.exists():
                continue
            state = self.packet_logs.setdefault(direction, {
                'position': 0, 'pending': '', 'arrived': 0, 'departed': 0,
                'arrived_bytes': 0, 'departed_bytes': 0, 'drop': 0,
                'dropped_bytes': 0, 'last_sojourn_ms': None, 't_ms': 0,
            })
            with path.open() as source:
                source.seek(state['position'])
                text = state['pending'] + source.read()
                state['position'] = source.tell()
            lines = text.split('\n')
            state['pending'] = lines.pop()
            for line in lines:
                fields = line.split()
                if len(fields) < 3 or not fields[0].isdigit():
                    continue
                state['t_ms'] = int(fields[0])
                event, size = fields[1], int(fields[2])
                if event == '+':
                    state['arrived'] += 1
                    state['arrived_bytes'] += size
                elif event == '-':
                    state['departed'] += 1
                    state['departed_bytes'] += size
                    if len(fields) > 3:
                        state['last_sojourn_ms'] = float(fields[3])
                elif event == 'd':
                    state['drop'] += size
                    state['dropped_bytes'] += int(fields[3])
            self.queues[direction] = {
                'unix_time_ms': round(time.time() * 1000), 'direction': direction,
                't_ms': state['t_ms'],
                'outstanding_pkts': state['arrived'] - state['departed'] - state['drop'],
                'outstanding_bytes': state['arrived_bytes'] - state['departed_bytes'] - state['dropped_bytes'],
                'arrived_packets': state['arrived'], 'departed_packets': state['departed'],
                'last_sojourn_ms': state['last_sojourn_ms'],
                'drop': state['drop'], 'ecn_mark': 0,
                'source': 'fifo_packet_log',
            }

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
