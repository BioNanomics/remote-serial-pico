"""Device authentication for wire protocol v1. The contract is docs/protocol.md,
"Authentication". Mirrors src/pi/auth.js; src/pi/interop.test.js proves the two
agree byte for byte.

Must stay importable on a Pico W: stdlib only, no type hints, no f-strings.
MicroPython has hashlib.sha256 but no hmac module, so HMAC is spelled out here.
"""
import hashlib

KEY_LEN = 32      # the per-device secret, 256 bits
NONCE_LEN = 32
TAG_LEN = 16      # bytes of HMAC-SHA256 appended to every frame after the handshake
_BLOCK = 64       # SHA-256 block size

LABEL_PICO_PROOF = b'rsp1 pico proof'
LABEL_KEY_PICO_TO_PI = b'rsp1 key pico->pi'
LABEL_KEY_PI_TO_PICO = b'rsp1 key pi->pico'


def hmac_sha256(key, msg):
    if len(key) > _BLOCK:
        key = hashlib.sha256(key).digest()
    key = key + b'\x00' * (_BLOCK - len(key))
    inner = hashlib.sha256(bytes(b ^ 0x36 for b in key))
    inner.update(msg)
    outer = hashlib.sha256(bytes(b ^ 0x5C for b in key))
    outer.update(inner.digest())
    return outer.digest()


def equal(a, b):
    """Compare two byte strings without stopping at the first difference."""
    if len(a) != len(b):
        return False
    diff = 0
    for i in range(len(a)):
        diff |= a[i] ^ b[i]
    return diff == 0


def _transcript(label, server_nonce, pico_nonce, pico_id):
    return label + b'\x00' + server_nonce + pico_nonce + pico_id.encode()


def pico_proof(key, server_nonce, pico_nonce, pico_id):
    """What the Pico sends to show it holds the device key."""
    return hmac_sha256(key, _transcript(LABEL_PICO_PROOF, server_nonce, pico_nonce, pico_id))


def session_keys(key, server_nonce, pico_nonce, pico_id):
    """(pico->pi key, pi->pico key) for this one connection."""
    return (hmac_sha256(key, _transcript(LABEL_KEY_PICO_TO_PI, server_nonce, pico_nonce, pico_id)),
            hmac_sha256(key, _transcript(LABEL_KEY_PI_TO_PICO, server_nonce, pico_nonce, pico_id)))


def frame_tag(session_key, counter, opcode, body):
    """The tag for the counter-th authenticated frame in one direction.

    The 64-bit counter is never sent: both ends count. A replayed, dropped,
    reordered or altered frame therefore fails the check.
    """
    head = bytes(((counter >> 56) & 0xFF, (counter >> 48) & 0xFF, (counter >> 40) & 0xFF,
                  (counter >> 32) & 0xFF, (counter >> 24) & 0xFF, (counter >> 16) & 0xFF,
                  (counter >> 8) & 0xFF, counter & 0xFF, opcode & 0xFF))
    return hmac_sha256(session_key, head + body)[:TAG_LEN]


class Tagger:
    """One direction of an authenticated connection: appends or checks tags."""

    def __init__(self, session_key):
        self._key = session_key
        self.counter = 0

    def seal(self, opcode, body):
        tagged = bytes(body) + frame_tag(self._key, self.counter, opcode, bytes(body))
        self.counter += 1
        return tagged

    def open(self, opcode, payload):
        """The body if the tag is right, else None. The counter only advances
        on success, so one bad frame cannot desynchronise a good connection
        (the caller closes it anyway)."""
        if len(payload) < TAG_LEN:
            return None
        body = bytes(payload[:len(payload) - TAG_LEN])
        if not equal(frame_tag(self._key, self.counter, opcode, body), bytes(payload[len(payload) - TAG_LEN:])):
            return None
        self.counter += 1
        return body


def unhex(text):
    """Hex string to bytes, or None if it is not hex. bytes.fromhex is not on
    every MicroPython build."""
    try:
        if len(text) % 2:
            return None
        return bytes(int(text[i:i + 2], 16) for i in range(0, len(text), 2))
    except (ValueError, TypeError):
        return None
