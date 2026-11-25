const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ControlServer, COMMANDS } = require('./control.js');
const ctl = require('./ctl.js');

// Short on purpose: a Unix socket path may be at most ~100 bytes.
function sockPath() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-')), 'c.sock'); }

// A stand-in for a registered PicoSession: records what it is asked.
function fakeSession(answer = (cmd, args) => ({ ok: true, result: { cmd, args } })) {
    const s = { registered: true, asked: [] };
    s.control = (cmd, args, timeoutMs) => { s.asked.push({ cmd, args, timeoutMs }); return Promise.resolve(answer(cmd, args)); };
    return s;
}

async function server(t, sessions) {
    const log = [];
    const socketPath = sockPath();
    const srv = new ControlServer({
        socketPath,
        sessionFor: (name) => sessions[name] || null,
        names: () => Object.keys(sessions),
        log: (level, msg) => log.push(`${level}: ${msg}`),
    });
    await new Promise((r) => srv.start(r));
    t.after(() => srv.stop());
    return { srv, socketPath, log };
}

async function runCtl(words, socketPath) {
    const out = [], err = [];
    const code = await ctl.run(ctl.parseCtl(words), socketPath, (s) => out.push(s), (s) => err.push(s));
    return { code, out: out.join('\n'), err: err.join('\n') };
}

// --- the command line -----------------------------------------------------------

test('ctl parses each command the issue names into a request for the server', () => {
    assert.deepStrictEqual(ctl.parseCtl(['Blinds_pico', 'reboot']), { pico: 'Blinds_pico', cmd: 'reboot', args: {} });
    assert.deepStrictEqual(ctl.parseCtl(['Blinds_pico', 'status']), { pico: 'Blinds_pico', cmd: 'status', args: {} });
    assert.deepStrictEqual(ctl.parseCtl(['Blinds_pico', 'identify']), { pico: 'Blinds_pico', cmd: 'identify', args: {} });
    assert.deepStrictEqual(ctl.parseCtl(['Blinds_pico', 'identify', '30']).args, { seconds: 30 });
    assert.deepStrictEqual(ctl.parseCtl(['Blinds_pico', 'listen']).cmd, 'listen');
    assert.deepStrictEqual(ctl.parseCtl(['Blinds_pico', 'uart', 'set', '9600']), { pico: 'Blinds_pico', cmd: 'uart_set', args: { baud: 9600, save: false } });
    assert.deepStrictEqual(ctl.parseCtl(['Blinds_pico', 'uart', 'set', '9600', '7', 'e', '2', '--save']).args,
        { baud: 9600, save: true, bits: 7, parity: 'E', stop: 2 });
});

test('uart changes are session-only unless --save is typed', () => {
    assert.strictEqual(ctl.parseCtl(['B', 'uart', 'set', '9600']).args.save, false);
    assert.strictEqual(ctl.parseCtl(['B', 'uart', 'set', '--save', '9600']).args.save, true);
});

test('ctl rejects what it cannot understand before bothering the server', () => {
    for (const words of [[], ['B'], ['B', 'bogus'], ['B', 'reboot', 'now'], ['B', 'uart', 'set'], ['B', 'uart', 'get'],
        ['B', 'uart', 'set', 'fast'], ['B', 'identify', 'x'], ['--save', 'reboot'], ['B', 'status', '--save']]) {
        assert.ok(ctl.parseCtl(words).error, JSON.stringify(words));
    }
    for (const w of ['reboot', 'status', 'identify', 'uart set', 'listen', '--save']) assert.ok(ctl.USAGE.includes(w), w);
});

// --- the control socket -----------------------------------------------------------

test('a command reaches the named board and its answer comes back', async (t) => {
    const blinds = fakeSession(() => ({ ok: true, result: { fw: '1.2.0', uptime_s: 61, rssi: null, uart: '19200 8N1' } }));
    const { socketPath, log } = await server(t, { Blinds_pico: blinds, Lights_pico: fakeSession() });
    const r = await runCtl(['Blinds_pico', 'status'], socketPath);
    assert.strictEqual(r.code, 0, r.err);
    assert.deepStrictEqual(blinds.asked.map(a => a.cmd), ['status']);
    assert.match(r.out, /firmware +1\.2\.0/);
    assert.match(r.out, /serial link +19200 8N1/);
    assert.match(r.out, /WiFi signal \(dBm\) +unknown/);
    assert.ok(log.some(l => /^info: control: status \{\} for "Blinds_pico" => ok /.test(l)), log.join('\n'));
});

test('uart set forwards the settings and the save flag; the board\'s refusal is shown and exits 1', async (t) => {
    const board = fakeSession((cmd, args) => (args.baud < 300 ? { ok: false, error: 'baud must be between 300 and 921600' } : { ok: true, result: { uart: '9600 8N1', saved: args.save } }));
    const { socketPath, log } = await server(t, { B: board });
    let r = await runCtl(['B', 'uart', 'set', '9600', '--save'], socketPath);
    assert.strictEqual(r.code, 0);
    assert.deepStrictEqual(board.asked[0], { cmd: 'uart_set', args: { baud: 9600, save: true }, timeoutMs: COMMANDS.uart_set.timeoutMs });
    r = await runCtl(['B', 'uart', 'set', '5'], socketPath);
    assert.strictEqual(r.code, 1);
    assert.match(r.err, /B: baud must be between 300 and 921600/);
    assert.ok(log.some(l => /^warn: control: uart_set .* => FAILED: baud must be/.test(l)));
});

