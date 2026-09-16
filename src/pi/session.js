// One PicoSession per TCP connection: turns socket bytes into protocol
// events and protocol replies into socket bytes. See docs/protocol.md.
//
// No I/O of its own. PtyServer.js hands it callbacks, so the whole state
// machine is testable with a fake socket. The data-path rule from the spec is
// enforced here: only DATA payloads are ever passed to onData (the pty).

const F = require('./frame.js');

const SERIAL_ID = /^[0-9a-f]{16}$/;

class PicoSession {
    // hooks:
    //   send(buf)                  write bytes to the socket
    //   close()                    end the connection
    //   log(level, msg)            level is 'info' | 'warn' | 'error'
    //   register(id, info) -> name  called once on a valid REGISTER; returns the
    //                              board's display name. info = { fw, hash }
    //   onData(buf)                a DATA payload from the board, for the pty
    //   now() -> seconds           optional, for REGISTER_ACK.time
    constructor(hooks) {
        this.hooks = hooks;
        this.decoder = new F.Decoder();
        this.seq = new F.Sequencer();
        this.name = null;          // set once registered
        this.info = null;          // { id, fw, hash }
        this.closed = false;
        this.stats = { frames: 0, dataIn: 0, dataOut: 0, pings: 0, dropped: 0 };
    }

    get registered() { return this.name !== null; }

    // --- outgoing -----------------------------------------------------------

    sendFrame(opcode, payload) {
        if (this.closed) return;
        this.hooks.send(F.encode(opcode, this.seq.next(), payload));
    }

    sendJson(opcode, obj) {
        this.sendFrame(opcode, Buffer.from(JSON.stringify(obj), 'utf8'));
    }

    sendError(code, msg) {
        this.sendJson(F.OPCODE.ERROR, { code, msg });
    }

    // Bytes from the pty, bound for the serial device. Chunked so a large
    // paste into the pty never exceeds MAX_PAYLOAD.
    sendData(buf) {
        for (let i = 0; i < buf.length; i += F.MAX_PAYLOAD) {
            this.sendFrame(F.OPCODE.DATA, buf.subarray(i, i + F.MAX_PAYLOAD));
            this.stats.dataOut += 1;
        }
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        this.hooks.close();
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
        switch (frame.opcode) {
            case F.OPCODE.REGISTER: return this.onRegister(frame);
            case F.OPCODE.PING: return this.onPing();
            case F.OPCODE.DATA: return this.onData(frame);
            case F.OPCODE.ERROR: return this.onError(frame);
            case F.OPCODE.PONG: return;   // we never PING in v1, but it is legal
            default: return this.onOther(frame);
        }
    }

    onRegister(frame) {
        if (this.registered) {
            this.hooks.log('warn', `${this.who()} sent a second REGISTER; ignored`);
            return;
        }
        const reg = F.decodeJson(frame.payload);
        const id = reg && typeof reg.id === 'string' ? reg.id.toLowerCase() : null;
        if (!id || !SERIAL_ID.test(id)) {
            this.hooks.log('warn', `refusing malformed registration: ${JSON.stringify(frame.payload.toString('utf8').slice(0, 80))}`);
            this.sendJson(F.OPCODE.REGISTER_ACK, { ok: false, reason: 'malformed registration' });
            this.close();
            return;
        }
        const fw = typeof reg.fw === 'string' ? reg.fw : 'unknown';
        const hash = typeof reg.hash === 'string' ? reg.hash : 'unknown';
        this.info = { id, fw, hash };
        this.name = this.hooks.register(id, { fw, hash });
        this.hooks.log('info', `${this.name} registered: serial ${id}, firmware ${fw}, hash ${hash}`);
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

    onData(frame) {
        if (!this.registered) {
            this.stats.dropped += 1;
            this.sendError(F.ERR.NOT_REGISTERED, 'register first');
            return;
        }
        this.stats.dataIn += 1;
        this.hooks.onData(frame.payload);
    }

    onError(frame) {
        const err = F.decodeJson(frame.payload) || {};
        this.hooks.log('warn', `${this.who()} reports error ${err.code}: ${err.msg}`);
    }

    onOther(frame) {
        const name = F.OPCODE_NAME[frame.opcode];
        if (!this.registered) {
            this.stats.dropped += 1;
            this.sendError(F.ERR.NOT_REGISTERED, 'register first');
            return;
        }
        if (name) {
            // Assigned to a later phase; nothing to do with it yet.
            this.hooks.log('warn', `${this.who()} sent ${name}, which this server does not implement yet; ignored`);
        } else {
            this.hooks.log('warn', `${this.who()} sent unknown opcode 0x${frame.opcode.toString(16)}; ignored`);
            this.sendError(F.ERR.UNKNOWN_OPCODE, `unknown opcode 0x${frame.opcode.toString(16)}`);
        }
    }

    who() {
        return this.name || (this.info && this.info.id) || 'unregistered pico';
    }
}

module.exports = { PicoSession, SERIAL_ID };
