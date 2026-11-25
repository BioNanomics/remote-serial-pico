const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const F = require('./frame.js');
const A = require('./auth.js');
const { PicoSession } = require('./session.js');

const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const SERVER_NONCE = Buffer.alloc(32, 0x53);
const PICO_NONCE = Buffer.alloc(32, 0x50);
const REG = { id: 'e6614103e71d2c2f', fw: '1.1.0', hash: '3b0c44298fc1c149' };

// A session wired to fakes. Everything the session sends is decoded back into
// frames so tests can assert on opcodes and JSON, not raw bytes.
function harness(overrides = {}, options = {}) {
    const out = { sent: [], pty: [], log: [], closed: false, registered: [] };
    const outDecoder = new F.Decoder();
    const session = new PicoSession({
        send: (buf) => out.sent.push(...outDecoder.feed(buf)),
        close: () => { out.closed = true; },
        log: (level, msg) => out.log.push(`${level}: ${msg}`),
        secretFor: (id) => (id === REG.id ? KEY : null),
        register: (id, info) => { out.registered.push({ id, ...info }); return 'office-north'; },
        onData: (buf) => out.pty.push(buf),
        now: () => 1757980000,
        randomBytes: () => SERVER_NONCE,
        ...overrides,
    }, options);
    return { session, out };
}

// The board's half of the conversation, built from auth.js's own functions.
class FakePico {
    constructor(session, out, { key = KEY, reg = REG } = {}) {
        Object.assign(this, { session, out, key, reg, seq: 0, tx: null, rx: null });
    }
    raw(opcode, payload = Buffer.alloc(0)) { this.session.receive(F.encode(opcode, this.seq++, payload)); }
    send(opcode, body = Buffer.alloc(0)) { this.raw(opcode, this.tx.seal(opcode, Buffer.from(body))); }
    register() { this.raw(F.OPCODE.REGISTER, Buffer.from(JSON.stringify(this.reg))); }
    respond(proofKey = this.key) {
        const id = this.reg.id.toLowerCase();
        this.raw(F.OPCODE.AUTH_RESPONSE, Buffer.concat([PICO_NONCE, A.picoProof(proofKey, SERVER_NONCE, PICO_NONCE, id)]));
        const keys = A.sessionKeys(this.key, SERVER_NONCE, PICO_NONCE, id);
        this.tx = new A.Tagger(keys.picoToPi);
        this.rx = new A.Tagger(keys.piToPico);
    }
    // Open the n-th frame the session sent (they must be opened in order).
    open(frame) {
        const body = this.rx.open(frame.opcode, frame.payload);
        assert.ok(body !== null, `frame 0x${frame.opcode.toString(16)} from the server failed authentication`);
        return body;
    }
}

function registered(overrides, options) {
    const { session, out } = harness(overrides, options);
    const pico = new FakePico(session, out);
    pico.register();
    pico.respond();
    assert.ok(session.registered, out.log.join('\n'));
    pico.open(out.sent[1]);          // the REGISTER_ACK, to keep the counter in step
    return { session, out, pico };
}

const json = (frame) => F.decodeJson(frame.payload);

// --- the handshake ------------------------------------------------------------

test('REGISTER alone gets a challenge and nothing else: no pty, no name, no serial-map entry', () => {
    const { session, out } = harness();
    new FakePico(session, out).register();
    assert.deepStrictEqual(out.sent.map(f => f.opcode), [F.OPCODE.AUTH_CHALLENGE]);
    assert.deepStrictEqual(out.sent[0].payload, SERVER_NONCE);
    assert.strictEqual(session.registered, false);
    assert.deepStrictEqual(out.registered, [], 'the register hook allocates the pty; it must wait for proof');
});

test('the challenge nonce is fresh for every connection', () => {
    const nonces = new Set();
    for (let i = 0; i < 20; i++) {
        const { session, out } = harness({ randomBytes: undefined });
        new FakePico(session, out).register();
        assert.strictEqual(out.sent[0].payload.length, 32);
        nonces.add(out.sent[0].payload.toString('hex'));
    }
    assert.strictEqual(nonces.size, 20);
});

