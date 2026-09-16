const test = require('node:test');
const assert = require('node:assert');
const F = require('./frame.js');

function corrupt(buf, index, xor = 0xff) {
    const out = Buffer.from(buf);
    out[index] ^= xor;
    return out;
}

function withVersion(frameBuf, version) {
    const out = Buffer.from(frameBuf);
    out[1] = version;
    out.writeUInt16BE(F.crc16(out.subarray(1, out.length - 2)), out.length - 2);
    return out;
}

test('crc16: published CCITT-FALSE check value', () => {
    // If this fails, frame.js and frame.py cannot possibly agree.
    assert.strictEqual(F.crc16(Buffer.from('123456789')), 0x29b1);
    assert.strictEqual(F.crc16(Buffer.alloc(0)), 0xffff);
});

test('encode: PING is exactly nine bytes laid out per spec', () => {
    const ping = F.encode(F.OPCODE.PING, 0x0102);
    assert.strictEqual(ping.length, 9);
    assert.deepStrictEqual([...ping.subarray(0, 7)], [0x7e, 1, F.OPCODE.PING, 0x01, 0x02, 0, 0]);
    assert.strictEqual(ping.readUInt16BE(7), F.crc16(ping.subarray(1, 7)));
});

test('encode: crc excludes MAGIC, covers header and payload', () => {
    const fr = F.encode(F.OPCODE.DATA, 7, 'hello');
    assert.strictEqual(fr.readUInt16BE(fr.length - 2), F.crc16(fr.subarray(1, fr.length - 2)));
});

test('encode: payload may contain MAGIC and the word PING', () => {
    const payload = Buffer.from([0x7e, 0x50, 0x49, 0x4e, 0x47, 0x7e, 0x7e]);   // \x7ePING\x7e\x7e
    const { frames, remainder, errors } = F.decode(F.encode(F.OPCODE.DATA, 1, payload));
    assert.deepStrictEqual(frames[0].payload, payload);
    assert.strictEqual(remainder.length, 0);
    assert.deepStrictEqual(errors, []);
});

test('encode: limits', () => {
    F.encode(F.OPCODE.DATA, 0, Buffer.alloc(F.MAX_PAYLOAD));
    assert.throws(() => F.encode(F.OPCODE.DATA, 0, Buffer.alloc(F.MAX_PAYLOAD + 1)), RangeError);
    assert.throws(() => F.encode(0x100, 0), RangeError);
    assert.throws(() => F.encode(F.OPCODE.PING, F.MAX_SEQ + 1), RangeError);
});

test('decode: round trip', () => {
    const fr = F.encode(F.OPCODE.REGISTER, 0xbeef, '{"id":"e6614103e71d2c2f"}');
    const { frames, remainder, errors } = F.decode(fr);
    assert.deepStrictEqual(frames, [{ version: 1, opcode: F.OPCODE.REGISTER, seq: 0xbeef, payload: Buffer.from('{"id":"e6614103e71d2c2f"}') }]);
    assert.strictEqual(remainder.length, 0);
    assert.deepStrictEqual(errors, []);
});

test('decode: two frames coalesced in one read', () => {
    const buf = Buffer.concat([F.encode(F.OPCODE.PONG, 1), F.encode(F.OPCODE.DATA, 2, 'MECHO_50')]);
    const { frames, errors } = F.decode(buf);
    assert.deepStrictEqual(frames.map(f => f.opcode), [F.OPCODE.PONG, F.OPCODE.DATA]);
    assert.deepStrictEqual(errors, []);
});

test('decode: frame split at every position is held back then completed', () => {
    const fr = F.encode(F.OPCODE.DATA, 3, '#255.102.255.A=UP');
    for (let cut = 1; cut < fr.length; cut++) {
        const first = F.decode(fr.subarray(0, cut));
        assert.deepStrictEqual(first.frames, [], `cut ${cut}`);
        assert.deepStrictEqual(first.errors, [], `cut ${cut}`);
        assert.deepStrictEqual(first.remainder, fr.subarray(0, cut), `cut ${cut}`);
        const second = F.decode(Buffer.concat([first.remainder, fr.subarray(cut)]));
        assert.strictEqual(second.frames[0].payload.toString(), '#255.102.255.A=UP', `cut ${cut}`);
        assert.strictEqual(second.remainder.length, 0, `cut ${cut}`);
    }
});

test('decode: garbage before a frame is skipped and counted', () => {
    const { frames, errors } = F.decode(Buffer.concat([Buffer.from('\x00\x01noise', 'latin1'), F.encode(F.OPCODE.PING, 9)]));
    assert.strictEqual(frames[0].opcode, F.OPCODE.PING);
    assert.deepStrictEqual(errors, [{ kind: 'desync', detail: 7 }]);
});

test('decode: garbage with no MAGIC at all is dropped', () => {
    const { frames, remainder, errors } = F.decode(Buffer.from('just noise'));
    assert.deepStrictEqual(frames, []);
    assert.strictEqual(remainder.length, 0);
    assert.deepStrictEqual(errors, [{ kind: 'desync', detail: 10 }]);
});

