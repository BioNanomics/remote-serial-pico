#!/usr/bin/env python3
"""A Pico W that is not there: speaks wire protocol v1 to an installed PtyServer
using the firmware's own protocol code (src/pico/net_util.PicoLink and
src/pico/frame.py run unchanged on CPython), then plays Node-RED on the pty
side and checks bytes cross in both directions.

Run inside the install-test container, as the service user:

    python3 fake_pico.py --src /home/project/remote-serial-pico/src/pico

Exit 0 when both directions relay byte-exact, 1 on any mismatch or timeout.
--high-bytes adds a 0x80-0xFF round trip; its result is reported but only
fails the run with --strict-high-bytes.
"""
import argparse
import os
import select
import socket
import sys
import time
import tty


def log(msg):
    print(f'[fake-pico] {msg}', flush=True)


def connect(host, port, timeout):
    deadline = time.monotonic() + timeout
    while True:
        try:
            return socket.create_connection((host, port), timeout=2)
        except OSError as err:
            if time.monotonic() > deadline:
                raise SystemExit(f'[fake-pico] cannot connect to {host}:{port}: {err}')
            time.sleep(0.5)


def pump(sock, link, until, timeout):
    """Read frames until until(events_so_far) is true. Answers protocol replies."""
    seen = []
    deadline = time.monotonic() + timeout
    while not until(seen):
        left = deadline - time.monotonic()
        if left <= 0:
            return seen, False
        ready, _, _ = select.select([sock], [], [], left)
        if not ready:
            continue
        chunk = sock.recv(4096)
        if not chunk:
            raise SystemExit('[fake-pico] server closed the connection')
        for kind, value in link.receive(chunk):
            if kind == 'send':
                sock.sendall(value)
            elif kind in ('refused', 'close'):
                raise SystemExit(f'[fake-pico] server said {kind}: {value}')
            seen.append((kind, value))
    return seen, True


def wait_for_pty(path, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            target = os.readlink(path)
            if os.path.exists(target):
                return target
        except OSError:
            pass
        time.sleep(0.1)
    raise SystemExit(f'[fake-pico] {path} never pointed at a live pty')


def read_pty(fd, n, timeout):
    got = b''
    deadline = time.monotonic() + timeout
    while len(got) < n:
        left = deadline - time.monotonic()
        if left <= 0:
            break
        ready, _, _ = select.select([fd], [], [], left)
        if ready:
            got += os.read(fd, 4096)
    return got


def round_trip(sock, link, fd, to_device, from_device, timeout):
    """Node-RED writes to_device into the pty; the device answers from_device."""
    ok = True

    # pty -> PtyServer -> DATA frames -> "UART"
    os.write(fd, to_device)
    want = len(to_device)
    seen, _ = pump(sock, link,
                   lambda ev: sum(len(v) for k, v in ev if k == 'data') >= want, timeout)
    got = b''.join(v for k, v in seen if k == 'data')
    if got == to_device:
        log(f'pty -> device OK    {to_device!r}')
    else:
        log(f'pty -> device FAIL  sent {to_device!r}, device got {got!r}')
        ok = False

    # "UART" -> DATA frames -> PtyServer -> pty
    for frame in link.data_frames(from_device):
        sock.sendall(frame)
    got = read_pty(fd, len(from_device), timeout)
    if got == from_device:
        log(f'device -> pty OK    {from_device!r}')
    else:
        log(f'device -> pty FAIL  sent {from_device!r}, pty got {got!r}')
        ok = False
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True, help='directory holding net_util.py and frame.py')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=50000)
    ap.add_argument('--id', default='c1c1c1c1c1c1c1c1', help='16 hex chars')
    ap.add_argument('--link-dir', default='/home/project')
    ap.add_argument('--timeout', type=float, default=10)
    ap.add_argument('--high-bytes', action='store_true')
    ap.add_argument('--strict-high-bytes', action='store_true')
    args = ap.parse_args()

    sys.path.insert(0, args.src)
    from net_util import PicoLink

    sock = connect(args.host, args.port, 30)
    sock.setblocking(True)
    link = PicoLink(args.id, 'ci-fake', 'ci-fake')
    sock.sendall(link.register_frame())
    _, ok = pump(sock, link, lambda ev: any(k == 'registered' for k, _ in ev), args.timeout)
    if not ok:
        raise SystemExit('[fake-pico] no REGISTER_ACK')
    log(f'registered as {link.name!r}')

    link_path = os.path.join(args.link_dir, link.name)
    pts = wait_for_pty(link_path, args.timeout)
    log(f'{link_path} -> {pts}')

    # What a serial client such as Node-RED does first: raw mode, no echo.
    fd = os.open(link_path, os.O_RDWR | os.O_NOCTTY)
    tty.setraw(fd)

    passed = round_trip(sock, link, fd,
                        b'#255.102.255.A=UP\r',
                        b'#255.102.255.A=OK\r\n',
                        args.timeout)
    # Bytes that look like protocol must still be plain data.
    passed &= round_trip(sock, link, fd,
                         b'PING\x7e\x01PONG\r',
                         b'\x7e\x01\x10PING\r',
                         args.timeout)

    if args.high_bytes:
        high = bytes(range(0x80, 0x100))
        high_ok = round_trip(sock, link, fd, high, high, args.timeout)
        log(f'high bytes (0x80-0xFF) {"OK" if high_ok else "NOT byte-transparent"}')
        if args.strict_high_bytes:
            passed &= high_ok
        elif not high_ok:
            print('HIGH_BYTES_FAILED', flush=True)

    os.close(fd)
    sock.close()
    log('PASS' if passed else 'FAIL')
    return 0 if passed else 1


if __name__ == '__main__':
    sys.exit(main())