test('a board holding the key registers; the ack is tagged, which is the Pi proving it holds the key too', () => {
    const { session, out } = harness();
    const pico = new FakePico(session, out);
    pico.register();
    pico.respond();
    assert.ok(session.registered);
    assert.deepStrictEqual(out.registered, [REG]);
    assert.strictEqual(out.sent[1].opcode, F.OPCODE.REGISTER_ACK);
    assert.strictEqual(F.decodeJson(out.sent[1].payload), null, 'the ack is not readable as plain JSON: it carries a tag');
    assert.deepStrictEqual(JSON.parse(pico.open(out.sent[1])), { ok: true, name: 'office-north', time: 1757980000 });
    assert.match(out.log.at(-1), /office-north registered: serial e6614103e71d2c2f, firmware 1\.1\.0, hash 3b0c44298fc1c149, authenticated/);
    assert.strictEqual(out.closed, false);
});

test('registration without the device secret is rejected and logged', () => {
    const { session, out } = harness();
    const pico = new FakePico(session, out);
    pico.register();
    pico.respond(crypto.randomBytes(32));                 // a guess at the key
    assert.strictEqual(session.registered, false);
    assert.deepStrictEqual(out.registered, []);
    assert.deepStrictEqual(json(out.sent.at(-1)), { ok: false, reason: 'authentication failed' });
    assert.strictEqual(out.closed, true);
    assert.match(out.log.at(-1), /warn: refusing e6614103e71d2c2f: it does not hold the device key/);
});

test('a serial id this Pi never provisioned is refused before any challenge', () => {
    const { session, out } = harness();
    new FakePico(session, out, { reg: { ...REG, id: 'ffffffffffffffff' } }).register();
    assert.deepStrictEqual(out.sent.map(f => f.opcode), [F.OPCODE.REGISTER_ACK]);
    assert.deepStrictEqual(json(out.sent[0]), { ok: false, reason: 'unknown device' });
    assert.strictEqual(out.closed, true);
    assert.deepStrictEqual(out.registered, []);
    assert.match(out.log.at(-1), /no device key on record/);
});

test('knowing a serial id is not enough: the old takeover no longer works', () => {
    // Issue #19's opening problem: any host could send a board's id and be
    // handed its pty. Ids are in USB descriptors, logs and symlink names.
    const { session, out } = harness();
    const attacker = new FakePico(session, out);
    attacker.register();
    for (const guess of [Buffer.alloc(64), Buffer.alloc(0), Buffer.concat([PICO_NONCE, Buffer.from(REG.id.repeat(2))])]) {
        if (out.closed) break;
        attacker.raw(F.OPCODE.AUTH_RESPONSE, guess);
    }
    attacker.raw(F.OPCODE.DATA, Buffer.from('255.19.255.QY=FE\r'));
    assert.deepStrictEqual(out.registered, []);
    assert.deepStrictEqual(out.pty, []);
    assert.strictEqual(out.closed, true);
});

test('a captured handshake cannot be replayed: the next connection has a new challenge', () => {
    const first = harness();
    const pico = new FakePico(first.session, first.out);
    pico.register();
    const recorded = Buffer.concat([PICO_NONCE, A.picoProof(KEY, SERVER_NONCE, PICO_NONCE, REG.id)]);
    first.session.receive(F.encode(F.OPCODE.AUTH_RESPONSE, 1, recorded));
    assert.ok(first.session.registered, 'the genuine response works once');

    const second = harness({ randomBytes: () => Buffer.alloc(32, 0x54) });
    second.session.receive(F.encodeJson(F.OPCODE.REGISTER, 0, REG));
    second.session.receive(F.encode(F.OPCODE.AUTH_RESPONSE, 1, recorded));
    assert.strictEqual(second.session.registered, false);
    assert.deepStrictEqual(json(second.out.sent.at(-1)), { ok: false, reason: 'authentication failed' });
});

