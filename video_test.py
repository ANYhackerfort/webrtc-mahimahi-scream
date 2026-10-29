#!/usr/bin/env python3
"""Launch a one-way Y4M WebRTC test across a Mahimahi DualPI2 link."""

import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
from urllib.parse import urlencode
from urllib.request import ProxyHandler, build_opener

from network_log import NetworkLog

ROOT = Path(__file__).resolve().parent
BROWSER = ROOT / '.chromium/latest/chrome'
PORT = 8765
# "Enabled" selects SCReAM when the peers negotiate RFC 8888 feedback.
SCREAM_TRIALS = (
    'WebRTC-RFC8888CongestionControlFeedback/Enabled,offer:true,force_send:true/'
    'WebRTC-Bwe-ScreamV2/Enabled/'
)
DEFAULT_TRACE = ROOT / 'traces/fixed-1mbps.trace'
HTTP = build_opener(ProxyHandler({}))


def wait_until(check, description, processes=(), timeout=10):
    """Wait for readiness, failing immediately if a required child exits."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for process in processes:
            if process.poll() is not None:
                raise RuntimeError(f'A test process exited. Check the runtime logs: {description}')
        if check():
            return
        time.sleep(0.1)
    raise RuntimeError(f'Timed out waiting for {description}')


def server_ready(host):
    try:
        with HTTP.open(f'http://{host}:{PORT}/', timeout=0.5) as response:
            return response.status == 200
    except OSError:
        return False


def find_trace(requested):
    trace = Path(requested).expanduser() if requested else DEFAULT_TRACE
    if not trace.is_file():
        raise RuntimeError(f'Trace not found: {trace}')
    return trace.resolve()


def prepare_video(requested):
    video = Path(requested).expanduser().resolve() if requested else ROOT / 'media/test-pattern.y4m'
    if not requested and not video.exists():
        video.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([
            'ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
            '-i', 'testsrc2=size=640x360:rate=30', '-t', '10',
            '-pix_fmt', 'yuv420p', str(video),
        ], check=True)
    if not video.is_file():
        raise RuntimeError(f'Video not found: {video}')
    return video


def browser_command(role, host, video, runtime, ice_address):
    """Keep browser settings in one place for both peers."""
    query = {'role': role, 'iceAddress': ice_address}
    sender = role == 'sender'
    origin = f'http://{host}:{PORT}'
    return [
        str(BROWSER), f'--user-data-dir={runtime / (role + "-profile")}',
        '--disable-background-networking', '--disable-component-update',
        '--disable-sync', '--disable-extensions', '--disable-default-apps',
        '--no-first-run', '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
        f'--use-file-for-fake-video-capture={video}',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
        f'--unsafely-treat-insecure-origin-as-secure={origin}',
        f'--force-fieldtrials={SCREAM_TRIALS}',
        '--enable-logging=stderr', '--vmodule=scream_v2=1',
        f'--remote-debugging-port={9223 if sender else 9224}',
        '--window-size=800,740',
        f'--window-position={"40,60" if sender else "880,60"}',
        f'--app={origin}/?{urlencode(query)}',
    ]


class TestProcesses:
    """Own the test's process groups and stop them when the launcher exits."""

    def __init__(self, runtime):
        self.runtime = runtime
        self.children = []

    def start(self, command, log_name, env=None, output=None):
        if output is not None:
            process = subprocess.Popen(
                command, cwd=ROOT, env=env, stdout=output,
                stderr=subprocess.STDOUT, start_new_session=True,
            )
            self.children.append(process)
            return process
        with (self.runtime / log_name).open('w') as log:
            process = subprocess.Popen(
                command, cwd=ROOT, env=env, stdout=log,
                stderr=subprocess.STDOUT, start_new_session=True,
            )
        self.children.append(process)
        return process

    def close(self):
        for process in reversed(self.children):
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for process in self.children:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()

    def wait(self, network_log):
        while all(process.poll() is None for process in self.children):
            if network_log.error:
                raise RuntimeError(f'Network logging failed: {network_log.error}')
            time.sleep(0.25)
        failed = next((p for p in self.children if p.poll() not in (None, 0)), None)
        if failed:
            raise RuntimeError(f'A test process exited with code {failed.returncode}. See {self.runtime}')


