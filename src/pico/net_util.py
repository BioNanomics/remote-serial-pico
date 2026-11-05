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


def send_all(sock, data):
    """Send every byte of data, however many calls that takes.

    socket.send() is allowed to accept only part of the buffer and return how
    much it took. The old firmware ignored that return value, so a partial
    send silently truncated the command on its way to the serial device.
    """
    sent = 0
    while sent < len(data):
        n = sock.send(data[sent:])
        if not n:
            raise OSError('send made no progress')
        sent += n
    return sent


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


PONG = 'PONG'


def split_pongs(text):
    """Separate heartbeat replies from device data in one received chunk.

    Returns (number_of_pongs, remaining_text). The server answers each PING
    with 'PONG\\n' and nothing stops TCP from delivering that in the same
    chunk as a command for the serial device. A PONG is protocol traffic,
    not something the device should ever see, so it must never reach the
    UART -- but the command travelling with it must.
    """
    pongs = text.count(PONG + '\n')
    rest = text.replace(PONG + '\n', '')
    if rest.strip().upper() == PONG:
        # a bare PONG with no newline, from an older server
        pongs += 1
        rest = ''
    if pongs and not rest.strip():
        rest = ''
    return pongs, rest


class HeartbeatMonitor:
    """Decides when to PING, and when a silent server means the link is gone.

    The office WiFi drops packets (there is a ticket for it), and the original
    firmware tore down a perfectly good TCP connection the first time a single
    PONG went missing, then reconnected -- over and over. Tolerate a few in a
    row and only give up when the connection really is gone.

    Nothing here blocks. main.py asks ping_due()/pong_overdue() once per pass
    of its loop and does the socket work itself, so a slow PONG never stalls
    the UART relay and never starves the watchdog.
    """

    def __init__(self, interval=10, timeout=5, max_misses=3, now=0):
        if interval <= 0 or timeout <= 0 or timeout >= interval:
            raise ValueError('need 0 < timeout < interval')
        if max_misses < 1:
            raise ValueError('max_misses must be at least 1')
        self.interval = interval
        self.timeout = timeout
        self.max_misses = max_misses
        self.misses = 0
        self._last_ping = now    # when the most recent PING went out
        self._waiting = False    # that PING has not been answered yet

    def ping_due(self, now):
        """Time to send the next PING?"""
        return now - self._last_ping >= self.interval

    def sent(self, now):
        """A PING has just gone out; start waiting for its PONG."""
        self._last_ping = now
        self._waiting = True

    def pong(self):
        """A good PONG arrived: forget any earlier misses."""
        self.misses = 0
        self._waiting = False

    def pong_overdue(self, now):
        """True exactly once per PING whose PONG never came in time."""
        if self._waiting and now - self._last_ping >= self.timeout:
            self._waiting = False
            return True
        return False

    def missed(self):
        """Record a missed PONG. True if the connection should now be dropped."""
        self.misses += 1
        return self.misses >= self.max_misses
