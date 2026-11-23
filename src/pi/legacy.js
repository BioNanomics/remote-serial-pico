// Cutover support: accept boards still running the v0 firmware while the
// building is moved to wire protocol v1, one Pico at a time.
//
// v0 (main before Phase B) sent 'pico_<serialId>', bare 'PING', and device
// bytes with no delimiters at all. v1 puts everything inside frames, and the
// first byte a v1 board ever sends is MAGIC (0x7E). A v0 board's first byte is
// 'p'. That one byte decides which session handles the connection, before
// anything else is parsed. See docs/protocol.md, "Cutover from v0".
//
// LegacySession reproduces the v0 server's behaviour exactly, including its
// quirks (a PONG for every 'PING' substring, '\r' appended to what reaches
// the pty), so a not-yet-redeployed board behaves today as it did yesterday.
// It offers the same hooks and methods as PicoSession so PtyServer.js treats
// the two alike.

const F = require('./frame.js');
const { PicoSession } = require('./session.js');

const REGISTRATION_PATTERN = /^pico_([0-9a-fA-F]{16})/;
const HEARTBEAT = 'PING';

class LegacySession {
    constructor(hooks) {
        this.hooks = hooks;
        this.protocol = 'v0';
        this.name = null;
        this.info = null;
        this.closed = false;
        this.stats = { dataIn: 0, dataOut: 0, pings: 0, dropped: 0 };
    }

    get registered() { return this.name !== null; }

    // Bytes from the pty, bound for the device: v0 relayed them untouched.
    sendData(buf) {
        if (this.closed) return;
        this.hooks.send(buf);
        this.stats.dataOut += 1;
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        this.hooks.close();
    }

    receive(chunk) {
        let message = chunk.toString();

        // Registration: consume only the 'pico_<serialId>' token. Anything
        // after it is device data, not part of the serial id.
        const registration = REGISTRATION_PATTERN.exec(message);
        if (registration) {
            message = message.slice(registration[0].length);
            if (!this.registered) {
                const id = registration[1].toLowerCase();
                this.info = { id, fw: 'v0', hash: 'unknown' };
                this.name = this.hooks.register(id, { fw: 'v0', hash: 'unknown' });
                this.hooks.log('warn', `${this.name} registered with v0 firmware (serial ${id}, no version, no framing); redeploy it before AcceptLegacyPicos is turned off`);
            }
        } else if (message.startsWith('pico_')) {
            this.hooks.log('warn', `ignoring malformed v0 registration packet: ${JSON.stringify(message)}`);
            return 0;
        }

        // Heartbeat: one PONG per PING in the packet, as v0 did.
        const segments = message.split(HEARTBEAT);
        if (segments.length > 1) {
            for (let i = 1; i < segments.length; i++) {
                this.hooks.send(Buffer.from('PONG\n'));
                this.stats.pings += 1;
            }
            message = segments.join('');
        }

        const response = message.trim();
        if (!response) return 1;
        if (!this.registered) {
            this.stats.dropped += 1;
            this.hooks.log('warn', `dropping v0 data from an unregistered board: ${JSON.stringify(response.slice(0, 80))}`);
            return 1;
        }
        // v0's writePicoRespToPty appended '\r'; the shared v1 one writes the
        // payload verbatim, so the terminator is added here instead.
        this.stats.dataIn += 1;
        this.hooks.onData(Buffer.from(response + '\r', 'utf8'));
        return 1;
    }
}

// Pick the session for a new connection from its very first byte.
// Returns null when the board speaks v0 and legacy boards are not accepted.
function sessionFor(firstByte, hooks, { acceptLegacy = true } = {}) {
    if (firstByte === F.MAGIC) {
        const session = new PicoSession(hooks);
        session.protocol = 'v1';
        return session;
    }
    return acceptLegacy ? new LegacySession(hooks) : null;
}

module.exports = { LegacySession, sessionFor, REGISTRATION_PATTERN };