test('REGISTER with uppercase id is normalised; missing fw/hash become "unknown"', () => {
    const { session, out } = harness();
    const pico = new FakePico(session, out, { reg: { id: 'E6614103E71D2C2F' } });
    pico.register();
    pico.respond();
    assert.deepStrictEqual(out.registered, [{ id: 'e6614103e71d2c2f', fw: 'unknown', hash: 'unknown' }]);
});

test('malformed REGISTER is refused and the connection closed', () => {
    for (const payload of ['not json', '{"id":"short"}', '{"id":123}', '[]', '']) {
        const { session, out } = harness();
        session.receive(F.encode(F.OPCODE.REGISTER, 0, payload));
        assert.ok(!session.registered, payload);
        assert.deepStrictEqual(json(out.sent.at(-1)), { ok: false, reason: 'malformed registration' }, payload);
        assert.strictEqual(out.closed, true, payload);
        assert.strictEqual(out.registered.length, 0, payload);
    }
});

test('a second REGISTER, or a response nobody asked for, changes nothing', () => {
    const { session, out } = harness();
    session.receive(F.encode(F.OPCODE.AUTH_RESPONSE, 0, Buffer.alloc(64)));
    assert.strictEqual(json(out.sent.at(-1)).code, F.ERR.NOT_REGISTERED);
    const pico = new FakePico(session, out);
    pico.seq = 1;
    pico.register();
    session.receive(F.encodeJson(F.OPCODE.REGISTER, 2, { ...REG, id: 'ffffffffffffffff' }));
    assert.match(out.log.at(-1), /second REGISTER/);
    pico.seq = 3;
    pico.respond();
    assert.deepStrictEqual(out.registered, [REG], 'the id that was challenged is the id that registers');
});

test('what a board says about itself cannot forge a log line', () => {
    const { session, out } = harness();
    const pico = new FakePico(session, out, { reg: { ...REG, fw: '1.0\nwarn: office-south registered', hash: 'x'.repeat(500) } });
    pico.register();
    pico.respond();
    for (const line of out.log) assert.ok(!line.includes('\n'), line);
    assert.ok(out.log.at(-1).length < 300);
});

// --- firmware identity (Phase B) -----------------------------------------------

test('an authenticated board running other firmware is refused, with the fix in the log', () => {
    const { session, out } = harness({}, { firmwareHash: 'aaaaaaaaaaaaaaaa' });
    const pico = new FakePico(session, out);
    pico.register();
    pico.respond();
    assert.strictEqual(session.registered, false);
    assert.deepStrictEqual(out.registered, []);
    assert.deepStrictEqual(JSON.parse(pico.open(out.sent.at(-1))), { ok: false, reason: 'firmware mismatch' });
    assert.strictEqual(out.closed, true);
    assert.match(out.log.at(-1), /runs firmware 1\.1\.0 \(hash 3b0c44298fc1c149\) but this Pi deploys hash aaaaaaaaaaaaaaaa\. Plug the board into this Pi/);
});

test('FirmwareMismatch: warn serves the board and says so; a matching hash is silent', () => {
    let r = registered({}, { firmwareHash: 'aaaaaaaaaaaaaaaa', firmwareMismatch: 'warn' });
    assert.ok(r.out.log.some(l => /^warn: e6614103e71d2c2f runs firmware 1\.1\.0 .* not the hash aaaaaaaaaaaaaaaa/.test(l)));
    r = registered({}, { firmwareHash: REG.hash });
    assert.ok(!r.out.log.some(l => l.startsWith('warn')));
});

test('an unauthenticated peer cannot use a firmware mismatch to learn anything or be refused for it', () => {
    const { session, out } = harness({}, { firmwareHash: 'aaaaaaaaaaaaaaaa' });
    new FakePico(session, out).register();
    assert.deepStrictEqual(out.sent.map(f => f.opcode), [F.OPCODE.AUTH_CHALLENGE], 'firmware is judged only after authentication');
});

