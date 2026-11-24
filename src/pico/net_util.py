"""Pure logic pulled out of main.py so it can be unit-tested on a desktop
Python interpreter, with no MicroPython, no hardware, no network.

MicroPython-safe: stdlib only, no f-strings in hot loops here (none needed),
no type hints. Imports frame.py and auth.py; the deployer copies every file
named in firmware.json.
"""
import auth
import frame


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


def file_hash_prefix(path, length=16, chunk=512):
    """First `length` hex characters of SHA-256 over a file, or 'unknown'.

    Goes into REGISTER as `hash`, so the Pi can tell which main.py a board is
    actually running and Phase F can compare it with the canonical file. Read
    in small chunks: main.py is bigger than any buffer worth holding whole on
    a board with 264 KB of RAM.
    """
    try:
        import hashlib
        import binascii
        h = hashlib.sha256()
        with open(path, 'rb') as fh:
            while True:
                block = fh.read(chunk)
                if not block:
                    break
                h.update(block)
        return binascii.hexlify(h.digest()).decode()[:length]
    except Exception:
        return 'unknown'


FIRMWARE_MANIFEST = 'firmware.json'


def firmware_hash(directory='', length=16, chunk=512):
    """First `length` hex characters of SHA-256 over the whole firmware, or
    'unknown'.

    Goes into REGISTER as `hash`. It covers firmware.json and every file it
    lists, in that order, each as: name, a zero byte, the contents, a zero
    byte. main.py imports the others, so a hash of main.py alone could not see
    a change in net_util.py, frame.py or auth.py. The Pi computes the same
    value over its own copy (src/pi/runtime.js firmwareHash) and compares.
    Read in small chunks: no file is held whole in a Pico's 264 KB of RAM.
    """
    try:
        import hashlib
        import binascii
        import json
        prefix = directory + '/' if directory else ''
        with open(prefix + FIRMWARE_MANIFEST) as fh:
            names = [FIRMWARE_MANIFEST] + list(json.load(fh)['files'])
        h = hashlib.sha256()
        for name in names:
            h.update(name.encode())
            h.update(b'\x00')
            with open(prefix + name, 'rb') as fh:
                while True:
                    block = fh.read(chunk)
                    if not block:
                        break
                    h.update(block)
            h.update(b'\x00')
        return binascii.hexlify(h.digest()).decode()[:length]
    except Exception:
        return 'unknown'


class RegistrationRefused(OSError):
    """The Pi refused this board. Retrying quickly will not help."""


def _random_bytes(n):
    import os
    return os.urandom(n)


