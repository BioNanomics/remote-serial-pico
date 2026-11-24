"""Interop helper for src/pi/interop.test.js. Not used at runtime.

Reads one line per vector on stdin:

    <key hex> <server nonce hex> <pico nonce hex> <serial id> <counter> <opcode> <body hex or ->

and prints what the Pico's auth.py computes for it:

    <proof hex> <pico->pi key hex> <pi->pico key hex> <frame tag hex> <sealed body hex>

followed by one last line, the firmware hash of src/pico. If the Pi and Pico
implementations agree, every value equals what src/pi/auth.js and
runtime.js produce. Runs under CPython and the MicroPython Unix port.
"""
import sys

_here = __file__.rsplit('/', 1)[0] if '/' in __file__ else '.'
_pico = _here + '/../src/pico'
sys.path.insert(0, _pico)
import auth  # noqa: E402
import net_util  # noqa: E402


def hexlify(b):
    return ''.join('%02x' % x for x in b)


for line in sys.stdin:
    parts = line.split()
    if len(parts) != 7:
        continue
    key, ns, np_ = auth.unhex(parts[0]), auth.unhex(parts[1]), auth.unhex(parts[2])
    pico_id, counter, opcode = parts[3], int(parts[4]), int(parts[5])
    body = b'' if parts[6] == '-' else auth.unhex(parts[6])
    to_pi, to_pico = auth.session_keys(key, ns, np_, pico_id)
    tagger = auth.Tagger(to_pi)
    tagger.counter = counter
    print(hexlify(auth.pico_proof(key, ns, np_, pico_id)), hexlify(to_pi), hexlify(to_pico),
          hexlify(auth.frame_tag(to_pi, counter, opcode, body)), hexlify(tagger.seal(opcode, body)))

print(net_util.firmware_hash(_pico))