// --- firmware update at registration (Phase F) -----------------------------------------

const BUNDLE = {
    hash: 'bbbbbbbbbbbbbbbb',
    files: [
        { name: 'firmware.json', data: Buffer.from('{"files": ["main.py"]}'), sha256: 'f'.repeat(64) },
        { name: 'main.py', data: Buffer.alloc(1300, 0x41), sha256: 'e'.repeat(64) },
    ],
};

function updating(overrides = {}, options = {}) {
    const events = [];
    const h = harness({
        offerUpdate: (id, info) => { events.push(['offer', id, info]); return BUNDLE; },
        updateFinished: (id, ok, detail) => events.push(['finished', id, ok, detail]),
        ...overrides,
    }, { firmwareHash: BUNDLE.hash, ...options });
    const pico = new FakePico(h.session, h.out);
    pico.register();
    pico.respond();
    return { ...h, pico, events };
}

test('a board on other firmware is sent the update before it is registered: no pty, no serial data', () => {
    const { session, out, pico, events } = updating();
    assert.deepStrictEqual(events, [['offer', REG.id, { fw: REG.fw, hash: REG.hash }]]);
    assert.strictEqual(session.registered, false);
    assert.deepStrictEqual(out.registered, [], 'updates happen before any serial data can be relayed');
    session.sendData(Buffer.from('#255.19.255.B=UP\r'));
    assert.ok(out.sent.every(f => f.opcode !== F.OPCODE.DATA), 'a command for the device is not sent into an update');

    const frames = out.sent.slice(1).map(f => ({ opcode: f.opcode, body: pico.open(f) }));   // every one is tagged
    assert.deepStrictEqual(frames.map(f => f.opcode), [
        F.OPCODE.UPDATE_OFFER, F.OPCODE.UPDATE_CHUNK,
        F.OPCODE.UPDATE_OFFER, F.OPCODE.UPDATE_CHUNK, F.OPCODE.UPDATE_CHUNK, F.OPCODE.UPDATE_CHUNK,
        F.OPCODE.UPDATE_OFFER,
    ]);
    assert.deepStrictEqual(JSON.parse(frames[0].body), { name: 'firmware.json', len: 22, sha256: 'f'.repeat(64) });
    assert.deepStrictEqual(JSON.parse(frames[2].body), { name: 'main.py', len: 1300, sha256: 'e'.repeat(64) });
    assert.deepStrictEqual(frames.slice(3, 6).map(f => [f.body.readUInt32BE(0), f.body.length - 4]), [[0, 512], [512, 512], [1024, 276]]);
    assert.deepStrictEqual(JSON.parse(frames[6].body), { commit: true, hash: BUNDLE.hash, files: ['firmware.json', 'main.py'] });
    assert.ok(out.log.some(l => /firmware update: e6614103e71d2c2f runs 1\.1\.0 \(hash 3b0c44298fc1c149\); sending hash bbbbbbbbbbbbbbbb, 2 files, 1322 bytes/.test(l)));
});

test('the board accepting the update is logged with old and new versions, and the connection ends', () => {
    const { session, out, pico, events } = updating();
    out.sent.slice(1).forEach(f => pico.open(f));
    pico.send(F.OPCODE.UPDATE_RESULT, JSON.stringify({ ok: true, msg: 'verified; restarting', hash: BUNDLE.hash }));
    assert.match(out.log.at(-1), /info: firmware update: e6614103e71d2c2f verified and installed it: 1\.1\.0 \(hash 3b0c44298fc1c149\) -> hash bbbbbbbbbbbbbbbb\. The board is restarting/);
    assert.deepStrictEqual(events.at(-1), ['finished', REG.id, true, { from: REG.hash, to: BUNDLE.hash }]);
    assert.strictEqual(out.closed, true);
    assert.deepStrictEqual(out.registered, []);
    assert.strictEqual(session.updating, null);
});