class PicoLink:
    """The Pico's side of wire protocol v1 (docs/protocol.md). No I/O.

    main.py owns the socket. It asks this class for the bytes to send
    (register_frame, ping_frame, data_frames) and feeds it whatever the
    socket returns; receive() answers with a list of (kind, value) events:

      ('registered', name)      authenticated REGISTER_ACK ok=true; DATA may flow now
      ('refused', reason)       the Pi will not have us; it will close
      ('data', bytes)           payload of a DATA frame, for the UART
      ('pong', None)            the server answered our PING
      ('send', bytes)           a protocol reply to put on the socket
      ('error', (code, msg))    the server reported an ERROR
      ('ignored', opcode)       a later-phase opcode this firmware skips
      ('close', reason)         give up on this connection

    Only 'data' events ever reach the UART: that is the data path rule.

    Authentication (spec, "Authentication"): the Pi answers REGISTER with a
    nonce, we answer with our own nonce and a proof that we hold the device
    key, and from then on every frame in both directions carries a tag. The
    Pi's first tagged frame, REGISTER_ACK, is what proves the Pi holds the key
    too. A frame whose tag is wrong ends the connection.
    """

    def __init__(self, pico_id, fw, fw_hash, key=None, rand=None):
        self.pico_id = pico_id
        self.fw = fw
        self.fw_hash = fw_hash
        self.key = key              # bytes, the per-device secret; None if never provisioned
        self._rand = rand or _random_bytes
        self.registered = False
        self.name = None
        self.server_time = None
        self._decoder = frame.Decoder()
        self._seq = frame.Sequencer()
        self._tx = None             # auth.Tagger, once the handshake has keys
        self._rx = None

    @property
    def resyncs(self):
        return self._decoder.resyncs

    # --- frames to send -----------------------------------------------------

    def _frame(self, opcode, payload=b''):
        if self._tx is not None:
            payload = self._tx.seal(opcode, payload)
        return frame.encode(opcode, self._seq.next(), payload)

    def _json(self, opcode, obj):
        import json
        return self._frame(opcode, json.dumps(obj).encode())

    def register_frame(self):
        """The first frame on every connection."""
        return self._json(frame.OP_REGISTER,
                          {'id': self.pico_id, 'fw': self.fw, 'hash': self.fw_hash})

    def ping_frame(self):
        return self._frame(frame.OP_PING)

    def error_frame(self, code, msg):
        return self._json(frame.OP_ERROR, {'code': code, 'msg': msg})

    def data_frames(self, data):
        """UART bytes as DATA frames, split so none exceeds MAX_PAYLOAD once
        its tag is added.

        Empty until registered: the spec forbids DATA before REGISTER_ACK.
        main.py leaves the bytes in the UART buffer until then.
        """
        if not self.registered or not data:
            return []
        out = []
        step = frame.MAX_PAYLOAD - auth.TAG_LEN
        for i in range(0, len(data), step):
            out.append(self._frame(frame.OP_DATA, data[i:i + step]))
        return out

    # --- bytes received -----------------------------------------------------

    def receive(self, chunk):
        events = []
        before = self._decoder.version_errors
        frames = self._decoder.feed(chunk)
        if self._decoder.version_errors > before:
            events.append(('send', self.error_frame(
                frame.ERR_VERSION, 'only protocol version %d is supported' % frame.VERSION)))
            events.append(('close', 'server sent an unsupported protocol version'))
            return events
        for f in frames:
            if self._handle(f, events):
                break
        return events

    def _handle(self, f, events):
        """Handle one frame. True means stop: the connection is finished."""
        op = f.opcode
        if not self.registered:
            return self._handshake(op, f.payload, events)

        # Registered: every frame must carry the next tag, whatever it is.
        body = self._rx.open(op, f.payload)
        if body is None:
            events.append(('close', 'frame failed authentication'))
            return True
        if op == frame.OP_DATA:
            events.append(('data', body))
        elif op == frame.OP_PONG:
            events.append(('pong', None))
        elif op == frame.OP_PING:
            events.append(('send', self._frame(frame.OP_PONG)))
        elif op == frame.OP_ERROR:
            err = frame.decode_json(body) or {}
            events.append(('error', (err.get('code'), err.get('msg'))))
        elif op in frame.KNOWN_OPCODES:
            # Assigned to a later phase (control, update), or a handshake
            # opcode out of place: nothing to do, and not an error.
            events.append(('ignored', op))
        else:
            events.append(('send', self.error_frame(
                frame.ERR_UNKNOWN_OPCODE, 'unknown opcode 0x%02x' % op)))
        return False

    def _handshake(self, op, payload, events):
        if op == frame.OP_AUTH_CHALLENGE:
            if self._tx is not None:
                events.append(('close', 'second AUTH_CHALLENGE on one connection'))
                return True
            if self.key is None:
                events.append(('refused', 'this board has no device key; plug it into the Pi to provision it'))
                return True
            if len(payload) != auth.NONCE_LEN:
                events.append(('close', 'malformed AUTH_CHALLENGE'))
                return True
            server_nonce = bytes(payload)
            pico_nonce = self._rand(auth.NONCE_LEN)
            proof = auth.pico_proof(self.key, server_nonce, pico_nonce, self.pico_id)
            # The response itself goes out untagged; everything after it is tagged.
            events.append(('send', self._frame(frame.OP_AUTH_RESPONSE, pico_nonce + proof)))
            to_pi, to_pico = auth.session_keys(self.key, server_nonce, pico_nonce, self.pico_id)
            self._tx = auth.Tagger(to_pi)
            self._rx = auth.Tagger(to_pico)
        elif op == frame.OP_REGISTER_ACK:
            body = self._rx.open(op, payload) if self._rx is not None else None
            ack = frame.decode_json(body if body is not None else payload)
            if ack is None:
                events.append(('close', 'REGISTER_ACK is not JSON'))
                return True
            if not ack.get('ok'):
                # A refusal is believed with or without a tag: all it can do
                # is make this board wait, which anyone who can drop our
                # packets can do anyway.
                events.append(('refused', ack.get('reason', 'no reason given')))
                return True
            if body is None:
                # ok=true without a valid tag: whoever sent it does not hold
                # our key. Never register with it.
                events.append(('close', 'server did not prove it holds the device key'))
                return True
            self.registered = True
            self.name = ack.get('name')
            self.server_time = ack.get('time')
            events.append(('registered', self.name))
        elif op == frame.OP_ERROR:
            err = frame.decode_json(payload) or {}
            events.append(('error', (err.get('code'), err.get('msg'))))
        else:
            # DATA, PING, anything else: not before the handshake is done.
            # Dropped silently, so an impostor learns nothing from us.
            events.append(('ignored', op))
        return False
