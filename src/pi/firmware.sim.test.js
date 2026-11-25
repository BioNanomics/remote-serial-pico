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
const { firmwareHash, firmwareBundle } = require('./runtime.js');
const os = require('os');

const PYTHON = process.env.PYTHON || 'python3';
const havePython = spawnSync(PYTHON, ['--version']).status === 0;
const skip = havePython ? false : `${PYTHON} not found`;

const ROOT = path.join(__dirname, '..', '..');
const RUNNER = path.join(ROOT, 'tools', 'pico_sim', 'run_main.py');
const MAIN_PY = path.join(ROOT, 'src', 'pico', 'main.py');
const PICO_SRC = path.join(ROOT, 'src', 'pico');
const ID = 'e6614103e71d2c2f';
const KEY = crypto.randomBytes(32);     // the device key this board was "provisioned" with

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
// `boardKey` is what the board holds (null: never provisioned); `serverKey` is
// what the Pi has on record for it.
// `src` is the firmware the board starts with; `reboot` powers it back on
// after a reset, files intact, the way hardware does. `hooks` adds to or
// replaces the session's hooks (the firmware-update ones, for instance).
async function bench(t, { env = {}, onConnection, boardKey = KEY, serverKey = KEY, sessionOptions = {}, src = null, reboot = false, hooks = {} } = {}) {
    const state = { registrations: [], data: [], frames: [], sockets: [], stdout: [], log: [], exitCode: null };
    const server = net.createServer((socket) => {
        state.sockets.push(socket);
        const tap = new F.Decoder();
        socket.on('data', (buf) => state.frames.push(...tap.feed(buf)));
        socket.on('error', () => {});
        if (onConnection) return onConnection(socket, state);
        const session = new PicoSession({
            send: (buf) => { if (!socket.destroyed) socket.write(buf); },
            close: () => socket.end(),
            log: (level, msg) => state.log.push(`${level}: ${msg}`),
            secretFor: (id) => (id === ID ? serverKey : null),
            register: (id, info) => { state.registrations.push({ id, ...info }); return 'sim-board'; },
            onData: (payload) => state.data.push(payload),
            ...hooks,
        }, sessionOptions);
        socket.on('close', () => session.connectionLost());
        socket.on('data', (buf) => session.receive(buf));
        state.session = session;
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const args = ['-u', RUNNER, '--host', '127.0.0.1', '--port', String(port), '--id', ID];
    if (boardKey) args.push('--key', boardKey.toString('hex'));
    if (src) args.push('--src', src);
    if (reboot) args.push('--reboot');
    const child = spawn(PYTHON, args,
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
        try { child.stdin.write('EXIT\n'); } catch { /* already gone */ }   // ends a rebooted board too
        child.kill('SIGKILL');
        for (const s of state.sockets) s.destroy();
        server.close();
    });

    const uartRx = (buf) => child.stdin.write(`UART-RX ${buf.toString('hex')}\n`);
    const uartTx = () => state.stdout.filter((l) => l.startsWith('UART-TX ')).map((l) => Buffer.from(l.slice(8), 'hex'));
    const seen = (re) => state.stdout.some((l) => re.test(l));
    return { state, child, uartRx, uartTx, seen, port };
}

test('registers with its id, firmware version and a hash of the whole deployed firmware, after proving its key', { skip }, async (t) => {
    const b = await bench(t, { sessionOptions: { firmwareHash: firmwareHash(PICO_SRC) } });
    await waitFor(() => b.state.registrations.length === 1, 'REGISTER');
    const reg = b.state.registrations[0];
    const fwInSource = fs.readFileSync(MAIN_PY, 'utf8').match(/^FIRMWARE_VERSION = '([^']+)'/m)[1];
    assert.deepStrictEqual(reg, { id: ID, fw: fwInSource, hash: firmwareHash(PICO_SRC) },
        'the board and the Pi compute the same hash over the same files, so the mismatch check passes');
    assert.strictEqual(b.state.frames[0].opcode, F.OPCODE.REGISTER, 'REGISTER is the first frame on the wire');
    assert.strictEqual(b.state.frames[0].seq, 0);
    assert.deepStrictEqual(b.state.frames.slice(0, 2).map((f) => f.opcode), [F.OPCODE.REGISTER, F.OPCODE.AUTH_RESPONSE]);
    await waitFor(() => b.seen(/Registered as 'sim-board'.*the Pi proved it holds our key/), 'the board to log the ack');
    assert.strictEqual(b.state.exitCode, null, `board exited: ${b.state.stdout.join('\n')}`);
    const keyHex = KEY.toString('hex');
    assert.ok(!b.state.stdout.some((l) => l.includes(keyHex)), 'the board never prints its key');
    assert.ok(!b.state.log.some((l) => l.includes(keyHex)), 'the server never logs a key');
});

