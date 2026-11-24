'use strict';
// Device authentication for wire protocol v1. The contract is
// docs/protocol.md, "Authentication". Mirrors src/pico/auth.py;
// interop.test.js proves the two agree byte for byte.
//
// Pure functions over Buffers, no I/O.

const crypto = require('crypto');

const KEY_LEN = 32;      // the per-device secret, 256 bits
const NONCE_LEN = 32;
const TAG_LEN = 16;      // bytes of HMAC-SHA256 appended to every frame after the handshake

const LABEL_PICO_PROOF = 'rsp1 pico proof';
const LABEL_KEY_PICO_TO_PI = 'rsp1 key pico->pi';
const LABEL_KEY_PI_TO_PICO = 'rsp1 key pi->pico';

function hmac(key, msg) {
    return crypto.createHmac('sha256', key).update(msg).digest();
}

function transcript(label, serverNonce, picoNonce, picoId) {
    return Buffer.concat([Buffer.from(label), Buffer.from([0]), serverNonce, picoNonce, Buffer.from(picoId)]);
}

// What the Pico sends to show it holds the device key.
function picoProof(key, serverNonce, picoNonce, picoId) {
    return hmac(key, transcript(LABEL_PICO_PROOF, serverNonce, picoNonce, picoId));
}

// Keys for this one connection, one per direction.
function sessionKeys(key, serverNonce, picoNonce, picoId) {
    return {
        picoToPi: hmac(key, transcript(LABEL_KEY_PICO_TO_PI, serverNonce, picoNonce, picoId)),
        piToPico: hmac(key, transcript(LABEL_KEY_PI_TO_PICO, serverNonce, picoNonce, picoId)),
    };
}

// The tag for the counter-th authenticated frame in one direction. The 64-bit
// counter is never sent: both ends count, so a replayed, dropped, reordered or
// altered frame fails the check.
function frameTag(sessionKey, counter, opcode, body) {
    const head = Buffer.alloc(9);
    head.writeBigUInt64BE(BigInt(counter), 0);
    head[8] = opcode & 0xff;
    return hmac(sessionKey, Buffer.concat([head, body])).subarray(0, TAG_LEN);
}

function equal(a, b) {
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// One direction of an authenticated connection: appends or checks tags.
class Tagger {
    constructor(sessionKey) {
        this.key = sessionKey;
        this.counter = 0n;
    }

    seal(opcode, body) {
        const tagged = Buffer.concat([body, frameTag(this.key, this.counter, opcode, body)]);
        this.counter += 1n;
        return tagged;
    }

    // The body if the tag is right, else null. The counter only advances on success.
    open(opcode, payload) {
        if (payload.length < TAG_LEN) return null;
        const body = payload.subarray(0, payload.length - TAG_LEN);
        if (!equal(frameTag(this.key, this.counter, opcode, body), payload.subarray(payload.length - TAG_LEN))) return null;
        this.counter += 1n;
        return body;
    }
}

module.exports = {
    KEY_LEN, NONCE_LEN, TAG_LEN, picoProof, sessionKeys, frameTag, equal, Tagger,
};