test('a rejected update is logged, the board keeps its firmware, and the mismatch policy applies', () => {
    let r = updating();
    r.out.sent.slice(1).forEach(f => r.pico.open(f));
    r.pico.send(F.OPCODE.UPDATE_RESULT, JSON.stringify({ ok: false, msg: 'main.py: sha256 does not match' }));
    assert.ok(r.out.log.some(l => /error: firmware update: e6614103e71d2c2f did NOT take the update \(main\.py: sha256 does not match\); it keeps running hash 3b0c44298fc1c149/.test(l)));
    assert.deepStrictEqual(r.events.at(-1), ['finished', REG.id, false, 'main.py: sha256 does not match']);
    assert.deepStrictEqual(JSON.parse(r.pico.open(r.out.sent.at(-1))), { ok: false, reason: 'firmware mismatch' });
    assert.strictEqual(r.out.closed, true);

    r = updating({}, { firmwareMismatch: 'warn' });
    r.out.sent.slice(1).forEach(f => r.pico.open(f));
    r.pico.send(F.OPCODE.UPDATE_RESULT, JSON.stringify({ ok: false, msg: 'flash full' }));
    assert.ok(r.session.registered, 'with warn, a board that could not update is still served on what it has');
    assert.deepStrictEqual(r.out.registered, [REG]);
});

test('a board that claims success with the wrong hash has not been updated', () => {
    const { out, pico, events } = updating();
    out.sent.slice(1).forEach(f => pico.open(f));
    pico.send(F.OPCODE.UPDATE_RESULT, JSON.stringify({ ok: true, msg: 'ok', hash: 'cccccccccccccccc' }));
    assert.strictEqual(events.at(-1)[2], false);
    assert.ok(out.log.some(l => /did NOT take the update \(the board reports hash cccccccccccccccc, not bbbbbbbbbbbbbbbb\)/.test(l)));
});

test('an update that gets no answer, or loses its connection, is finished as failed', async () => {
    let r = updating({}, { updateTimeoutMs: 20 });
    await new Promise((res) => setTimeout(res, 60));
    assert.strictEqual(r.events.at(-1)[2], false);
    assert.match(r.events.at(-1)[3], /no answer from the board within 0\.02 s/);
    assert.strictEqual(r.session.updating, null);

    r = updating();
    r.session.connectionLost();
    assert.deepStrictEqual(r.events.at(-1), ['finished', REG.id, false, 'the connection was lost during the update']);
    r.session.connectionLost();
    assert.strictEqual(r.events.filter(e => e[0] === 'finished').length, 1, 'reported once');
});

test('no update is offered to a board that already runs this firmware, or when the server declines', () => {
    let asked = 0;
    let r = registered({ offerUpdate: () => { asked++; return BUNDLE; } }, { firmwareHash: REG.hash });
    assert.strictEqual(asked, 0);
    assert.ok(r.out.sent.every(f => f.opcode !== F.OPCODE.UPDATE_OFFER));

    const h = harness({ offerUpdate: () => null }, { firmwareHash: BUNDLE.hash });      // updates off, or another board is in progress
    const pico = new FakePico(h.session, h.out);
    pico.register();
    pico.respond();
    assert.deepStrictEqual(JSON.parse(pico.open(h.out.sent.at(-1))), { ok: false, reason: 'firmware mismatch' });
});

test('nothing about an update is sent to a peer that has not authenticated', () => {
    let asked = 0;
    const { session, out } = harness({ offerUpdate: () => { asked++; return BUNDLE; } }, { firmwareHash: BUNDLE.hash });
    const attacker = new FakePico(session, out);
    attacker.register();
    attacker.respond(crypto.randomBytes(32));
    assert.strictEqual(asked, 0);
    assert.ok(out.sent.every(f => f.opcode !== F.OPCODE.UPDATE_OFFER && f.opcode !== F.OPCODE.UPDATE_CHUNK));
});