test('a board whose key the Pi does not have on record is refused and backs off', { skip }, async (t) => {
    const b = await bench(t, { boardKey: crypto.randomBytes(32) });
    await waitFor(() => b.seen(/registration refused: authentication failed/), 'the refusal to be logged');
    await waitFor(() => b.seen(/Waiting 30 s/), 'the long wait to be announced');
    assert.strictEqual(b.state.registrations.length, 0, 'no pty for a board that failed authentication');
    assert.ok(b.state.log.some((l) => /refusing e6614103e71d2c2f: it does not hold the device key/.test(l)));
});

test('a board that was never provisioned says so and is not registered', { skip }, async (t) => {
    const b = await bench(t, { boardKey: null });
    await waitFor(() => b.seen(/No device key in config\.json/), 'the boot message');
    await waitFor(() => b.seen(/registration refused: this board has no device key/), 'the refusal');
    assert.strictEqual(b.state.registrations.length, 0);
});

test('a board running other firmware is refused, or served with a warning when configured so', { skip }, async (t) => {
    const b = await bench(t, { sessionOptions: { firmwareHash: 'aaaaaaaaaaaaaaaa' } });
    await waitFor(() => b.seen(/registration refused: firmware mismatch/), 'the refusal');
    assert.strictEqual(b.state.registrations.length, 0);

    const w = await bench(t, { sessionOptions: { firmwareHash: 'aaaaaaaaaaaaaaaa', firmwareMismatch: 'warn' } });
    await waitFor(() => w.state.registrations.length === 1, 'registration in warn mode');
    assert.ok(w.state.log.some((l) => /^warn: .* not the hash aaaaaaaaaaaaaaaa/.test(l)));
});

test('a server that does not hold the key cannot register the board or reach its UART', { skip }, async (t) => {
    // The mutual half: a rogue "Pi" on the Pico network says yes to everything.
    const b = await bench(t, {
        onConnection: (socket) => {
            const decoder = new F.Decoder();
            let seq = 0;
            socket.on('data', (buf) => {
                for (const f of decoder.feed(buf)) {
                    if (f.opcode === F.OPCODE.REGISTER) socket.write(F.encode(F.OPCODE.AUTH_CHALLENGE, seq++, crypto.randomBytes(32)));
                    if (f.opcode === F.OPCODE.AUTH_RESPONSE) {
                        socket.write(F.encodeJson(F.OPCODE.REGISTER_ACK, seq++, { ok: true, name: 'evil', time: 1 }));
                        socket.write(F.encode(F.OPCODE.DATA, seq++, Buffer.from('#255.19.255.B=UP\r')));
                    }
                }
            });
        },
    });
    await waitFor(() => b.seen(/server did not prove it holds the device key/), 'the board to reject the server');
    await sleep(300);
    assert.strictEqual(b.uartTx().length, 0, 'nothing from an unauthenticated server reaches the serial device');
    assert.ok(!b.seen(/Registered as/));
});

test('a frame injected into a live session never reaches the UART and the board reconnects', { skip }, async (t) => {
    const b = await bench(t);
    await waitFor(() => b.state.session && b.state.session.registered, 'registration');
    // Someone on the network writes a well-formed DATA frame into the stream.
    b.state.sockets[0].write(F.encode(F.OPCODE.DATA, 99, Buffer.concat([Buffer.from('#255.19.255.B=UP\r'), Buffer.alloc(16)])));
    await waitFor(() => b.seen(/Lost connection: frame failed authentication/), 'the board to drop the connection');
    assert.strictEqual(b.uartTx().length, 0, 'the injected command never reached the blind');
    await waitFor(() => b.state.registrations.length === 2, 'the board to come back by itself', 12000);
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
    assert.strictEqual(b.state.sockets.length, 1, `no reconnect within the first seconds:\n${b.state.stdout.join('\n')}`);
    assert.strictEqual(b.state.exitCode, null);
});

test('a radio that refuses to join on first boot is retried, not fatal', { skip }, async (t) => {
    const b = await bench(t, { env: { PICO_SIM_WIFI_FAILS: '2' } });
    await waitFor(() => b.state.registrations.length === 1, 'REGISTER after WiFi retries', 15000);
    assert.ok(b.seen(/Join attempt 1 failed: .*EPERM/));
    assert.ok(b.seen(/Join attempt 2 failed: .*EPERM/));
    assert.ok(!b.seen(/MACHINE-RESET/), 'two failures are below the hardware-reset threshold');
});