def run_inside_mahimahi(video, runtime):
    """Publish namespace addresses, then replace this helper with the sender."""
    base = os.environ['MAHIMAHI_BASE']
    interfaces = json.loads(subprocess.check_output([
        'ip', '-j', '-4', 'address', 'show', 'dev', 'ingress',
    ]))
    address = interfaces[0]['addr_info'][0]['local']
    temporary = runtime / 'addresses.tmp'
    temporary.write_text(json.dumps({
        'host': base, 'sender': address,
        # The helper is forked by mm-link's uplink queue, then execs Chromium.
        'uplink_pid': os.getppid(),
    }))
    temporary.replace(runtime / 'addresses.json')
    wait_until(lambda: server_ready(base), 'signaling server')
    command = browser_command('sender', base, video, runtime, address)
    os.execv(command[0], command)


def run_mahimahi_test(args):
    """Run both browsers across Mahimahi; there is no direct-network mode."""
    for tool in ['node', 'ffmpeg', 'mm-link', 'mm-delay', 'ip']:
        if not shutil.which(tool):
            raise RuntimeError(f'Missing dependency: {tool}')
    if not BROWSER.is_file():
        subprocess.run([str(ROOT / 'download-chromium.sh')], check=True)

    video = prepare_video(args.video)
    runtime = ROOT / '.runtime/mahimahi'
    runtime.mkdir(parents=True, exist_ok=True)
    output_directory = Path(args.output_dir).expanduser().resolve()
    output_directory.mkdir(parents=True, exist_ok=True)
    processes = TestProcesses(runtime)
    network_log = None
    try:
        trace = find_trace(args.trace)
        address_file = runtime / 'addresses.json'
        address_file.unlink(missing_ok=True)
        configuration = {
            'trace': str(trace), 'queue': 'dualPI2',
            'delay_ms_each_way': args.delay_ms,
            'media_direction': 'sender_to_receiver',
            'independent_capacity_each_way': True,
        }
        network_log = NetworkLog(runtime, output_directory / 'mahimahi.jsonl', configuration)
        command = [
            'mm-link', str(trace), str(trace),
            '--uplink-queue=dualPI2', '--downlink-queue=dualPI2',
            '--',
            sys.executable, str(Path(__file__).resolve()),
            '--inside', '--video', str(video),
        ]
        # mm-delay delays packets in both directions across its namespace.
        if args.delay_ms:
            command = ['mm-delay', str(args.delay_ms), *command]
        mahimahi = processes.start(command, 'sender.log', output=network_log.writer)
        wait_until(address_file.exists, 'Mahimahi namespace', [mahimahi])
        addresses = json.loads(address_file.read_text())
        host, sender_address = addresses['host'], addresses['sender']
        print(f'Trace: {trace}', flush=True)
        (runtime / 'run.json').write_text(json.dumps({
            'trace': str(trace), 'queue': 'dualPI2',
            'delay_ms_each_way': args.delay_ms,
            'added_rtt_ms': 2 * args.delay_ms,
            'started_unix_time_ms': round(time.time() * 1000),
        }, indent=2))

        # Binding the exact test address detects collisions and limits exposure.
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind((host, PORT))
        for role in ['sender', 'receiver']:
            (output_directory / f'{role}.jsonl').write_text('')
        environment = {**os.environ, 'LISTEN_HOST': host, 'OUTPUT_DIR': str(output_directory)}
        environment['NETWORK_STATS_FILE'] = str(runtime / 'network-stats.json')
        server = processes.start(['node', 'server.mjs'], 'server.log', environment)
        wait_until(lambda: server_ready(host), 'signaling server', [server])

        processes.start(browser_command(
            'receiver', host, video, runtime, host,
        ), 'receiver.log')

        print(f'Sender {sender_address} -> Mahimahi DualPI2 -> receiver {host}')
        print(f'Added delay: {args.delay_ms} ms each way (~{2 * args.delay_ms} ms RTT)')
        print(f'Stats: {output_directory}\nClick Start in either browser. Ctrl+C closes the test.', flush=True)
        processes.wait(network_log)
    finally:
        processes.close()
        if network_log:
            network_log.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--video', help='Y4M file; defaults to a generated test pattern')
    parser.add_argument('--trace', default=os.environ.get('TRACE_FILE'), help='Mahimahi trace (default: fixed 1 Mbps)')
    parser.add_argument('--delay-ms', type=int, default=25, help='Added delay in each direction (default: 25 ms)')
    parser.add_argument('--output-dir', default=str(ROOT / 'output'), help='Directory for the three statistics files')
    parser.add_argument('--inside', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.delay_ms < 0:
        parser.error('--delay-ms must be nonnegative')
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        if args.inside:
            run_inside_mahimahi(Path(args.video), ROOT / '.runtime/mahimahi')
        else:
            run_mahimahi_test(args)
    except KeyboardInterrupt:
        pass
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'Error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
