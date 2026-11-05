const test = require('node:test');
const assert = require('node:assert');
const F = require('./frame.js');
const { PicoSession } = require('./session.js');

// A session wired to fakes. Everything the session sends is decoded back into
// frames so tests can assert on opcodes and JSON, not raw bytes.
function harness(overrides = {}) {
    const out = { sent: [], pty: [], log: [], closed: false, registered: [] };
    const outDecoder = new F.Decoder();
    const session = new PicoSession({
        send: (buf) => out.sent.push(...outDecoder.feed(buf)),
        close: () => { out.closed = true; },
        log: (level, msg) => out.log.push(`${level}: ${msg}`),
        register: (id, info) => { out.registered.push({ id, ...info }); return 'office-north'; },
        onData: (buf) => out.pty.push(buf),
        now: () => 1757980000,
        ...overrides,
    });
    return { session, out };
}

const REG = { id: 'e6614103e71d2c2f', fw: '1.4.0', hash: '3b0c44298fc1c149' };
const register = (session, seq = 0, reg = REG) => session.receive(F.encodeJson(F.OPCODE.REGISTER, seq, reg));
const lastJson = (out) => F.decodeJson(out.sent[out.sent.length - 1].payload);

test('valid REGISTER: logs id/fw/hash, calls register hook, acks with name and time', () => {
    const { session, out } = harness();
    register(session);
    assert.ok(session.registered);
    assert.deepStrictEqual(out.registered, [REG]);
    assert.strictEqual(out.sent[0].opcode, F.OPCODE.REGISTER_ACK);
    assert.deepStrictEqual(lastJson(out), { ok: true, name: 'office-north', time: 1757980000 });
    assert.match(out.log[0], /office-north registered: serial e6614103e71d2c2f, firmware 1\.4\.0, hash 3b0c44298fc1c149/);
    assert.strictEqual(out.closed, false);
});

test('REGISTER with uppercase id is normalised; missing fw/hash become "unknown"', () => {
    const { session, out } = harness();
    register(session, 0, { id: 'E6614103E71D2C2F' });
    assert.deepStrictEqual(out.registered, [{ id: 'e6614103e71d2c2f', fw: 'unknown', hash: 'unknown' }]);
});

test('malformed REGISTER is refused and the connection closed', () => {
    for (const payload of ['not json', '{"id":"short"}', '{"id":123}', '[]', '']) {
        const { session, out } = harness();
        session.receive(F.encode(F.OPCODE.REGISTER, 0, payload));
        assert.ok(!session.registered, payload);
        assert.deepStrictEqual(lastJson(out), { ok: false, reason: 'malformed registration' }, payload);
        assert.strictEqual(out.closed, true, payload);
        assert.strictEqual(out.registered.length, 0, payload);
    }
});

test('a second REGISTER on the same connection is ignored', () => {
    const { session, out } = harness();
    register(session);
    register(session, 1, { ...REG, id: 'ffffffffffffffff' });
    assert.strictEqual(out.registered.length, 1);
    assert.match(out.log.at(-1), /second REGISTER/);
});

test('PING is answered with PONG, before or after registration', () => {
    const { session, out } = harness();
    session.receive(F.encode(F.OPCODE.PING, 0));
    assert.strictEqual(out.sent[0].opcode, F.OPCODE.PONG);
    register(session, 1);
    session.receive(F.encode(F.OPCODE.PING, 2));
    assert.strictEqual(out.sent.at(-1).opcode, F.OPCODE.PONG);
    assert.strictEqual(session.stats.pings, 2);
});

test('DATA after registration reaches the pty byte for byte, terminator included', () => {
    const { session, out } = harness();
    register(session);
    const raw = Buffer.from('MECHO_50\r\n');
    session.receive(F.encode(F.OPCODE.DATA, 1, raw));
    assert.deepStrictEqual(out.pty, [raw]);
});

test('DATA before registration is dropped with ERROR 4 and never reaches the pty', () => {
    const { session, out } = harness();
    session.receive(F.encode(F.OPCODE.DATA, 0, 'sneaky'));
    assert.deepStrictEqual(out.pty, []);
    assert.strictEqual(out.sent[0].opcode, F.OPCODE.ERROR);
    assert.strictEqual(lastJson(out).code, F.ERR.NOT_REGISTERED);
    assert.strictEqual(session.stats.dropped, 1);
});