// --- control channel (Phase E): the acceptance criteria, against the real main.py ---

const boardDir = (b) => b.state.stdout.map((l) => /^SIM board=(\S+)/.exec(l)).find(Boolean)[1];
const boardConfig = (b) => JSON.parse(fs.readFileSync(path.join(boardDir(b), 'config.json'), 'utf8'));

test('status reports firmware, uptime, counters and the serial settings, and nothing reaches the UART', { skip }, async (t) => {
    const b = await bench(t);
    await waitFor(() => b.state.session && b.state.session.registered, 'registration');
    b.uartRx(Buffer.from('255.19.255.QY=FE\r'));
    await waitFor(() => b.state.data.length === 1, 'some serial traffic to count');
    const answer = await b.state.session.control('status');
    assert.strictEqual(answer.ok, true, JSON.stringify(answer));
    const fwInSource = fs.readFileSync(MAIN_PY, 'utf8').match(/^FIRMWARE_VERSION = '([^']+)'/m)[1];
    assert.strictEqual(answer.result.fw, fwInSource);
    assert.strictEqual(answer.result.hash, firmwareHash(PICO_SRC));
    assert.strictEqual(answer.result.uart, '19200 8N1');
    assert.strictEqual(answer.result.connections, 1);
    assert.strictEqual(answer.result.uart_rx_bytes, 17);
    assert.ok(answer.result.uptime_s >= 0);
    assert.strictEqual(b.uartTx().length, 0, 'a control command is never written to the serial device');
    assert.strictEqual(b.state.data.length, 1, 'and its answer is never delivered as device data');
});

test('uart set retunes the link for this session only; --save is what makes it survive', { skip }, async (t) => {
    const b = await bench(t);
    await waitFor(() => b.state.session && b.state.session.registered, 'registration');
    assert.ok(b.seen(/^UART-INIT 19200 8 N 1$/), 'boots at 19200 8N1');

    let answer = await b.state.session.control('uart_set', { baud: 9600, parity: 'E', save: false });
    assert.deepStrictEqual(answer, { ok: true, result: { uart: '9600 8E1', saved: false } });
    await waitFor(() => b.seen(/^UART-INIT 9600 8 E 1$/), 'the UART to be re-initialised');
    assert.strictEqual(boardConfig(b).UART, undefined, 'nothing written to flash: a power cycle undoes a wrong setting');
    assert.strictEqual((await b.state.session.control('status')).result.uart, '9600 8E1');

    // The relay keeps working at the new settings.
    b.state.session.sendData(Buffer.from('#255.19.255.B=UP\r'));
    await waitFor(() => b.uartTx().length === 1, 'UART-TX after the retune');

    answer = await b.state.session.control('uart_set', { baud: 1 });
    assert.strictEqual(answer.ok, false);
    assert.match(answer.error, /baud must be between/);
    assert.ok(!b.seen(/^UART-INIT 1 /), 'a refused setting is never applied');

    answer = await b.state.session.control('uart_set', { baud: 4800, save: true });
    assert.deepStrictEqual(answer.result, { uart: '4800 8E1', saved: true });
    const saved = boardConfig(b);
    assert.deepStrictEqual(saved.UART, { baud: 4800, bits: 8, parity: 0, stop: 1 });
    assert.strictEqual(saved.KEY, KEY.toString('hex'), 'saving the serial settings keeps the device key');
    assert.strictEqual(saved.WIFI_SSID, 'sim');
});

test('identify blinks for the time asked and then stops, without interrupting the relay', { skip }, async (t) => {
    const b = await bench(t);
    await waitFor(() => b.state.session && b.state.session.registered, 'registration');
    const answer = await b.state.session.control('identify', { seconds: 1 });
    assert.deepStrictEqual(answer, { ok: true, result: { blinking_for: 1 } });
    b.state.session.sendData(Buffer.from('#255.19.255.B=UP\r'));
    await waitFor(() => b.uartTx().length === 1, 'the relay to carry on while blinking');
    await waitFor(() => b.seen(/\[CTL\] identify finished/), 'the blinking to stop by itself', 5000);
});

test('reboot answers, then resets the board', { skip }, async (t) => {
    const b = await bench(t);
    await waitFor(() => b.state.session && b.state.session.registered, 'registration');
    const answer = await b.state.session.control('reboot');
    assert.deepStrictEqual(answer, { ok: true, result: { rebooting: true } });
    await waitFor(() => b.state.exitCode !== null, 'the board to reset');
    assert.ok(b.seen(/^MACHINE-RESET$/), b.state.stdout.join('\n'));
    assert.strictEqual(b.uartTx().length, 0);
});

