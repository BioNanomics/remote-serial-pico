// End-to-end: the real src/pico/main.py, run on this machine by
// tools/pico_sim/run_main.py with stand-ins for the Pico's hardware modules,
// talking wire protocol v1 to a PicoSession over a real TCP socket.
//
// This is the "desktop simulation" row of the implementation map in
// docs/protocol.md. It proves the firmware's framing, registration, relay and
// reconnect logic against the server code that will run on the Pi. It does
// not prove MicroPython's socket or select behaviour; only a board does that.
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const F = require('./frame.js');
const { PicoSession } = require('./session.js');

const PYTHON = process.env.PYTHON || 'python3';
const havePython = spawnSync(PYTHON, ['--version']).status === 0;
const skip = havePython ? false : `${PYTHON} not found`;

const ROOT = path.join(__dirname, '..', '..');
const RUNNER = path.join(ROOT, 'tools', 'pico_sim', 'run_main.py');
const MAIN_PY = path.join(ROOT, 'src', 'pico', 'main.py');
const ID = 'e6614103e71d2c2f';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, what, timeoutMs = 8000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const value = check();
        if (value) return value;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(20);
    }
}

// A PicoSession-backed server plus the simulated board, torn down together.
// `onConnection` may replace the default PicoSession wiring (used for the
// refusal test, where the server must misbehave on purpose).
async function bench(t, { env = {}, onConnection } = {}) {
    const state = { registrations: [], data: [], frames: [], sockets: [], stdout: [], exitCode: null };
    const server = net.createServer((socket) => {
        state.sockets.push(socket);
        const tap = new F.Decoder();
        socket.on('data', (buf) => state.frames.push(...tap.feed(buf)));
        socket.on('error', () => {});
        if (onConnection) return onConnection(socket, state);
        const session = new PicoSession({
            send: (buf) => { if (!socket.destroyed) socket.write(buf); },
            close: () => socket.end(),
            log: () => {},
            register: (id, info) => { state.registrations.push({ id, ...info }); return 'sim-board'; },
            onData: (payload) => state.data.push(payload),
        });
        socket.on('data', (buf) => session.receive(buf));
        state.session = session;
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const child = spawn(PYTHON, ['-u', RUNNER, '--host', '127.0.0.1', '--port', String(port), '--id', ID],
        { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let pending = '';
    child.stdout.on('data', (chunk) => {
        pending += chunk.toString();
        const lines = pending.split('\n');
        pending = lines.pop();
        state.stdout.push(...lines);
    });
    child.stderr.on('data', (chunk) => state.stdout.push(`stderr: ${chunk}`));
    child.on('exit', (code) => { state.exitCode = code; });

    t.after(() => {
        child.kill('SIGKILL');
        for (const s of state.sockets) s.destroy();
        server.close();
    });

    const uartRx = (buf) => child.stdin.write(`UART-RX ${buf.toString('hex')}\n`);
    const uartTx = () => state.stdout.filter((l) => l.startsWith('UART-TX ')).map((l) => Buffer.from(l.slice(8), 'hex'));
    const seen = (re) => state.stdout.some((l) => re.test(l));
    return { state, child, uartRx, uartTx, seen, port };
}

test('registers with its id, firmware version and the hash of the deployed main.py', { skip }, async (t) => {
    const b = await bench(t);
    await waitFor(() => b.state.registrations.length === 1, 'REGISTER');
    const reg = b.state.registrations[0];
    const fwInSource = fs.readFileSync(MAIN_PY, 'utf8').match(/^FIRMWARE_VERSION = '([^']+)'/m)[1];
    const hashOfSource = crypto.createHash('sha256').update(fs.readFileSync(MAIN_PY)).digest('hex').slice(0, 16);
    assert.deepStrictEqual(reg, { id: ID, fw: fwInSource, hash: hashOfSource });
    assert.strictEqual(b.state.frames[0].opcode, F.OPCODE.REGISTER, 'REGISTER is the first frame on the wire');
    assert.strictEqual(b.state.frames[0].seq, 0);
    await waitFor(() => b.seen(/Registered as 'sim-board'/), 'the board to log the ack');
    assert.strictEqual(b.state.exitCode, null, `board exited: ${b.state.stdout.join('\n')}`);
});

test('relays bytes both ways verbatim, including bytes that look like protocol', { skip }, async (t) => {
    const b = await bench(t);
    await waitFor(() => b.state.session && b.state.session.registered, 'registration');

    // Pi -> board: a command whose bytes include PING, MAGIC and invalid UTF-8.
    // Under v0 this was consumed as a heartbeat; now it reaches the UART intact.
    const toDevice = Buffer.from('PING\x7e\xff#255.102.255.A=UP\r', 'latin1');
    b.state.session.sendData(toDevice);
    const tx = await waitFor(() => b.uartTx().length === 1 && b.uartTx(), 'UART-TX');
    assert.deepStrictEqual(tx[0], toDevice);

    // board -> Pi: the device answers with the same kind of awkward bytes.
    const fromDevice = Buffer.from('MECHO_50 PING \x7e\x7e \x80 #255.19.255.QY=FE\r', 'latin1');
    b.uartRx(fromDevice);
    await waitFor(() => b.state.data.length === 1, 'DATA from the board');
    assert.deepStrictEqual(b.state.data[0], fromDevice);
    assert.ok(b.state.frames.every((f) => f.opcode !== F.OPCODE.ERROR), 'no ERROR frames were exchanged');
});

test('answers a PING from the server with PONG', { skip }, async (t) => {
    const b = await bench(t);
    await waitFor(() => b.state.session && b.state.session.registered, 'registration');
    b.state.session.sendFrame(F.OPCODE.PING);
    await waitFor(() => b.state.frames.some((f) => f.opcode === F.OPCODE.PONG), 'PONG');
    assert.strictEqual(b.uartTx().length, 0, 'protocol traffic never reaches the UART');
});

test('reconnects and re-registers with a fresh sequence counter after the server drops it', { skip }, async (t) => {
    const b = await bench(t);
    await waitFor(() => b.state.registrations.length === 1, 'first REGISTER');
    b.state.sockets[0].destroy();
    await waitFor(() => b.state.registrations.length === 2, 'second REGISTER', 12000);
    const registers = b.state.frames.filter((f) => f.opcode === F.OPCODE.REGISTER);
    assert.deepStrictEqual(registers.map((f) => f.seq), [0, 0]);
    assert.ok(b.seen(/Lost connection/), 'the board noticed the drop');
    assert.strictEqual(b.state.exitCode, null, 'the board did not crash or watchdog-reset');
});

test('a refused registration is not retried in a tight loop', { skip }, async (t) => {
    const b = await bench(t, {
        onConnection: (socket) => {
            const decoder = new F.Decoder();
            socket.on('data', (buf) => {
                for (const f of decoder.feed(buf)) {
                    if (f.opcode === F.OPCODE.REGISTER) {
                        socket.write(F.encodeJson(F.OPCODE.REGISTER_ACK, 0, { ok: false, reason: 'not on the list' }));
                        socket.end();
                    }
                }
            });
        },
    });
    await waitFor(() => b.seen(/registration refused: not on the list/), 'the refusal to be logged');
    await waitFor(() => b.seen(/Waiting 30 s/), 'the long wait to be announced');
    await sleep(2500);
    assert.strictEqual(b.state.sockets.length, 1, 'no reconnect within the first seconds');
    assert.strictEqual(b.state.exitCode, null);
});

test('a radio that refuses to join on first boot is retried, not fatal', { skip }, async (t) => {
    const b = await bench(t, { env: { PICO_SIM_WIFI_FAILS: '2' } });
    await waitFor(() => b.state.registrations.length === 1, 'REGISTER after WiFi retries', 15000);
    assert.ok(b.seen(/Join attempt 1 failed: .*EPERM/));
    assert.ok(b.seen(/Join attempt 2 failed: .*EPERM/));
    assert.ok(!b.seen(/MACHINE-RESET/), 'two failures are below the hardware-reset threshold');
});