test('data-path rule: no non-DATA opcode ever reaches the pty', () => {
    const { session, out } = harness();
    register(session);
    for (const op of Object.values(F.OPCODE)) {
        if (op === F.OPCODE.DATA || op === F.OPCODE.REGISTER) continue;
        session.receive(F.encode(op, 5, '#255.102.255.A=UP'));
    }
    session.receive(F.encode(0x7f, 6, 'unknown opcode payload'));
    assert.deepStrictEqual(out.pty, []);
});

test('unknown opcode gets ERROR 2; known-but-unimplemented opcode is only logged', () => {
    const { session, out } = harness();
    register(session);
    session.receive(F.encode(0x7f, 1));
    assert.strictEqual(out.sent.at(-1).opcode, F.OPCODE.ERROR);
    assert.strictEqual(lastJson(out).code, F.ERR.UNKNOWN_OPCODE);
    const sentBefore = out.sent.length;
    session.receive(F.encode(F.OPCODE.CONTROL_RESPONSE, 2, '{}'));
    assert.strictEqual(out.sent.length, sentBefore);
    assert.match(out.log.at(-1), /CONTROL_RESPONSE.*not implement/);
});

test('ERROR from the board is logged, not echoed', () => {
    const { session, out } = harness();
    register(session);
    const sentBefore = out.sent.length;
    session.receive(F.encodeJson(F.OPCODE.ERROR, 1, { code: 3, msg: 'bad payload' }));
    assert.strictEqual(out.sent.length, sentBefore);
    assert.match(out.log.at(-1), /reports error 3: bad payload/);
});

test('unsupported protocol version: ERROR 1 and close', () => {
    const { session, out } = harness();
    const v2 = Buffer.from(F.encode(F.OPCODE.PING, 0));
    v2[1] = 2;
    v2.writeUInt16BE(F.crc16(v2.subarray(1, v2.length - 2)), v2.length - 2);
    session.receive(v2);
    assert.strictEqual(out.sent[0].opcode, F.OPCODE.ERROR);
    assert.strictEqual(lastJson(out).code, F.ERR.VERSION);
    assert.strictEqual(out.closed, true);
});

test('corrupt bytes between frames are logged as a resync and the good frame still handled', () => {
    const { session, out } = harness();
    register(session);
    session.receive(Buffer.concat([Buffer.from('zzz'), F.encode(F.OPCODE.PING, 1)]));
    assert.match(out.log.at(-1), /resynchronised 1 time/);
    assert.strictEqual(out.sent.at(-1).opcode, F.OPCODE.PONG);
});

test('frames split across socket reads are reassembled', () => {
    const { session, out } = harness();
    const fr = F.encodeJson(F.OPCODE.REGISTER, 0, REG);
    for (let i = 0; i < fr.length; i += 3) session.receive(fr.subarray(i, i + 3));
    assert.ok(session.registered);
    assert.deepStrictEqual(lastJson(out).name, 'office-north');
});

test('outgoing frames carry an incrementing sequence number', () => {
    const { session, out } = harness();
    register(session);
    session.sendData(Buffer.from('#255.102.255.A=UP\r'));
    session.receive(F.encode(F.OPCODE.PING, 1));
    assert.deepStrictEqual(out.sent.map(f => f.seq), [0, 1, 2]);
    assert.deepStrictEqual(out.sent.map(f => f.opcode), [F.OPCODE.REGISTER_ACK, F.OPCODE.DATA, F.OPCODE.PONG]);
});

test('sendData chunks a large pty write into MAX_PAYLOAD frames', () => {
    const { session, out } = harness();
    register(session);
    session.sendData(Buffer.alloc(F.MAX_PAYLOAD * 2 + 5, 0x41));
    const data = out.sent.filter(f => f.opcode === F.OPCODE.DATA);
    assert.deepStrictEqual(data.map(f => f.payload.length), [F.MAX_PAYLOAD, F.MAX_PAYLOAD, 5]);
    assert.strictEqual(session.stats.dataOut, 3);
});

test('nothing is sent after close', () => {
    const { session, out } = harness();
    session.close();
    session.sendData(Buffer.from('x'));
    session.receive(F.encode(F.OPCODE.PING, 0));
    assert.deepStrictEqual(out.sent, []);
});