test('an UPDATE_RESULT with no update in flight is ignored', () => {
    const { out, pico } = registered();
    pico.send(F.OPCODE.UPDATE_RESULT, JSON.stringify({ ok: true, hash: 'x' }));
    assert.match(out.log.at(-1), /UPDATE_RESULT.*does not act on/);
    assert.strictEqual(out.closed, false);
});

// --- after the handshake: every frame is authenticated ----------------------------

test('DATA after registration reaches the pty byte for byte, terminator included', () => {
    const { out, pico } = registered();
    const raw = Buffer.from('MECHO_50\r\n');
    pico.send(F.OPCODE.DATA, raw);
    assert.deepStrictEqual(out.pty, [raw]);
});

test('nothing reaches the pty before authentication, and nothing is sent to an unregistered board', () => {
    const { session, out } = harness();
    session.receive(F.encode(F.OPCODE.DATA, 0, 'sneaky'));
    session.receive(F.encode(F.OPCODE.PING, 1));
    assert.deepStrictEqual(out.pty, []);
    assert.deepStrictEqual(out.sent.map(f => f.opcode), [F.OPCODE.ERROR, F.OPCODE.ERROR]);
    assert.strictEqual(json(out.sent[0]).code, F.ERR.NOT_REGISTERED);
    assert.strictEqual(session.stats.dropped, 2);
    session.sendData(Buffer.from('#255.102.255.A=UP\r'));
    assert.strictEqual(out.sent.length, 2, 'a command for the device must not go to an unauthenticated peer');
});

test('a forged frame is rejected, never reaches the pty, and ends the connection', () => {
    for (const forged of [Buffer.from('255.19.255.QY=FE\r'), Buffer.concat([Buffer.from('255.19.255.QY=FE\r'), Buffer.alloc(16)])]) {
        const { out, pico } = registered();
        pico.raw(F.OPCODE.DATA, forged);
        assert.deepStrictEqual(out.pty, []);
        assert.strictEqual(out.closed, true);
        assert.match(out.log.at(-1), /error: office-north sent a frame that failed authentication/);
    }
});

test('a replayed capture of a valid frame is rejected', () => {
    const { session, out, pico } = registered();
    const frame = F.encode(F.OPCODE.DATA, pico.seq++, pico.tx.seal(F.OPCODE.DATA, Buffer.from('255.19.255.QY=FE\r')));
    session.receive(frame);
    assert.strictEqual(out.pty.length, 1);
    session.receive(frame);
    assert.strictEqual(out.pty.length, 1, 'the same bytes a second time are not data');
    assert.strictEqual(out.closed, true);
});

test('an altered frame is rejected even with a corrected CRC', () => {
    const { session, out, pico } = registered();
    const frame = Buffer.from(F.encode(F.OPCODE.DATA, pico.seq++, pico.tx.seal(F.OPCODE.DATA, Buffer.from('255.19.255.QY=FE\r'))));
    frame[F.HEADER_LEN + 3] ^= 0x01;
    frame.writeUInt16BE(F.crc16(frame.subarray(1, frame.length - 2)), frame.length - 2);
    session.receive(frame);
    assert.deepStrictEqual(out.pty, []);
    assert.strictEqual(out.closed, true);
});

test('a frame from one direction cannot be reflected back as the other', () => {
    const { session, out } = registered();
    session.sendData(Buffer.from('#255.102.255.A=UP\r'));
    const ours = out.sent.at(-1);
    session.receive(F.encode(F.OPCODE.DATA, 9, ours.payload));
    assert.deepStrictEqual(out.pty, []);
    assert.strictEqual(out.closed, true);
});

test('PING is answered with a tagged PONG once registered', () => {
    const { session, out, pico } = registered();
    pico.send(F.OPCODE.PING);
    assert.strictEqual(out.sent.at(-1).opcode, F.OPCODE.PONG);
    assert.strictEqual(pico.open(out.sent.at(-1)).length, 0);
    assert.strictEqual(session.stats.pings, 1);
});

