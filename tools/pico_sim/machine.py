"""Stand-in for MicroPython's `machine` module, for running main.py on a desktop.

Only what main.py touches: Pin, UART, WDT, reset. The UART is wired to the
process's stdin/stdout so a test can play the serial device:

  stdin   UART-RX <hex>      bytes the device "sends" (main.py reads them)
  stdout  UART-TX <hex>      bytes main.py wrote to the device

The watchdog is real in the one way that matters: a feed gap longer than the
timeout ends the process with exit code 3, the way the RP2040 would reset.
"""
import collections
import os
import sys
import threading
import time

_rx = collections.deque()
_rx_lock = threading.Lock()


def _say(line):
    sys.stdout.write(line + '\n')
    sys.stdout.flush()


def feed_uart(data):
    with _rx_lock:
        _rx.append(bytes(data))


def _stdin_reader():
    for line in sys.stdin:
        line = line.strip()
        if line.startswith('UART-RX '):
            feed_uart(bytes.fromhex(line[8:]))
        elif line == 'EXIT':
            os._exit(0)
    os._exit(0)   # harness went away


threading.Thread(target=_stdin_reader, daemon=True).start()


class Pin:
    OUT = 1
    IN = 0

    def __init__(self, *args, **kwargs):
        self._value = 0

    def on(self):
        self._value = 1

    def off(self):
        self._value = 0

    def value(self, v=None):
        if v is None:
            return self._value
        self._value = 1 if v else 0


class UART:
    def __init__(self, uart_id, baudrate=9600, **kwargs):
        self.uart_id = uart_id

    def init(self, *args, **kwargs):
        pass

    def any(self):
        with _rx_lock:
            return sum(len(chunk) for chunk in _rx)

    def read(self, nbytes=None):
        with _rx_lock:
            if not _rx:
                return None
            data = b''.join(_rx)
            _rx.clear()
        return data

    def write(self, data):
        if isinstance(data, str):
            data = data.encode('utf-8')
        _say('UART-TX ' + bytes(data).hex())
        return len(data)


class WDT:
    def __init__(self, timeout=8388):
        self.timeout = timeout / 1000.0
        self._last = time.monotonic()
        self.max_gap = 0.0

    def feed(self):
        now = time.monotonic()
        gap = now - self._last
        self._last = now
        if gap > self.max_gap:
            self.max_gap = gap
        if gap > self.timeout:
            _say('WDT-RESET gap=%.2fs' % gap)
            os._exit(3)


def reset():
    _say('MACHINE-RESET')
    os._exit(4)
