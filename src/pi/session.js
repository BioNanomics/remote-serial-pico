// One PicoSession per TCP connection: turns socket bytes into protocol
// events and protocol replies into socket bytes. See docs/protocol.md.
//
// No I/O of its own. PtyServer.js hands it callbacks, so the whole state
// machine is testable with a fake socket. The data-path rule from the spec is
// enforced here: only DATA payloads are ever passed to onData (the pty).
//
// Nothing a board says is acted on until it has proved it holds its device
// key (spec, "Authentication"): no pty, no entry in the serial map, no name.
// There is no unauthenticated mode and no legacy mode.

const crypto = require('crypto');
const F = require('./frame.js');
const A = require('./auth.js');

const SERIAL_ID = /^[0-9a-f]{16}$/;

// Board-supplied text goes into log lines. Keep it printable and short so a
// board cannot forge a line of log (issue #19 review, S7).
function printable(text, max = 64) {
    return String(text).replace(/[^\x20-\x7e]/g, '?').slice(0, max);
}

class PicoSession {
    // hooks:
    //   send(buf)                  write bytes to the socket
    //   close()                    end the connection
    //   log(level, msg)            level is 'info' | 'warn' | 'error'
    //   secretFor(id) -> Buffer    the board's 32-byte device key, or null if
    //                              this Pi never provisioned it
    //   register(id, info) -> name called once, after the board authenticated;
    //                              returns its display name. info = { fw, hash }
    //   onData(buf)                a DATA payload from the board, for the pty
    //   now() -> seconds           optional, for REGISTER_ACK.time
    //   randomBytes(n) -> Buffer   optional, for the challenge nonce
    // options:
    //   firmwareHash               hash of the firmware this Pi would deploy
    //   firmwareMismatch           'refuse' (default) or 'warn': what to do
    //                              with an authenticated board running
    //                              something else
    constructor(hooks, options = {}) {
        this.hooks = hooks;
        this.firmwareHash = options.firmwareHash || null;
        this.firmwareMismatch = options.firmwareMismatch === 'warn' ? 'warn' : 'refuse';
        this.protocol = 'v1';
        this.decoder = new F.Decoder();
        this.seq = new F.Sequencer();
        this.name = null;          // set once registered
        this.info = null;          // { id, fw, hash }
        this.pending = null;       // { key, nonce } between AUTH_CHALLENGE and AUTH_RESPONSE
        this.tx = null;            // A.Tagger, pi -> pico, once authenticated
        this.rx = null;            // A.Tagger, pico -> pi
        this.requests = new Map(); // control request id -> { resolve, timer, cmd }
        this.nextRequestId = 1;
        this.closed = false;
        this.stats = { frames: 0, dataIn: 0, dataOut: 0, pings: 0, dropped: 0 };
    }

    get registered() { return this.name !== null; }
    get authenticated() { return this.rx !== null; }

    // --- outgoing -----------------------------------------------------------

    sendFrame(opcode, payload = Buffer.alloc(0)) {
        if (this.closed) return;
        let body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        if (this.tx) body = this.tx.seal(opcode, body);
        this.hooks.send(F.encode(opcode, this.seq.next(), body));
    }

    sendJson(opcode, obj) {
        this.sendFrame(opcode, Buffer.from(JSON.stringify(obj), 'utf8'));
    }

    sendError(code, msg) {
        this.sendJson(F.OPCODE.ERROR, { code, msg });
    }

    // Bytes from the pty, bound for the serial device. Chunked so a large
    // paste into the pty never exceeds MAX_PAYLOAD once the tag is added.
    // Nothing is sent to a board that has not finished registering.
    sendData(buf) {
        if (!this.registered) return;
        const step = F.MAX_PAYLOAD - A.TAG_LEN;
        for (let i = 0; i < buf.length; i += step) {
            this.sendFrame(F.OPCODE.DATA, buf.subarray(i, i + step));
            this.stats.dataOut += 1;
        }
    }

