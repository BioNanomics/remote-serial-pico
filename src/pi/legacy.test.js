const test = require('node:test');
const assert = require('node:assert');
const F = require('./frame.js');
const { PicoSession } = require('./session.js');
const { LegacySession, sessionFor } = require('./legacy.js');

function harness() {
    const out = { sent: [], pty: [], log: [], closed: false, registered: [] };
    const hooks = {
        send: (buf) => out.sent.push(Buffer.from(buf)),
        close: () => { out.closed = true; },
        log: (level, msg) => out.log.push(`${level}: ${msg}`),
        register: (id, info) => { out.registered.push({ id, ...info }); return 'office-north'; },
        onData: (buf) => out.pty.push(buf),
    };
    return { hooks, out };
}

const legacy = () => { const h = harness(); return { ...h, session: new LegacySession(h.hooks) }; };

test('sessionFor: MAGIC first byte means v1, anything else means v0 while legacy is accepted', () => {
    const { hooks } = harness();
    assert.ok(sessionFor(F.MAGIC, hooks) instanceof PicoSession);
    assert.strictEqual(sessionFor(F.MAGIC, hooks).protocol, 'v1');
    assert.ok(sessionFor('p'.charCodeAt(0), hooks) instanceof LegacySession);
    assert.strictEqual(sessionFor('p'.charCodeAt(0), hooks).protocol, 'v0');
});

test('sessionFor: with AcceptLegacyPicos off a v0 board gets no session, a v1 board still does', () => {
    const { hooks } = harness();
    assert.strictEqual(sessionFor('p'.charCodeAt(0), hooks, { acceptLegacy: false }), null);
    assert.ok(sessionFor(F.MAGIC, hooks, { acceptLegacy: false }) instanceof PicoSession);
});

test('v0 registration: pico_<id> registers with fw "v0" and a redeploy warning', () => {
    const { session, out } = legacy();
    session.receive(Buffer.from('pico_E6614103E71D2C2F'));
    assert.ok(session.registered);
    assert.deepStrictEqual(out.registered, [{ id: 'e6614103e71d2c2f', fw: 'v0', hash: 'unknown' }]);
    assert.match(out.log[0], /warn: office-north registered with v0 firmware/);
    assert.deepStrictEqual(out.pty, []);
    assert.deepStrictEqual(out.sent, []);
});

test('v0 registration coalesced with device data: only the token is the id, the rest reaches the pty', () => {
    const { session, out } = legacy();
    session.receive(Buffer.from('pico_e6614103e71d2c2fMECHO_50'));
    assert.strictEqual(out.registered[0].id, 'e6614103e71d2c2f');
    assert.deepStrictEqual(out.pty, [Buffer.from('MECHO_50\r')]);
});

test('v0 malformed registration is ignored', () => {
    const { session, out } = legacy();
    session.receive(Buffer.from('pico_short'));
    assert.ok(!session.registered);
    assert.deepStrictEqual(out.registered, []);
    assert.match(out.log[0], /malformed v0 registration/);
});

test('v0 heartbeat: every PING gets a PONG\\n and never reaches the pty', () => {
    const { session, out } = legacy();
    session.receive(Buffer.from('pico_e6614103e71d2c2f'));
    session.receive(Buffer.from('PING'));
    session.receive(Buffer.from('PINGPING'));
    assert.deepStrictEqual(out.sent, [Buffer.from('PONG\n'), Buffer.from('PONG\n'), Buffer.from('PONG\n')]);
    assert.deepStrictEqual(out.pty, []);
    assert.strictEqual(session.stats.pings, 3);
});

test('v0 device data reaches the pty trimmed with a trailing \\r, exactly as the v0 server wrote it', () => {
    const { session, out } = legacy();
    session.receive(Buffer.from('pico_e6614103e71d2c2f'));
    session.receive(Buffer.from('  #255.19.255.QY=FE  '));
    assert.deepStrictEqual(out.pty, [Buffer.from('#255.19.255.QY=FE\r')]);
});

test('v0 data before registration is dropped, not relayed to a pty that does not exist', () => {
    const { session, out } = legacy();
    session.receive(Buffer.from('MECHO_50'));
    assert.deepStrictEqual(out.pty, []);
    assert.strictEqual(session.stats.dropped, 1);
    assert.match(out.log[0], /unregistered/);
});

test('v0 pty bytes go to the board untouched', () => {
    const { session, out } = legacy();
    session.receive(Buffer.from('pico_e6614103e71d2c2f'));
    session.sendData(Buffer.from('#255.102.255.A=UP\r'));
    assert.deepStrictEqual(out.sent, [Buffer.from('#255.102.255.A=UP\r')]);
});

test('v0 close is idempotent and silences further sends', () => {
    const { session, out } = legacy();
    session.close();
    session.close();
    session.sendData(Buffer.from('x'));
    assert.strictEqual(out.closed, true);
    assert.deepStrictEqual(out.sent, []);
});

test('a v1 board through sessionFor behaves as PicoSession does', () => {
    const { hooks, out } = harness();
    const session = sessionFor(F.MAGIC, hooks);
    session.receive(F.encodeJson(F.OPCODE.REGISTER, 0, { id: 'e6614103e71d2c2f', fw: '1.0.0', hash: 'abc' }));
    assert.deepStrictEqual(out.registered, [{ id: 'e6614103e71d2c2f', fw: '1.0.0', hash: 'abc' }]);
    const [ack] = new F.Decoder().feed(Buffer.concat(out.sent));
    assert.strictEqual(ack.opcode, F.OPCODE.REGISTER_ACK);
});
