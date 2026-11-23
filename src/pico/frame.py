"""Wire protocol v1 codec for MicroPython. The contract is docs/protocol.md.

Must stay importable on a Pico W: stdlib only, no type hints, no f-strings.
Mirrors src/pi/frame.js byte for byte; src/pi/interop.test.js proves it.
"""
import json

MAGIC = 0x7E
VERSION = 1
HEADER_LEN = 7          # MAGIC VER OPCODE SEQ(2) LEN(2)
CRC_LEN = 2
MAX_PAYLOAD = 1024
MAX_FRAME = HEADER_LEN + MAX_PAYLOAD + CRC_LEN
MAX_SEQ = 0xFFFF

# Opcodes. Every one the project will need, assigned now (see the spec).
OP_REGISTER = 0x01
OP_REGISTER_ACK = 0x02
OP_PING = 0x03
OP_PONG = 0x04
OP_ERROR = 0x05
OP_DATA = 0x10
OP_AUTH_CHALLENGE = 0x20
OP_AUTH_RESPONSE = 0x21
OP_CONTROL_REQUEST = 0x30
OP_CONTROL_RESPONSE = 0x31
OP_UPDATE_OFFER = 0x40
OP_UPDATE_CHUNK = 0x41
OP_UPDATE_RESULT = 0x42

KNOWN_OPCODES = frozenset((
    OP_REGISTER, OP_REGISTER_ACK, OP_PING, OP_PONG, OP_ERROR, OP_DATA,
    OP_AUTH_CHALLENGE, OP_AUTH_RESPONSE,
    OP_CONTROL_REQUEST, OP_CONTROL_RESPONSE,
    OP_UPDATE_OFFER, OP_UPDATE_CHUNK, OP_UPDATE_RESULT,
))

# ERROR payload codes.
ERR_VERSION = 1
ERR_UNKNOWN_OPCODE = 2
ERR_BAD_PAYLOAD = 3
ERR_NOT_REGISTERED = 4
ERR_REFUSED = 5


def crc16(data):
    """CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final XOR."""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return crc


def encode(opcode, seq, payload=b''):
    """Build one frame. Returns bytes ready for the socket."""
    if not 0 <= opcode <= 0xFF:
        raise ValueError('opcode must be a byte')
    if not 0 <= seq <= MAX_SEQ:
        raise ValueError('seq out of range')
    n = len(payload)
    if n > MAX_PAYLOAD:
        raise ValueError('payload exceeds MAX_PAYLOAD')

    frame = bytearray(HEADER_LEN + n + CRC_LEN)
    frame[0] = MAGIC
    frame[1] = VERSION
    frame[2] = opcode
    frame[3] = (seq >> 8) & 0xFF
    frame[4] = seq & 0xFF
    frame[5] = (n >> 8) & 0xFF
    frame[6] = n & 0xFF
    frame[HEADER_LEN:HEADER_LEN + n] = payload
    # CRC covers VER through the end of PAYLOAD. MAGIC is constant.
    crc = crc16(frame[1:HEADER_LEN + n])
    frame[HEADER_LEN + n] = (crc >> 8) & 0xFF
    frame[HEADER_LEN + n + 1] = crc & 0xFF
    return bytes(frame)


def encode_json(opcode, seq, obj):
    """Frame whose payload is a UTF-8 JSON object (REGISTER, ERROR, ...)."""
    return encode(opcode, seq, json.dumps(obj).encode('utf-8'))


def decode_json(payload):
    """Parse a JSON payload. Returns None, never raises, if it is not a JSON object."""
    try:
        obj = json.loads(payload.decode('utf-8'))
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


class Frame:
    """One decoded frame. Plain attributes, no behaviour."""
    __slots__ = ('version', 'opcode', 'seq', 'payload')

    def __init__(self, version, opcode, seq, payload):
        self.version = version
        self.opcode = opcode
        self.seq = seq
        self.payload = payload

    def __eq__(self, other):
        return (isinstance(other, Frame) and self.version == other.version
                and self.opcode == other.opcode and self.seq == other.seq
                and self.payload == other.payload)

    def __repr__(self):
        return 'Frame(v=%d op=0x%02x seq=%d len=%d)' % (
            self.version, self.opcode, self.seq, len(self.payload))


def decode(buf):
    """Pull every complete frame out of buf.

    Returns (frames, remainder, errors). remainder MUST be prepended to the
    next chunk read from the socket: TCP splits and coalesces freely. errors
    is a list of (kind, detail) tuples, one per resynchronisation:
      ('desync', n)     n bytes skipped to reach the next MAGIC
      ('length', n)     header claimed n > MAX_PAYLOAD, this MAGIC was data
      ('crc', n)        CRC mismatch, received value n
      ('version', v)    well-formed frame with unsupported version v
    A version error is the only one where the whole frame is consumed; the
    caller should answer it with ERROR code 1 and close.
    """
    frames = []
    errors = []
    offset = 0
    end = len(buf)

    while offset < end:
        if buf[offset] != MAGIC:
            nxt = buf.find(b'\x7e', offset + 1)
            if nxt == -1:
                # Nothing left that could start a frame: all noise.
                errors.append(('desync', end - offset))
                return frames, b'', errors
            errors.append(('desync', nxt - offset))
            offset = nxt
            continue

        if end - offset < HEADER_LEN:
            break  # header still arriving

        version = buf[offset + 1]
        opcode = buf[offset + 2]
        seq = (buf[offset + 3] << 8) | buf[offset + 4]
        length = (buf[offset + 5] << 8) | buf[offset + 6]

        if length > MAX_PAYLOAD:
            # No sender ever produces this, so this MAGIC was payload data.
            errors.append(('length', length))
            offset += 1
            continue

        total = HEADER_LEN + length + CRC_LEN
        if end - offset < total:
            break  # frame still arriving

        expected = crc16(buf[offset + 1:offset + HEADER_LEN + length])
        actual = (buf[offset + HEADER_LEN + length] << 8) | buf[offset + HEADER_LEN + length + 1]
        if expected != actual:
            errors.append(('crc', actual))
            offset += 1
            continue

        if version != VERSION:
            errors.append(('version', version))
            offset += total
            continue

        frames.append(Frame(version, opcode, seq,
                            bytes(buf[offset + HEADER_LEN:offset + HEADER_LEN + length])))
        offset += total

    return frames, bytes(buf[offset:]), errors


class Decoder:
    """Stateful wrapper around decode() for one TCP connection.

    Keeps the unconsumed tail between reads and counts resyncs, which Phase
    E's status command reports.
    """

    def __init__(self):
        self._tail = b''
        self.resyncs = 0
        self.version_errors = 0

    def feed(self, chunk):
        """Add bytes from the socket; return the complete frames now available."""
        frames, self._tail, errors = decode(self._tail + chunk)
        for kind, _ in errors:
            if kind == 'version':
                self.version_errors += 1
            else:
                self.resyncs += 1
        if len(self._tail) > MAX_FRAME:
            # Cannot happen with a MAGIC-led tail (it would have been decoded
            # or rejected), so this is noise: drop it.
            self.resyncs += 1
            self._tail = b''
        return frames

    @property
    def pending(self):
        """Bytes held back because they might be the start of a frame."""
        return len(self._tail)


class Sequencer:
    """Per-direction counter that wraps at MAX_SEQ, as the spec requires."""

    def __init__(self):
        self._seq = 0

    def next(self):
        current = self._seq
        self._seq = (self._seq + 1) & MAX_SEQ
        return current
