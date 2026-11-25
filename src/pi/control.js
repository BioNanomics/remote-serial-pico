'use strict';
// The operator's side of the control channel (issue #19 Phase E).
//
// The pty is the data path and stays byte-transparent, so control gets its own
// door: a Unix domain socket that `remote-serial-pico ctl <name> <command>`
// talks to. Each connection carries one request, as one line of JSON:
//
//     {"pico": "Blinds_pico", "cmd": "status", "args": {}}
//
// and gets one line back, {"ok": true, "result": {...}} or
// {"ok": false, "error": "..."}. `listen` is the exception: after its first
// line it keeps sending one line per chunk of serial traffic until the client
// hangs up.
//
// The socket is mode 0660 and belongs to the service's group, the same group
// that may open the ports, so whoever can use a board's serial port can also
// control it and nobody else can. Every command and its result is logged.

const fs = require('fs');
const net = require('net');

// Operator command -> what it means. `board` commands are forwarded to the
// Pico as a CONTROL_REQUEST; `listen` is served here; `server` commands are
// answered by a function PtyServer supplies.
const COMMANDS = Object.freeze({
    status: { board: 'status', timeoutMs: 5000 },
    reboot: { board: 'reboot', timeoutMs: 5000 },
    identify: { board: 'identify', timeoutMs: 5000 },
    uart_set: { board: 'uart_set', timeoutMs: 5000 },
    listen: { local: true },
    update: { server: 'requestUpdate' },      // Phase F: answered by PtyServer, see there
});

const MAX_REQUEST = 4096;

class ControlServer {
    // options:
    //   socketPath                where to listen
    //   sessionFor(name) -> PicoSession | null   the live session of a registered board
    //   names() -> [string]       boards currently known, for a helpful error
    //   log(level, msg)
    constructor(options) {
        this.options = options;
        this.server = null;
        this.listeners = new Map();   // pico name -> Set of (direction, buf) => void
        this.clients = new Set();
    }

    start(callback) {
        const { socketPath, log } = this.options;
        // A socket file left by a previous run would make listen() fail.
        try { if (fs.lstatSync(socketPath).isSocket()) fs.unlinkSync(socketPath); } catch (err) { if (err.code !== 'ENOENT') log('warn', `control socket ${socketPath}: ${err.message}`); }
        this.server = net.createServer((client) => this.onClient(client));
        this.server.on('error', (err) => log('error', `control socket ${socketPath}: ${err.message}`));
        this.server.listen(socketPath, () => {
            try { fs.chmodSync(socketPath, 0o660); } catch (err) { log('warn', `could not restrict ${socketPath}: ${err.message}`); }
            log('info', `Control socket listening at ${socketPath}`);
            if (callback) callback();
        });
    }

    stop() {
        if (this.server) this.server.close();
        for (const client of this.clients) client.destroy();   // ends any `listen` in progress
        try { fs.unlinkSync(this.options.socketPath); } catch { /* already gone */ }
    }

    // Called by PtyServer for every chunk of serial traffic, both directions.
    tap(name, direction, buf) {
        const set = this.listeners.get(name);
        if (set) for (const fn of set) fn(direction, buf);
    }

    onClient(client) {
        let buffered = '';
        let handled = false;
        client.setEncoding('utf8');
        this.clients.add(client);
        client.on('close', () => this.clients.delete(client));
        client.on('error', () => {});
        client.on('data', (chunk) => {
            if (handled) return;
            buffered += chunk;
            if (buffered.length > MAX_REQUEST) { handled = true; return this.reply(client, { ok: false, error: 'request too long' }); }
            const nl = buffered.indexOf('\n');
            if (nl === -1) return;
            handled = true;
            this.handle(client, buffered.slice(0, nl));
        });
    }

    reply(client, obj, keepOpen = false) {
        if (client.destroyed) return;
        const line = JSON.stringify(obj) + '\n';
        if (keepOpen) client.write(line); else client.end(line);
    }

    handle(client, line) {
        const { log, sessionFor, names } = this.options;
        let req;
        try { req = JSON.parse(line); } catch { req = null; }
        if (!req || typeof req.pico !== 'string' || typeof req.cmd !== 'string') {
            return this.reply(client, { ok: false, error: 'malformed request' });
        }
        const args = req.args && typeof req.args === 'object' && !Array.isArray(req.args) ? req.args : {};
        const what = `control: ${req.cmd} ${JSON.stringify(args)} for ${JSON.stringify(req.pico)}`;
        const spec = Object.prototype.hasOwnProperty.call(COMMANDS, req.cmd) ? COMMANDS[req.cmd] : null;
        if (!spec) {
            log('warn', `${what} => refused: unknown command`);
            return this.reply(client, { ok: false, error: `unknown command: ${req.cmd}. Known: ${Object.keys(COMMANDS).join(', ')}` });
        }
        if (spec.server) {
            // The server decides; the board need not be connected.
            const fn = this.options[spec.server];
            const answer = fn ? fn(req.pico) : { ok: false, error: `${req.cmd} is not available on this server` };
            log(answer.ok ? 'info' : 'warn', `${what} => ${answer.ok ? `ok ${JSON.stringify(answer.result)}` : `refused: ${answer.error}`}`);
            return this.reply(client, answer);
        }
        const session = sessionFor(req.pico);
        if (!session || !session.registered) {
            const known = names();
            log('warn', `${what} => refused: not connected`);
            return this.reply(client, { ok: false, error: `${req.pico} is not connected${known.length ? `. Connected now: ${known.join(', ')}` : '; no board is'}` });
        }

        if (spec.local) return this.listen(client, req.pico, what);

        session.control(spec.board, args, spec.timeoutMs).then((answer) => {
            log(answer.ok ? 'info' : 'warn', `${what} => ${answer.ok ? `ok ${JSON.stringify(answer.result)}` : `FAILED: ${answer.error}`}`);
            this.reply(client, answer);
        });
    }

    // Copy the board's serial traffic to this client, hex-encoded, without
    // touching the relay: the pty and the board see exactly what they would
    // have seen anyway.
    listen(client, name, what) {
        const { log } = this.options;
        const fn = (direction, buf) => this.reply(client, { dir: direction, hex: Buffer.from(buf).toString('hex') }, true);
        if (!this.listeners.has(name)) this.listeners.set(name, new Set());
        this.listeners.get(name).add(fn);
        log('info', `${what} => ok, streaming until the client disconnects`);
        this.reply(client, { ok: true, result: { listening: name } }, true);
        const done = () => {
            const set = this.listeners.get(name);
            if (set && set.delete(fn)) {
                if (set.size === 0) this.listeners.delete(name);
                log('info', `control: listen for ${JSON.stringify(name)} ended`);
            }
        };
        client.on('close', done);
        client.on('end', () => client.end());
    }
}

module.exports = { ControlServer, COMMANDS };