test('an unknown control command is refused by the board and changes nothing', { skip }, async (t) => {
    const b = await bench(t);
    await waitFor(() => b.state.session && b.state.session.registered, 'registration');
    const answer = await b.state.session.control('format_flash');
    assert.deepStrictEqual(answer, { ok: false, error: 'unknown command: format_flash' });
    assert.strictEqual(b.state.exitCode, null);
});

// --- firmware update over the air (Phase F): the acceptance criteria -------------------

// A copy of the firmware with main.py changed: `edit` gets the source and returns the new one.
function firmwareCopy(t, edit) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsp-fw-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const manifest = JSON.parse(fs.readFileSync(path.join(PICO_SRC, 'firmware.json'), 'utf8'));
    for (const name of ['firmware.json', ...manifest.files, ...manifest.usb_only]) fs.copyFileSync(path.join(PICO_SRC, name), path.join(dir, name));
    fs.writeFileSync(path.join(dir, 'main.py'), edit(fs.readFileSync(path.join(dir, 'main.py'), 'utf8')));
    return dir;
}
const boardFiles = (b) => fs.readdirSync(boardDir(b)).sort();

test('a firmware change on the Pi reaches the board on its next connection, verified, with both versions logged', { skip }, async (t) => {
    const old = firmwareCopy(t, (src) => src + '\n# an older build\n');
    const oldHash = firmwareHash(old), newHash = firmwareHash(PICO_SRC);
    assert.notStrictEqual(oldHash, newHash);
    const finished = [];
    const b = await bench(t, {
        src: old, reboot: true, sessionOptions: { firmwareHash: newHash },
        hooks: { offerUpdate: () => firmwareBundle(PICO_SRC), updateFinished: (id, ok, detail) => finished.push({ id, ok, detail }) },
    });

    await waitFor(() => b.seen(/\[OTA\] Update verified/), 'the board to verify the update', 20000);
    assert.strictEqual(b.state.registrations.length, 0, 'the update happens before the board is registered: no serial data has moved');
    assert.strictEqual(b.uartTx().length, 0);
    await waitFor(() => finished.length === 1, 'the server to hear the result');
    assert.deepStrictEqual(finished, [{ id: ID, ok: true, detail: { from: oldHash, to: newHash } }]);
    assert.ok(b.state.log.some((l) => l.includes(`sending hash ${newHash}`) && l.includes(`(hash ${oldHash})`)), 'old and new versions are logged');
    assert.ok(b.state.log.some((l) => new RegExp(`verified and installed it: .*hash ${oldHash}\\) -> hash ${newHash}`).test(l)), b.state.log.join('\n'));

    await waitFor(() => b.seen(/^MACHINE-RESET$/), 'the board to restart');
    await waitFor(() => b.seen(/\[BOOT\] New firmware on trial, start 1 of 3/), 'boot.py to put the new firmware on trial');
    await waitFor(() => b.state.registrations.length === 1, 'the board to come back and register', 20000);
    assert.strictEqual(b.state.registrations[0].hash, newHash, 'it now reports the firmware the Pi deploys');
    await waitFor(() => b.seen(/\[OTA\] New firmware confirmed/), 'the new firmware to confirm itself');
    assert.ok(!boardFiles(b).some((n) => n.endsWith('.bak') || n.endsWith('.new') || n === 'update.json'),
        `nothing left over on the board: ${boardFiles(b)}`);
    assert.strictEqual(fs.readFileSync(path.join(boardDir(b), 'main.py'), 'utf8'), fs.readFileSync(MAIN_PY, 'utf8'));
    assert.strictEqual(boardConfig(b).KEY, KEY.toString('hex'), 'the device key survives an update');

    // And it works: the relay carries data on the new firmware.
    b.state.session.sendData(Buffer.from('#255.19.255.B=UP\r'));
    await waitFor(() => b.uartTx().length === 1, 'UART-TX on the new firmware');
});

