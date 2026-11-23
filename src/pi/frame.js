// Wire protocol v1 codec. The contract is docs/protocol.md.
//
// Pure functions, no I/O: everything here is testable without a Pico, a Pi, or
// a socket. PtyServer.js owns the socket and feeds bytes through a Decoder.
// Mirrors src/pico/frame.py byte for byte; interop.test.js proves it.

const MAGIC = 0x7e;
const VERSION = 1;
const HEADER_LEN = 7;   // MAGIC VER OPCODE SEQ(2) LEN(2)
const CRC_LEN = 2;
const MAX_PAYLOAD = 1024;
const MAX_FRAME = HEADER_LEN + MAX_PAYLOAD + CRC_LEN;
const MAX_SEQ = 0xffff;

// Every opcode the project will need, assigned now (see the spec).
const OPCODE = Object.freeze({
    REGISTER: 0x01,
    REGISTER_ACK: 0x02,
    PING: 0x03,
    PONG: 0x04,
    ERROR: 0x05,
    DATA: 0x10,
    AUTH_CHALLENGE: 0x20,
    AUTH_RESPONSE: 0x21,
    CONTROL_REQUEST: 0x30,
    CONTROL_RESPONSE: 0x31,
    UPDATE_OFFER: 0x40,
    UPDATE_CHUNK: 0x41,
    UPDATE_RESULT: 0x42,
});

const OPCODE_NAME = Object.freeze(Object.fromEntries(
    Object.entries(OPCODE).map(([name, code]) => [code, name])
));

// ERROR payload codes.
const ERR = Object.freeze({
    VERSION: 1,
    UNKNOWN_OPCODE: 2,
    BAD_PAYLOAD: 3,
    NOT_REGISTERED: 4,
    REFUSED: 5,
});

// CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final XOR.
function crc16(buf) {
    let crc = 0xffff;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i] << 8;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
        }
    }
    return crc;
}

// Build one frame. Returns a Buffer ready for socket.write().
function encode(opcode, seq, payload = Buffer.alloc(0)) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    if (!Number.isInteger(opcode) || opcode < 0 || opcode > 0xff) {
        throw new RangeError(`opcode must be a byte, got ${opcode}`);
    }
    if (!Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) {
        throw new RangeError(`seq must be 0..${MAX_SEQ}, got ${seq}`);
    }
    if (body.length > MAX_PAYLOAD) {
        throw new RangeError(`payload ${body.length} exceeds MAX_PAYLOAD ${MAX_PAYLOAD}`);
    }
    const frame = Buffer.alloc(HEADER_LEN + body.length + CRC_LEN);
    frame[0] = MAGIC;
    frame[1] = VERSION;
    frame[2] = opcode;
    frame.writeUInt16BE(seq, 3);
    frame.writeUInt16BE(body.length, 5);
    body.copy(frame, HEADER_LEN);
    // CRC covers VER through the end of PAYLOAD. MAGIC is constant.
    frame.writeUInt16BE(crc16(frame.subarray(1, HEADER_LEN + body.length)), HEADER_LEN + body.length);
    return frame;
}

// Frame whose payload is a UTF-8 JSON object (REGISTER, ERROR, ...).
function encodeJson(opcode, seq, obj) {
    return encode(opcode, seq, Buffer.from(JSON.stringify(obj), 'utf8'));
}

// Parse a JSON payload. Returns null, never throws, if it is not a JSON object.
function decodeJson(payload) {
    try {
        const obj = JSON.parse(payload.toString('utf8'));
        return (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) ? obj : null;
    } catch {
        return null;
    }
}

// Pull every complete frame out of buf.
//
// Returns { frames, remainder, errors }. remainder MUST be prepended to the
// next chunk read from the socket: TCP splits and coalesces freely. errors is
// a list of { kind, detail }, one per resynchronisation:
//   desync   detail = bytes skipped to reach the next MAGIC
//   length   detail = claimed LEN > MAX_PAYLOAD, this MAGIC was data
//   crc      detail = received CRC value
//   version  detail = unsupported VER (whole frame consumed; answer ERROR 1)
function decode(buf) {
    const frames = [];
    const errors = [];
    let offset = 0;
    const end = buf.length;

    while (offset < end) {
        if (buf[offset] !== MAGIC) {
            const next = buf.indexOf(MAGIC, offset + 1);
            if (next === -1) {
                errors.push({ kind: 'desync', detail: end - offset });
                return { frames, remainder: Buffer.alloc(0), errors };
            }
            errors.push({ kind: 'desync', detail: next - offset });
            offset = next;
            continue;
        }
        if (end - offset < HEADER_LEN) break;   // header still arriving

        const version = buf[offset + 1];
        const opcode = buf[offset + 2];
        const seq = buf.readUInt16BE(offset + 3);
        const length = buf.readUInt16BE(offset + 5);

        if (length > MAX_PAYLOAD) {
            // No sender ever produces this, so this MAGIC was payload data.
            errors.push({ kind: 'length', detail: length });
            offset += 1;
            continue;
        }
        const total = HEADER_LEN + length + CRC_LEN;
        if (end - offset < total) break;         // frame still arriving

        const expected = crc16(buf.subarray(offset + 1, offset + HEADER_LEN + length));
        const actual = buf.readUInt16BE(offset + HEADER_LEN + length);
        if (expected !== actual) {
            errors.push({ kind: 'crc', detail: actual });
            offset += 1;
            continue;
        }
        if (version !== VERSION) {
            errors.push({ kind: 'version', detail: version });
            offset += total;
            continue;
        }
        frames.push({
            version,
            opcode,
            seq,
            payload: Buffer.from(buf.subarray(offset + HEADER_LEN, offset + HEADER_LEN + length)),
        });
        offset += total;
    }
    return { frames, remainder: Buffer.from(buf.subarray(offset)), errors };
}

// Stateful wrapper around decode() for one TCP connection. Keeps the
// unconsumed tail between reads and counts resyncs.
class Decoder {
    constructor() {
        this.tail = Buffer.alloc(0);
        this.resyncs = 0;
        this.versionErrors = 0;
    }

    // Add bytes from the socket; return the complete frames now available.
    feed(chunk) {
        const { frames, remainder, errors } = decode(Buffer.concat([this.tail, chunk]));
        this.tail = remainder;
        for (const { kind } of errors) {
            if (kind === 'version') this.versionErrors += 1;
            else this.resyncs += 1;
        }
        if (this.tail.length > MAX_FRAME) {
            // A MAGIC-led tail this long would have been decoded or rejected;
            // this is noise.
            this.resyncs += 1;
            this.tail = Buffer.alloc(0);
        }
        return frames;
    }

    get pending() { return this.tail.length; }
}

// Per-direction counter that wraps at MAX_SEQ, as the spec requires.
class Sequencer {
    constructor() { this.seq = 0; }
    next() {
        const current = this.seq;
        this.seq = (this.seq + 1) & MAX_SEQ;
        return current;
    }
}

module.exports = {
    MAGIC, VERSION, HEADER_LEN, CRC_LEN, MAX_PAYLOAD, MAX_FRAME, MAX_SEQ,
    OPCODE, OPCODE_NAME, ERR,
    crc16, encode, encodeJson, decode, decodeJson, Decoder, Sequencer,
};