test('data-path rule: no non-DATA opcode ever reaches the pty', () => {
    const { out, pico } = registered();
    for (const op of Object.values(F.OPCODE)) {
        if (op === F.OPCODE.DATA) continue;
        pico.send(op, '#255.102.255.A=UP');
    }
    pico.send(0x7f, 'unknown opcode payload');
    assert.deepStrictEqual(out.pty, []);
    assert.strictEqual(out.closed, false);
});

test('unknown opcode gets ERROR 2; known-but-unimplemented opcode is only logged', () => {
    const { out, pico } = registered();
    pico.send(0x7f);
    assert.strictEqual(out.sent.at(-1).opcode, F.OPCODE.ERROR);
    assert.strictEqual(JSON.parse(pico.open(out.sent.at(-1))).code, F.ERR.UNKNOWN_OPCODE);
    const sentBefore = out.sent.length;
    pico.send(F.OPCODE.UPDATE_RESULT, '{}');
    assert.strictEqual(out.sent.length, sentBefore);
    assert.match(out.log.at(-1), /UPDATE_RESULT.*does not act on/);
});

// --- control channel (Phase E) ------------------------------------------------------

test('a control command goes out as a tagged CONTROL_REQUEST and resolves with the board\'s answer', async () => {
    const { session, out, pico } = registered();
    const pending = session.control('uart_set', { baud: 9600, save: false });
    const req = out.sent.at(-1);
    assert.strictEqual(req.opcode, F.OPCODE.CONTROL_REQUEST);
    const body = JSON.parse(pico.open(req));
    assert.deepStrictEqual(body, { id: 1, cmd: 'uart_set', args: { baud: 9600, save: false } });
    pico.send(F.OPCODE.CONTROL_RESPONSE, JSON.stringify({ id: 1, ok: true, result: { uart: '9600 8N1', saved: false } }));
    assert.deepStrictEqual(await pending, { ok: true, result: { uart: '9600 8N1', saved: false } });
});

test('control traffic never appears in the pty stream, in either direction', async () => {
    const { session, out, pico } = registered();
    const pending = session.control('status');
    pico.send(F.OPCODE.CONTROL_RESPONSE, JSON.stringify({ id: 1, ok: true, result: { fw: '#255.19.255.B=UP' } }));
    await pending;
    assert.deepStrictEqual(out.pty, [], 'a response is not device data');
    assert.ok(out.sent.every(f => f.opcode !== F.OPCODE.DATA), 'a request is not sent as device data');
});

test('answers are matched to requests by id; a failure carries the board\'s reason', async () => {
    const { session, pico } = registered();
    const a = session.control('status'), b = session.control('uart_set', { baud: 1 });
    pico.send(F.OPCODE.CONTROL_RESPONSE, JSON.stringify({ id: 2, ok: false, error: 'baud must be between 300 and 921600' }));
    pico.send(F.OPCODE.CONTROL_RESPONSE, JSON.stringify({ id: 1, ok: true, result: { fw: '1.2.0' } }));
    assert.deepStrictEqual(await a, { ok: true, result: { fw: '1.2.0' } });
    assert.deepStrictEqual(await b, { ok: false, error: 'baud must be between 300 and 921600' });
});

test('a board that never answers, or drops, fails the command instead of hanging it', async () => {
    let r = registered();
    assert.deepStrictEqual(await r.session.control('status', {}, 20), { ok: false, error: 'no answer from the board within 0.02 s' });
    r = registered();
    const pending = r.session.control('reboot');
    r.session.connectionLost();
    assert.deepStrictEqual(await pending, { ok: false, error: 'the board disconnected before answering' });
    const { session } = harness();
    assert.deepStrictEqual(await session.control('reboot'), { ok: false, error: 'board is not connected' });
});

