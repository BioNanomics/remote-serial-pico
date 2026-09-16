// Cross-language interop: the Pi codec and the Pico codec must produce byte-
// identical frames. Two implementations of one protocol drift apart silently,
// and on a Pico the symptom is a board that just stops talking.
//
// Each vector is encoded here, handed to src/pico/frame.py to decode and
// re-encode, and compared. Equal hex means both agree on layout, byte order
// and CRC. Runs against CPython always, and against the MicroPython Unix
// port too when one is installed (brew install micropython).

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { OPCODE, MAX_PAYLOAD, MAX_SEQ, encode, encodeJson } = require('./frame.js');

const HELPER = path.join(__dirname, '..', '..', 'tools', 'frame_roundtrip.py');

const VECTORS = [
    { name: 'empty payload (PING)', opcode: OPCODE.PING, seq: 0, payload: Buffer.alloc(0) },
    { name: 'ascii payload', opcode: OPCODE.DATA, seq: 1, payload: Buffer.from('MECHO_50') },
    { name: 'mechonet command with CR', opcode: OPCODE.DATA, seq: 2, payload: Buffer.from('#255.102.255.A=UP\r') },
    { name: 'payload containing PING', opcode: OPCODE.DATA, seq: 3, payload: Buffer.from('AAPINGBB') },
    { name: 'payload containing MAGIC', opcode: OPCODE.DATA, seq: 4, payload: Buffer.from([0x7e, 0x00, 0x7e, 0x7e]) },
    { name: 'all byte values', opcode: OPCODE.DATA, seq: 5, payload: Buffer.from(Array.from({ length: 256 }, (_, i) => i)) },
    { name: 'max seq', opcode: OPCODE.DATA, seq: MAX_SEQ, payload: Buffer.from('x') },
    { name: 'max payload', opcode: OPCODE.DATA, seq: 6, payload: Buffer.alloc(MAX_PAYLOAD, 0x5a) },
    { name: 'error payload', opcode: OPCODE.ERROR, seq: 7, payload: Buffer.from('{"code":2,"msg":"unknown opcode"}') },
];
// JSON vectors are built by encodeJson so the JS serialiser's exact bytes are
// what the Python side has to reproduce after decode/re-encode.
const JSON_VECTORS = [
    { name: 'register', frame: encodeJson(OPCODE.REGISTER, 8, { id: 'e6614103e71d2c2f', fw: '1.4.0', hash: '3b0c44298fc1c149' }) },
    { name: 'register ack', frame: encodeJson(OPCODE.REGISTER_ACK, 9, { ok: true, name: 'office-north', time: 1757980000 }) },
];

function roundTrip(interpreter, t) {
    const inputs = [
        ...VECTORS.map(v => encode(v.opcode, v.seq, v.payload).toString('hex')),
        ...JSON_VECTORS.map(v => v.frame.toString('hex')),
    ];
    const names = [...VECTORS.map(v => v.name), ...JSON_VECTORS.map(v => v.name)];
    let out;
    try {
        out = execFileSync(interpreter, [HELPER], { input: inputs.join('\n') + '\n', encoding: 'utf8' });
    } catch (err) {
        if (err.code === 'ENOENT') { t.skip(`${interpreter} not installed`); return; }
        throw err;
    }
    const returned = out.trim().split('\n');
    assert.strictEqual(returned.length, inputs.length, `helper returned the wrong number of lines:\n${out}`);
    inputs.forEach((expected, i) => {
        assert.strictEqual(returned[i], expected, `vector "${names[i]}" disagrees between Pi and Pico under ${interpreter}`);
    });
}

test('Pi and Pico codecs agree byte for byte (CPython)', (t) => roundTrip('python3', t));
test('Pi and Pico codecs agree byte for byte (MicroPython)', (t) => roundTrip('micropython', t));
