"""Stand-in for MicroPython's `network` module.

Joins instantly, unless PICO_SIM_WIFI_FAILS=N is set, in which case the first
N connect() calls raise OSError EPERM, the way a freshly flashed Pico W's radio
does on its first boot (seen on two boards, 2026-09-11).
"""
import os

STA_IF = 0
AP_IF = 1

STAT_IDLE = 0
STAT_CONNECTING = 1
STAT_GOT_IP = 3

_fails_left = int(os.environ.get('PICO_SIM_WIFI_FAILS', '0'))


class WLAN:
    def __init__(self, interface=STA_IF):
        self._active = False
        self._connected = False

    def active(self, on=None):
        if on is None:
            return self._active
        self._active = bool(on)
        if not on:
            self._connected = False

    def connect(self, ssid, password):
        global _fails_left
        if _fails_left > 0:
            _fails_left -= 1
            raise OSError(1, 'EPERM')
        self._connected = True

    def isconnected(self):
        return self._connected

    def status(self):
        return STAT_GOT_IP if self._connected else STAT_CONNECTING

    def ifconfig(self):
        return ('127.0.0.1', '255.0.0.0', '127.0.0.1', '127.0.0.1')