test('a control response nobody asked for, or a forged one, resolves nothing', async () => {
    const { session, out, pico } = registered();
    pico.send(F.OPCODE.CONTROL_RESPONSE, JSON.stringify({ id: 99, ok: true, result: {} }));
    assert.match(out.log.at(-1), /CONTROL_RESPONSE nobody is waiting for/);
    const pending = session.control('status', {}, 30);
    pico.raw(F.OPCODE.CONTROL_RESPONSE, Buffer.from(JSON.stringify({ id: 1, ok: true, result: { fw: 'forged' } })));
    assert.strictEqual(out.closed, true, 'an untagged response ends the connection');
    assert.strictEqual((await pending).ok, false);
});

test('ERROR from the board is logged, not echoed', () => {
    const { out, pico } = registered();
    const sentBefore = out.sent.length;
    pico.send(F.OPCODE.ERROR, JSON.stringify({ code: 3, msg: 'bad payload' }));
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
    assert.strictEqual(json(out.sent[0]).code, F.ERR.VERSION);
    assert.strictEqual(out.closed, true);
});

test('a v0 board (unframed "pico_<id>") gets nothing: there is no legacy mode', () => {
    const { session, out } = harness();
    session.receive(Buffer.from('pico_e6614103e71d2c2f'));
    session.receive(Buffer.from('PING'));
    assert.deepStrictEqual(out.sent, []);
    assert.deepStrictEqual(out.registered, []);
    assert.deepStrictEqual(out.pty, []);
});

test('corrupt bytes between frames are logged as a resync and the good frame still handled', () => {
    const { session, out, pico } = registered();
    session.receive(Buffer.concat([Buffer.from('zzz'), F.encode(F.OPCODE.PING, pico.seq++, pico.tx.seal(F.OPCODE.PING, Buffer.alloc(0)))]));
    assert.ok(out.log.some(l => /resynchronised 1 time/.test(l)));
    assert.strictEqual(out.sent.at(-1).opcode, F.OPCODE.PONG);
});

test('frames split across socket reads are reassembled', () => {
    const { session, out } = harness();
    const fr = F.encodeJson(F.OPCODE.REGISTER, 0, REG);
    for (let i = 0; i < fr.length; i += 3) session.receive(fr.subarray(i, i + 3));
    assert.strictEqual(out.sent[0].opcode, F.OPCODE.AUTH_CHALLENGE);
});

test('outgoing frames carry an incrementing sequence number', () => {
    const { session, out, pico } = registered();
    session.sendData(Buffer.from('#255.102.255.A=UP\r'));
    pico.send(F.OPCODE.PING);
    assert.deepStrictEqual(out.sent.map(f => f.seq), [0, 1, 2, 3]);
    assert.deepStrictEqual(out.sent.map(f => f.opcode), [F.OPCODE.AUTH_CHALLENGE, F.OPCODE.REGISTER_ACK, F.OPCODE.DATA, F.OPCODE.PONG]);
    assert.deepStrictEqual(pico.open(out.sent[2]), Buffer.from('#255.102.255.A=UP\r'));
});

test('sendData chunks a large pty write so each frame still fits with its tag', () => {
    const { session, out, pico } = registered();
    const step = F.MAX_PAYLOAD - A.TAG_LEN;
    session.sendData(Buffer.alloc(step * 2 + 5, 0x41));
    const data = out.sent.filter(f => f.opcode === F.OPCODE.DATA);
    assert.deepStrictEqual(data.map(f => f.payload.length), [F.MAX_PAYLOAD, F.MAX_PAYLOAD, 5 + A.TAG_LEN]);
    assert.strictEqual(Buffer.concat(data.map(f => pico.open(f))).length, step * 2 + 5);
    assert.strictEqual(session.stats.dataOut, 3);
});

test('nothing is sent after close', () => {
    const { session, out } = registered();
    const before = out.sent.length;
    session.close();
    session.sendData(Buffer.from('x'));
    session.receive(F.encode(F.OPCODE.PING, 0));
    assert.strictEqual(out.sent.length, before);
});