    // Send one control command to the board and resolve with its answer:
    // { ok: true, result } or { ok: false, error }. Never rejects. Control
    // traffic has its own opcodes and never touches the pty (the data path
    // rule), and like every frame after the handshake it is authenticated, so
    // a board only ever acts on a command from the Pi that holds its key.
    control(cmd, args = {}, timeoutMs = 5000) {
        if (!this.registered || this.closed) return Promise.resolve({ ok: false, error: 'board is not connected' });
        const id = this.nextRequestId++;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.requests.delete(id);
                resolve({ ok: false, error: `no answer from the board within ${timeoutMs / 1000} s` });
            }, timeoutMs);
            this.requests.set(id, { resolve, timer, cmd });
            this.sendJson(F.OPCODE.CONTROL_REQUEST, { id, cmd, args });
        });
    }

    onControlResponse(body) {
        const res = F.decodeJson(body);
        const pending = res && this.requests.get(res.id);
        if (!pending) {
            this.hooks.log('warn', `${this.who()} sent a CONTROL_RESPONSE nobody is waiting for; ignored`);
            return;
        }
        clearTimeout(pending.timer);
        this.requests.delete(res.id);
        pending.resolve(res.ok === true
            ? { ok: true, result: res.result === undefined ? {} : res.result }
            : { ok: false, error: printable(res.error === undefined ? 'the board reported a failure' : res.error, 200) });
    }

    failRequests(reason) {
        for (const [id, pending] of this.requests) {
            clearTimeout(pending.timer);
            pending.resolve({ ok: false, error: reason });
            this.requests.delete(id);
        }
    }

    // The socket is gone (PtyServer calls this from its close handler too).
    connectionLost() {
        this.failRequests('the board disconnected before answering');
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        this.failRequests('the connection was closed before the board answered');
        this.hooks.close();
    }

    refuse(reason, logLine) {
        this.hooks.log('warn', logLine);
        this.sendJson(F.OPCODE.REGISTER_ACK, { ok: false, reason });
        this.close();
    }

    // --- incoming -----------------------------------------------------------

    // Feed raw socket bytes. Returns the number of frames handled.
    receive(chunk) {
        const before = this.decoder.resyncs;
        const beforeVersion = this.decoder.versionErrors;
        const frames = this.decoder.feed(chunk);

        if (this.decoder.resyncs > before) {
            this.hooks.log('warn', `${this.who()} resynchronised ${this.decoder.resyncs - before} time(s) on corrupt input`);
        }
        if (this.decoder.versionErrors > beforeVersion) {
            this.hooks.log('error', `${this.who()} sent a frame with an unsupported protocol version; closing`);
            this.sendError(F.ERR.VERSION, `only protocol version ${F.VERSION} is supported`);
            this.close();
            return 0;
        }
        for (const frame of frames) {
            if (this.closed) break;
            this.stats.frames += 1;
            this.handle(frame);
        }
        return frames.length;
    }

    handle(frame) {
        if (!this.authenticated) {
            switch (frame.opcode) {
                case F.OPCODE.REGISTER: return this.onRegister(frame);
                case F.OPCODE.AUTH_RESPONSE: return this.onAuthResponse(frame);
                case F.OPCODE.ERROR: return this.onError(frame.payload);
                default:
                    // DATA, PING, anything: not before the board has proved who it is.
                    this.stats.dropped += 1;
                    this.sendError(F.ERR.NOT_REGISTERED, 'authenticate first');
                    return;
            }
        }

        // Authenticated: every frame must carry the next tag.
        const body = this.rx.open(frame.opcode, frame.payload);
        if (body === null) {
            this.hooks.log('error', `${this.who()} sent a frame that failed authentication (altered, replayed or out of order); closing`);
            this.close();
            return;
        }
        switch (frame.opcode) {
            case F.OPCODE.PING: return this.onPing();
            case F.OPCODE.DATA: return this.onData(body);
            case F.OPCODE.ERROR: return this.onError(body);
            case F.OPCODE.CONTROL_RESPONSE: return this.onControlResponse(body);
            case F.OPCODE.PONG: return;   // we never PING in v1, but it is legal
            default: return this.onOther(frame.opcode);
        }
    }

    onRegister(frame) {
        if (this.pending) {
            this.hooks.log('warn', `${this.who()} sent a second REGISTER; ignored`);
            return;
        }
        const reg = F.decodeJson(frame.payload);
        const id = reg && typeof reg.id === 'string' ? reg.id.toLowerCase() : null;
        if (!id || !SERIAL_ID.test(id)) {
            return this.refuse('malformed registration',
                `refusing malformed registration: ${JSON.stringify(printable(frame.payload.toString('latin1'), 80))}`);
        }
        const fw = typeof reg.fw === 'string' ? printable(reg.fw) : 'unknown';
        const hash = typeof reg.hash === 'string' ? printable(reg.hash) : 'unknown';
        this.info = { id, fw, hash };

        const key = this.hooks.secretFor(id);
        if (!key) {
            return this.refuse('unknown device',
                `refusing ${id}: no device key on record. Plug the board into this Pi to provision it`);
        }
        const nonce = (this.hooks.randomBytes || crypto.randomBytes)(A.NONCE_LEN);
        this.pending = { key, nonce };
        this.sendFrame(F.OPCODE.AUTH_CHALLENGE, nonce);
    }

    onAuthResponse(frame) {
        if (!this.pending) {
            this.stats.dropped += 1;
            this.sendError(F.ERR.NOT_REGISTERED, 'register first');
            return;
        }
        const { key, nonce } = this.pending;
        const { id, fw, hash } = this.info;
        const ok = frame.payload.length === A.NONCE_LEN + 32 &&
            A.equal(A.picoProof(key, nonce, frame.payload.subarray(0, A.NONCE_LEN), id), frame.payload.subarray(A.NONCE_LEN));
        if (!ok) {
            return this.refuse('authentication failed',
                `refusing ${id}: it does not hold the device key on record (wrong key, or something impersonating the board)`);
        }
        const keys = A.sessionKeys(key, nonce, frame.payload.subarray(0, A.NONCE_LEN), id);
        this.pending.key = null;
        // From here every frame both ways is tagged, starting with our reply:
        // a correctly tagged REGISTER_ACK is what proves to the board that
        // this server holds its key too.
        this.tx = new A.Tagger(keys.piToPico);
        this.rx = new A.Tagger(keys.picoToPi);

        if (this.firmwareHash && hash !== this.firmwareHash) {
            if (this.firmwareMismatch === 'refuse') {
                return this.refuse('firmware mismatch',
                    `refusing ${id}: it runs firmware ${fw} (hash ${hash}) but this Pi deploys hash ${this.firmwareHash}. Plug the board into this Pi to update it`);
            }
            this.hooks.log('warn', `${id} runs firmware ${fw} (hash ${hash}), not the hash ${this.firmwareHash} this Pi deploys`);
        }

        this.name = this.hooks.register(id, { fw, hash });
        this.hooks.log('info', `${this.name} registered: serial ${id}, firmware ${fw}, hash ${hash}, authenticated`);
        this.sendJson(F.OPCODE.REGISTER_ACK, {
            ok: true,
            name: this.name,
            time: Math.floor((this.hooks.now ? this.hooks.now() : Date.now() / 1000)),
        });
    }

    onPing() {
        this.stats.pings += 1;
        this.sendFrame(F.OPCODE.PONG);
    }

    onData(body) {
        if (!this.registered) {
            this.stats.dropped += 1;
            return;
        }
        this.stats.dataIn += 1;
        this.hooks.onData(body);
    }

    onError(body) {
        const err = F.decodeJson(body) || {};
        this.hooks.log('warn', `${this.who()} reports error ${printable(err.code, 8)}: ${printable(err.msg, 120)}`);
    }

    onOther(opcode) {
        const name = F.OPCODE_NAME[opcode];
        if (name) {
            // Assigned to a later phase, or a handshake opcode out of place.
            this.hooks.log('warn', `${this.who()} sent ${name}, which this server does not act on here; ignored`);
        } else {
            this.hooks.log('warn', `${this.who()} sent unknown opcode 0x${opcode.toString(16)}; ignored`);
            this.sendError(F.ERR.UNKNOWN_OPCODE, `unknown opcode 0x${opcode.toString(16)}`);
        }
    }

    who() {
        return this.name || (this.info && this.info.id) || 'unauthenticated peer';
    }
}

module.exports = { PicoSession, SERIAL_ID, printable };
