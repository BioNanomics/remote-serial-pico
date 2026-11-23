"""Interop helper for src/pi/interop.test.js. Not used at runtime.

Reads one hex-encoded frame per line on stdin, decodes it with the Pico's
codec, re-encodes it, and writes the result back as hex. If the Pi and Pico
codecs agree, output hex == input hex for every line. Runs under CPython and
under the MicroPython Unix port (no f-strings, no bytes.fromhex reliance).
"""
import sys

# MicroPython has no os.path, so derive src/pico from this file's own path by
# hand. __file__ is 'tools/frame_roundtrip.py' or an absolute equivalent.
_here = __file__.rsplit('/', 1)[0] if '/' in __file__ else '.'
sys.path.insert(0, _here + '/../src/pico')
import frame  # noqa: E402


def unhex(s):
    return bytes(int(s[i:i + 2], 16) for i in range(0, len(s), 2))


def hexlify(b):
    return ''.join('%02x' % x for x in b)


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    frames, remainder, errors = frame.decode(unhex(line))
    if len(frames) != 1 or remainder:
        print('ERR frames=%d remainder=%d errors=%s' % (len(frames), len(remainder), errors))
        continue
    f = frames[0]
    print(hexlify(frame.encode(f.opcode, f.seq, f.payload)))