test('a corrupted update is rejected and the board keeps running the previous firmware', { skip }, async (t) => {
    const old = firmwareCopy(t, (src) => src + '\n# an older build\n');
    const oldHash = firmwareHash(old);
    const corrupt = () => {
        const bundle = firmwareBundle(PICO_SRC);
        const victim = bundle.files.find((f) => f.name === 'net_util.py');
        victim.data = Buffer.from(victim.data);
        victim.data[200] ^= 0x01;                       // one bit flipped after the hash was taken
        return bundle;
    };
    const finished = [];
    const b = await bench(t, {
        src: old, reboot: true, sessionOptions: { firmwareHash: firmwareHash(PICO_SRC), firmwareMismatch: 'warn' },
        hooks: { offerUpdate: corrupt, updateFinished: (id, ok, detail) => finished.push({ ok, detail }) },
    });
    await waitFor(() => b.seen(/\[OTA\] Update rejected: net_util\.py: sha256 does not match/), 'the board to reject it', 20000);
    await waitFor(() => finished.length === 1, 'the server to hear the refusal');
    assert.deepStrictEqual(finished, [{ ok: false, detail: 'net_util.py: sha256 does not match' }]);
    assert.ok(!b.seen(/MACHINE-RESET/), 'a rejected update does not restart the board');
    await waitFor(() => b.state.registrations.length === 1, 'the board to be served on what it has (warn policy)');
    assert.strictEqual(b.state.registrations[0].hash, oldHash);
    assert.ok(!boardFiles(b).some((n) => n.endsWith('.new') || n.endsWith('.bak')), `no half-update left: ${boardFiles(b)}`);
    b.state.session.sendData(Buffer.from('#255.19.255.B=UP\r'));
    await waitFor(() => b.uartTx().length === 1, 'the old firmware to keep relaying');
});

test('firmware that verifies but does not start is rolled back by boot.py, and the board returns on the old one', { skip }, async (t) => {
    // The update the reviewer worried about: a valid, correctly hashed image whose main.py crashes on import.
    const broken = firmwareCopy(t, () => 'raise RuntimeError("this build is broken")\n');
    const good = firmwareHash(PICO_SRC);
    let offers = 0;
    const b = await bench(t, {
        reboot: true, sessionOptions: { firmwareHash: firmwareHash(broken), firmwareMismatch: 'warn' },
        hooks: { offerUpdate: () => (offers++ === 0 ? firmwareBundle(broken) : null) },
    });
    await waitFor(() => b.seen(/\[OTA\] Update verified/), 'the board to accept the (valid but broken) image', 20000);
    await waitFor(() => b.seen(/this build is broken/), 'the new main.py to crash');
    await waitFor(() => b.seen(/\[BOOT\] New firmware on trial, start 3 of 3/), 'three failed starts', 20000);
    await waitFor(() => b.seen(/\[BOOT\] Previous firmware restored/), 'boot.py to restore the old firmware', 20000);
    await waitFor(() => b.state.registrations.length === 1, 'the board to come back on the firmware it had', 20000);
    assert.strictEqual(b.state.registrations[0].hash, good);
    assert.strictEqual(b.state.stdout.filter((l) => /^WDT-RESET main\.py crashed/.test(l)).length, 3, 'each failed start ended in a watchdog reset, not a dead board');
    assert.ok(!boardFiles(b).some((n) => n.endsWith('.bak') || n === 'update.json'), `rollback cleaned up: ${boardFiles(b)}`);
    b.state.session.sendData(Buffer.from('#255.19.255.B=UP\r'));
    await waitFor(() => b.uartTx().length === 1, 'the restored firmware to relay');
});

test('an update is never accepted from a server that does not hold the key', { skip }, async (t) => {
    const before = fs.readFileSync(MAIN_PY, 'utf8');
    const b = await bench(t, {
        onConnection: (socket) => {
            const decoder = new F.Decoder();
            let seq = 0;
            socket.on('data', (buf) => {
                for (const f of decoder.feed(buf)) {
                    if (f.opcode === F.OPCODE.REGISTER) socket.write(F.encode(F.OPCODE.AUTH_CHALLENGE, seq++, crypto.randomBytes(32)));
                    if (f.opcode === F.OPCODE.AUTH_RESPONSE) {
                        const evil = Buffer.from('import os\n');
                        socket.write(F.encodeJson(F.OPCODE.UPDATE_OFFER, seq++, { name: 'main.py', len: evil.length, sha256: crypto.createHash('sha256').update(evil).digest('hex') }));
                    }
                }
            });
        },
    });
    await waitFor(() => b.seen(/firmware update from a server that did not prove it holds the device key/), 'the board to refuse');
    assert.ok(!b.seen(/\[OTA\] The Pi is offering/));
    assert.ok(!boardFiles(b).some((n) => n.endsWith('.new')));
    assert.strictEqual(fs.readFileSync(path.join(boardDir(b), 'main.py'), 'utf8'), before);
});