test('decode: crc mismatch resyncs and does not yield the frame', () => {
    const bad = corrupt(F.encode(F.OPCODE.DATA, 5, 'abc'), F.HEADER_LEN);
    const { frames, errors } = F.decode(Buffer.concat([bad, F.encode(F.OPCODE.PING, 6)]));
    assert.deepStrictEqual(frames.map(f => f.opcode), [F.OPCODE.PING]);
    assert.strictEqual(errors[0].kind, 'crc');
});

test('decode: corrupted LEN never makes the decoder wait forever', () => {
    const bad = corrupt(F.encode(F.OPCODE.DATA, 5, 'abc'), 5, 0xff);   // high LEN byte -> 0xFF03
    const { frames, errors } = F.decode(Buffer.concat([bad, F.encode(F.OPCODE.PING, 6)]));
    assert.deepStrictEqual(frames.map(f => f.opcode), [F.OPCODE.PING]);
    assert.deepStrictEqual(errors[0], { kind: 'length', detail: 0xff03 });
});

test('decode: unsupported version is consumed whole and reported', () => {
    const v2 = withVersion(F.encode(F.OPCODE.DATA, 1, 'abc'), 2);
    const { frames, remainder, errors } = F.decode(Buffer.concat([v2, F.encode(F.OPCODE.PING, 2)]));
    assert.deepStrictEqual(frames.map(f => f.opcode), [F.OPCODE.PING]);
    assert.deepStrictEqual(errors, [{ kind: 'version', detail: 2 }]);
    assert.strictEqual(remainder.length, 0);
});

test('decode: MAGIC inside a payload does not confuse the scanner', () => {
    const buf = Buffer.concat([F.encode(F.OPCODE.DATA, 1, Buffer.alloc(20, 0x7e)), F.encode(F.OPCODE.PING, 2)]);
    const { frames, errors } = F.decode(buf);
    assert.deepStrictEqual(frames.map(f => f.opcode), [F.OPCODE.DATA, F.OPCODE.PING]);
    assert.deepStrictEqual(errors, []);
});

test('Decoder: reassembles across feeds and counts resyncs', () => {
    const d = new F.Decoder();
    const fr = F.encode(F.OPCODE.DATA, 1, 'MECHO_50');
    assert.deepStrictEqual(d.feed(Buffer.concat([Buffer.from('zz'), fr.subarray(0, 4)])), []);
    assert.strictEqual(d.pending, 4);
    const got = d.feed(fr.subarray(4));
    assert.strictEqual(got[0].payload.toString(), 'MECHO_50');
    assert.strictEqual(d.pending, 0);
    assert.strictEqual(d.resyncs, 1);
    assert.strictEqual(d.versionErrors, 0);
});

test('Decoder: byte at a time delivery', () => {
    const d = new F.Decoder();
    const fr = F.encode(F.OPCODE.REGISTER_ACK, 4, '{"ok":true}');
    const got = [];
    for (let i = 0; i < fr.length; i++) got.push(...d.feed(fr.subarray(i, i + 1)));
    assert.deepStrictEqual(got, [{ version: 1, opcode: F.OPCODE.REGISTER_ACK, seq: 4, payload: Buffer.from('{"ok":true}') }]);
});

test('Decoder: version error counted separately', () => {
    const d = new F.Decoder();
    assert.deepStrictEqual(d.feed(withVersion(F.encode(F.OPCODE.PING, 0), 2)), []);
    assert.strictEqual(d.versionErrors, 1);
    assert.strictEqual(d.resyncs, 0);
});

test('JSON payloads: register round trip, decodeJson never throws', () => {
    const reg = { id: 'e6614103e71d2c2f', fw: '1.4.0', hash: '3b0c44298fc1c149' };
    const { frames } = F.decode(F.encodeJson(F.OPCODE.REGISTER, 0, reg));
    assert.deepStrictEqual(F.decodeJson(frames[0].payload), reg);
    for (const bad of ['', 'not json', '[1,2]', '"str"', '\xff\xfe']) {
        assert.strictEqual(F.decodeJson(Buffer.from(bad, 'latin1')), null, JSON.stringify(bad));
    }
});

test('Sequencer: starts at zero, increments, wraps', () => {
    const s = new F.Sequencer();
    assert.deepStrictEqual([s.next(), s.next(), s.next()], [0, 1, 2]);
    s.seq = F.MAX_SEQ;
    assert.strictEqual(s.next(), F.MAX_SEQ);
    assert.strictEqual(s.next(), 0);
});

test('opcodes: values are exactly the spec table, nothing in the crypto range', () => {
    assert.deepStrictEqual(F.OPCODE, {
        REGISTER: 0x01, REGISTER_ACK: 0x02, PING: 0x03, PONG: 0x04, ERROR: 0x05, DATA: 0x10,
        AUTH_CHALLENGE: 0x20, AUTH_RESPONSE: 0x21,
        CONTROL_REQUEST: 0x30, CONTROL_RESPONSE: 0x31,
        UPDATE_OFFER: 0x40, UPDATE_CHUNK: 0x41, UPDATE_RESULT: 0x42,
    });
    assert.ok(!Object.values(F.OPCODE).some(op => op >= 0x50 && op <= 0x5f));
    assert.strictEqual(F.OPCODE_NAME[0x10], 'DATA');
});
