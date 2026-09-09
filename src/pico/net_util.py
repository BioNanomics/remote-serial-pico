"""Pure logic pulled out of main.py so it can be unit-tested on a desktop
Python interpreter, with no MicroPython, no hardware, no network.

MicroPython-safe: stdlib only, no f-strings in hot loops here (none needed),
no type hints.
"""


def safe_decode(data):
    """Decode UART/TCP bytes without ever raising on malformed input.

    A single bad byte from a noisy serial line used to raise inside the read
    loop; depending on exactly where, that could go uncaught and kill the
    whole program permanently (issue #19: "invalid UTF-8 doesn't disconnect").
    errors='replace' keeps every good byte and swaps bad ones for U+FFFD
    instead of throwing the whole chunk away.
    """
    if data is None:
        return ''
    return data.decode('utf-8', 'replace')


class Backoff:
    """Capped exponential backoff with no jitter needed at this scale.

    Reused for both TCP reconnects and WiFi reconnects so a downed Pi or
    router does not get hammered every few seconds forever.
    """

    def __init__(self, base=1, cap=30, factor=2):
        if base <= 0 or cap <= 0 or factor <= 1:
            raise ValueError('base and cap must be positive, factor must be > 1')
        self.base = base
        self.cap = cap
        self.factor = factor
        self._delay = base

    def reset(self):
        self._delay = self.base

    def next(self):
        """Return the delay to wait now, then grow it for next time."""
        delay = self._delay
        self._delay = min(self._delay * self.factor, self.cap)
        return delay