test('every control command and its result is logged, including refused ones', async (t) => {
    const { socketPath, log } = await server(t, { B: fakeSession() });
    await runCtl(['B', 'reboot'], socketPath);
    await runCtl(['B', 'identify', '5'], socketPath);
    await runCtl(['Nobody', 'reboot'], socketPath);
    assert.ok(log.some(l => /control: reboot \{\} for "B" => ok/.test(l)));
    assert.ok(log.some(l => /control: identify \{"seconds":5\} for "B" => ok/.test(l)));
    assert.ok(log.some(l => /^warn: control: reboot \{\} for "Nobody" => refused: not connected/.test(l)));
});

test('a board that is not connected is an error that names the ones that are', async (t) => {
    const { socketPath } = await server(t, { Blinds_pico: fakeSession(), Gone: { registered: false } });
    let r = await runCtl(['Lights_pico', 'reboot'], socketPath);
    assert.strictEqual(r.code, 1);
    assert.match(r.err, /Lights_pico: Lights_pico is not connected\. Connected now: Blinds_pico, Gone/);
    r = await runCtl(['Gone', 'reboot'], socketPath);
    assert.strictEqual(r.code, 1, 'a session that has not finished registering cannot be controlled');
});

test('only the commands on the list are forwarded to a board', async (t) => {
    const board = fakeSession();
    const { socketPath } = await server(t, { B: board });
    const out = [], err = [];
    for (const cmd of ['update', 'rotate-key', 'exec', '__proto__', 'constructor']) {
        const code = await ctl.run({ pico: 'B', cmd, args: {} }, socketPath, (s) => out.push(s), (s) => err.push(s));
        assert.strictEqual(code, 1, cmd);
    }
    assert.deepStrictEqual(board.asked, []);
    assert.match(err[0], /unknown command: update/);
});

test('garbage on the socket gets an error, not a crash', async (t) => {
    const { socketPath } = await server(t, { B: fakeSession() });
    const net = require('node:net');
    const ask = (text) => new Promise((resolve) => {
        const c = net.createConnection(socketPath, () => c.write(text));
        let got = ''; c.setEncoding('utf8'); c.on('data', (d) => { got += d; }); c.on('close', () => resolve(got)); c.on('error', () => resolve(got));
    });
    assert.match(await ask('not json\n'), /malformed request/);
    assert.match(await ask('{"pico": 5, "cmd": "status"}\n'), /malformed request/);
    assert.match(await ask('x'.repeat(5000)), /request too long/);
    const r = await runCtl(['B', 'status'], socketPath);
    assert.strictEqual(r.code, 0, 'the server still works afterwards');
});

test('the socket is for the service group only', async (t) => {
    const { socketPath } = await server(t, {});
    assert.strictEqual(fs.statSync(socketPath).mode & 0o777, 0o660);
});

test('listen streams serial traffic both ways as hex without altering it, and stops with the client', async (t) => {
    const { srv, socketPath, log } = await server(t, { B: fakeSession(), Other: fakeSession() });
    const lines = [];
    const done = ctl.run(ctl.parseCtl(['B', 'listen']), socketPath, (s) => lines.push(s), () => {});
    await new Promise((r) => { const iv = setInterval(() => { if (lines.length) { clearInterval(iv); r(); } }, 5); });
    const toDevice = Buffer.from('#255.19.255.B=UP\r'), fromDevice = Buffer.from([0x32, 0x35, 0x35, 0xff, 0x00, 0x7e]);
    srv.tap('B', 'to-device', toDevice);
    srv.tap('Other', 'to-device', Buffer.from('not for this listener'));
    srv.tap('B', 'from-device', fromDevice);
    await new Promise((r) => { const iv = setInterval(() => { if (lines.length >= 3) { clearInterval(iv); r(); } }, 5); });
    assert.match(lines[0], /listening to B/);
    assert.deepStrictEqual(lines.slice(1), [`> ${toDevice.toString('hex')}`, `< ${fromDevice.toString('hex')}`]);
    assert.strictEqual(toDevice.toString(), '#255.19.255.B=UP\r', 'the relay buffer itself is untouched');
    srv.stop();                                   // the server going away ends the stream
    assert.strictEqual(await done, 0);
    for (let i = 0; i < 200 && srv.listeners.has('B'); i++) await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(srv.listeners.has('B'), false, 'the listener is removed when its client goes');
    srv.tap('B', 'to-device', Buffer.from('later'));  // and tapping with nobody listening is harmless
    assert.ok(log.some(l => /listen for "B" ended/.test(l)));
});

test('ctl explains a missing or forbidden socket instead of printing a stack trace', async () => {
    const r = await runCtl(['B', 'status'], path.join(os.tmpdir(), 'rc-does-not-exist.sock'));
    assert.strictEqual(r.code, 1);
    assert.match(r.err, /is ptyserver\.service running\?/);
});
