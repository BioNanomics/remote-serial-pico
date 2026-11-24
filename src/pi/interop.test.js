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

// --- authentication and the firmware hash --------------------------------------
// The same idea for Phase D: the board and the Pi each compute the handshake
// proof, the session keys and every frame tag independently. If they differ
// by one bit, no board can ever register.

const crypto = require('node:crypto');
const A = require('./auth.js');
const { firmwareHash } = require('./runtime.js');

const AUTH_HELPER = path.join(__dirname, '..', '..', 'tools', 'auth_roundtrip.py');
const PICO_SRC = path.join(__dirname, '..', 'pico');
const rnd = (n) => crypto.randomBytes(n);
const AUTH_VECTORS = [
    { key: Buffer.from(Array.from({ length: 32 }, (_, i) => i)), ns: Buffer.alloc(32, 0x53), np: Buffer.alloc(32, 0x50), id: 'e6614103e71d2c2f', counter: 0, opcode: OPCODE.REGISTER_ACK, body: Buffer.from('{"ok":true}') },
    { key: rnd(32), ns: rnd(32), np: rnd(32), id: 'e66164084319422c', counter: 1, opcode: OPCODE.DATA, body: Buffer.from('#255.102.255.B=UP\r') },
    { key: rnd(32), ns: rnd(32), np: rnd(32), id: '0000000000000000', counter: 255, opcode: OPCODE.PING, body: Buffer.alloc(0) },
    { key: rnd(32), ns: rnd(32), np: rnd(32), id: 'ffffffffffffffff', counter: 256, opcode: OPCODE.DATA, body: Buffer.from(Array.from({ length: 256 }, (_, i) => i)) },
    { key: rnd(32), ns: rnd(32), np: rnd(32), id: 'e6614103e71d2c2f', counter: 2 ** 40 + 7, opcode: OPCODE.DATA, body: Buffer.alloc(MAX_PAYLOAD - A.TAG_LEN, 0x5a) },
];

function authAgrees(interpreter, t) {
    const input = AUTH_VECTORS.map(v =>
        [v.key.toString('hex'), v.ns.toString('hex'), v.np.toString('hex'), v.id, v.counter, v.opcode, v.body.length ? v.body.toString('hex') : '-'].join(' ')
    ).join('\n') + '\n';
    let out;
    try {
        out = execFileSync(interpreter, [AUTH_HELPER], { input, encoding: 'utf8' });
    } catch (err) {
        if (err.code === 'ENOENT') { t.skip(`${interpreter} not installed`); return; }
        throw err;
    }
    const lines = out.trim().split('\n');
    assert.strictEqual(lines.length, AUTH_VECTORS.length + 1, out);
    AUTH_VECTORS.forEach((v, i) => {
        const keys = A.sessionKeys(v.key, v.ns, v.np, v.id);
        const tagger = new A.Tagger(keys.picoToPi);
        tagger.counter = BigInt(v.counter);
        const expected = [
            A.picoProof(v.key, v.ns, v.np, v.id), keys.picoToPi, keys.piToPico,
            A.frameTag(keys.picoToPi, v.counter, v.opcode, v.body), tagger.seal(v.opcode, v.body),
        ].map(b => b.toString('hex')).join(' ');
        assert.strictEqual(lines[i], expected, `auth vector ${i} disagrees between Pi and Pico under ${interpreter}`);
    });
    assert.strictEqual(lines.at(-1), firmwareHash(PICO_SRC), `firmware hash disagrees between Pi and Pico under ${interpreter}`);
    assert.match(lines.at(-1), /^[0-9a-f]{16}$/);
}

test('Pi and Pico agree on the handshake proof, session keys, frame tags and firmware hash (CPython)', (t) => authAgrees('python3', t));
test('Pi and Pico agree on the handshake proof, session keys, frame tags and firmware hash (MicroPython)', (t) => authAgrees('micropython', t));
