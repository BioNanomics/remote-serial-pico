# Pico Wire Protocol v1

This is the contract between `src/pico/main.py` (MicroPython, on the board) and
`src/pi/PtyServer.js` (Node, on the Pi). Two codebases, two languages, two
machines: if they disagree on one byte, blinds stop moving. Every change to
this file is a physical visit to every Pico in the building, so the frame
layout below is frozen. Only payload contents of not-yet-implemented opcodes
may still be filled in.

Every byte between a Pico and `PtyServer` travels inside a frame. There is no
unframed mode: the first byte a Pico ever sends is `0x7E`.

This replaces the v0 protocol (bare `pico_<id>` / `PING` / raw device bytes),
which had no delimiters and therefore could not tell device data apart from
protocol traffic. See "Why framing" at the end.

## Frame layout

```
 0      1      2       3     4      5     6      7          7+LEN
 +------+------+-------+-----+-----+-----+-----+-----------+-------+
 |MAGIC | VER  |OPCODE |    SEQ    |    LEN    |  PAYLOAD  | CRC16 |
 | 0x7E | 0x01 |  1 B  |   2 B BE  |   2 B BE  |   LEN B   | 2B BE |
 +------+------+-------+-----+-----+-----+-----+-----------+-------+
```

* **MAGIC** `0x7E`. Start-of-frame marker, used to resynchronise after corruption.
* **VER** protocol version, `0x01`. A receiver MUST reject a frame whose version
  it does not implement rather than guess at the layout (see `ERROR`).
* **OPCODE** see the table below.
* **SEQ** big-endian, increments by one per frame sent, wraps from `0xFFFF` to
  `0x0000`. One independent counter per direction, starting at 0 on each new
  TCP connection.
* **LEN** big-endian payload length, 0 to 1024 (`MAX_PAYLOAD`). The cap bounds
  the buffer a Pico must hold in its 264 KB of RAM.
* **CRC16** big-endian CRC-16/CCITT-FALSE (polynomial `0x1021`, initial value
  `0xFFFF`, no reflection, no final XOR) over **VER through the end of
  PAYLOAD**. MAGIC and the CRC field itself are excluded. MAGIC is a constant,
  so covering it would add nothing.

Fixed overhead is 9 bytes per frame. All multi-byte integers are big-endian.

## Opcodes

Every opcode the project will ever need is assigned here, including ones whose
phase has not started, so later phases never touch the frame layout. Payloads
marked *JSON* are a UTF-8 encoded JSON object. Payloads marked *bytes* are
opaque.

| Code | Name | Direction | Payload | Phase |
| --- | --- | --- | --- | --- |
| `0x01` | `REGISTER` | Pico → Pi | JSON, see below | B |
| `0x02` | `REGISTER_ACK` | Pi → Pico | JSON, see below | B |
| `0x03` | `PING` | either | empty | B |
| `0x04` | `PONG` | either | empty | B |
| `0x05` | `ERROR` | either | JSON `{"code": int, "msg": str}` | B |
| `0x10` | `DATA` | either | bytes: raw UART traffic | B |
| `0x20` | `AUTH_CHALLENGE` | Pi → Pico | bytes: 32-byte nonce | D |
| `0x21` | `AUTH_RESPONSE` | Pico → Pi | bytes: 32-byte HMAC-SHA256 | D |
| `0x30` | `CONTROL_REQUEST` | Pi → Pico | JSON `{"cmd": str, "args": {...}}` | E |
| `0x31` | `CONTROL_RESPONSE` | Pico → Pi | JSON `{"ok": bool, "result": {...}}` | E |
| `0x40` | `UPDATE_OFFER` | Pi → Pico | JSON `{"len": int, "sha256": hex}` | F |
| `0x41` | `UPDATE_CHUNK` | Pi → Pico | bytes: 4-byte BE offset + data | F |
| `0x42` | `UPDATE_RESULT` | Pico → Pi | JSON `{"ok": bool, "msg": str}` | F |
| `0x50`–`0x5F` | reserved | | encryption negotiation, do not assign | G |

Codes not in this table are invalid. A receiver that sees one replies `ERROR`
code 2 and ignores the frame.

`DATA` payloads are **opaque**. The framing layer never inspects them, so a
payload may legally contain `0x7E`, the bytes `PING`, or any other sequence.
A `DATA` frame from the Pico carries bytes the serial device sent; a `DATA`
frame from the Pi carries bytes for the serial device.

### The data path rule

Only `DATA` payloads ever reach the UART on the Pico or the pty on the Pi.
Every other opcode is protocol traffic and is consumed by the firmware or by
`PtyServer` itself. This is what makes the pty byte-transparent and what
guarantees a control command can never be relayed to a blind as if the device
had said it. Both codecs enforce this by type: a decoded frame that is not
`DATA` is never handed to the relay code.

### REGISTER

Sent by the Pico as the first frame on every TCP connection. Payload:

```json
{"id": "e6614103e71d2c2f", "fw": "1.4.0", "hash": "3b0c44298fc1c149"}
```

* `id` the board's unique serial id, 16 lowercase hex characters. Same value
  as the old `pico_<id>` registration, so `PicoSerialMap` needs no migration.
* `fw` the firmware's own version string, from `FIRMWARE_VERSION` in
  `main.py`. Human readable, for logs and `remote-serial-pico status`.
* `hash` the first 16 hex characters of SHA-256 over the deployed `main.py`.
  What Phase F compares against the canonical file in git.

`PtyServer` logs all three on every registration. That satisfies the issue's
robustness acceptance criterion "every board reports a firmware version".

### REGISTER_ACK

The Pi's reply, sent before any `DATA`. Payload:

```json
{"ok": true, "name": "office-north", "time": 1757980000}
```

* `ok` false means the registration was refused. `name` is then absent and
  `reason` holds a short string. The Pi closes the connection afterwards.
* `name` the human name from `PicoSerialMap`, or the serial id if unmapped.
* `time` Pi's Unix time in seconds, so a Pico with no RTC can timestamp logs.

Until the Pico has received `REGISTER_ACK` with `ok` true it MUST NOT send
`DATA`, and the Pi discards any `DATA` that arrives before it. Phase D inserts
`AUTH_CHALLENGE`/`AUTH_RESPONSE` between `REGISTER` and `REGISTER_ACK`; the
Pico must therefore be prepared to answer a challenge while waiting for the ack.

### PING / PONG

The Pico sends `PING` every 10 s. The receiver of a `PING` replies `PONG` at
once. Either side may send `PING`; in v1 only the Pico does. Missed-PONG
policy (how many before reconnecting) is the sender's business and not part
of the protocol.

### ERROR

Sent by either side when it cannot act on what it received. It is advisory:
the sender of an `ERROR` decides for itself whether to close the connection.
`code` values:

| Code | Meaning | Typical action |
| --- | --- | --- |
| 1 | unsupported protocol version | close |
| 2 | unknown opcode | ignore the frame |
| 3 | malformed payload for a known opcode | ignore the frame |
| 4 | frame received before registration completed | ignore the frame |
| 5 | registration refused | close (carried in `REGISTER_ACK` too) |

## Sequence numbers

The sender increments `SEQ` on every frame it sends, wrapping at `0xFFFF`.
In v1 a receiver MUST accept any `SEQ` value and MAY log a gap. Phase D adds
replay rejection and Phase F uses `SEQ` to order `UPDATE_CHUNK`s; both rely on
the counter having been there from the first frame, which is why it is not
optional now.

## Framing rules

**No escaping.** The payload is length-prefixed and CRC-checked, so byte
stuffing would only cost Pico RAM and CPU for no benefit.

**Resynchronisation.** A receiver scans forward to the next `MAGIC` when it
sees any of: a byte other than `MAGIC` where a frame should start, `LEN`
greater than `MAX_PAYLOAD`, or a CRC mismatch. It never discards buffered bytes
that could still form a valid frame. Each resync is counted; Phase E's
`status` command reports the count.

**Partial frames.** TCP may split a frame across packets or coalesce several
into one. A decoder consumes whole frames only and returns the unconsumed tail
to be prepended to the next read. A tail longer than one maximum frame
(9 + 1024 bytes) with no `MAGIC` in it is discarded as noise.

**Version mismatch.** A frame with an unknown `VER` is still consumed in full
(its `LEN` and CRC are trusted so the stream stays in sync), then answered
with `ERROR` code 1. The responder then closes.

## Session, from the Pico's side

```
TCP connect
  -> send REGISTER
  <- (Phase D: AUTH_CHALLENGE, answer with AUTH_RESPONSE)
  <- REGISTER_ACK ok=true          otherwise: log reason, close, back off
  loop:
     UART bytes available     -> send DATA
     DATA received            -> write payload to UART
     every 10 s               -> send PING, expect PONG
     CONTROL_REQUEST received -> act, send CONTROL_RESPONSE   (Phase E)
     UPDATE_* received        -> stage, verify, reply         (Phase F)
     anything else            -> ERROR code 2, keep going
```

## Why framing

The v0 protocol sent `pico_<id>`, `PING` and device bytes with no delimiters,
so the receiver had to guess where each ended. Two consequences, both
reproduced against the real server:

1. A device payload containing the bytes `PING` was consumed as a heartbeat.
   The server replied `PONG` into the device's own data stream and dropped the
   surrounding bytes.
2. Registration could coalesce with the first device data, so the server
   parsed part of the payload as the serial id.

Both are structurally impossible in v1: `PING` is opcode `0x03` with an empty
payload, and device bytes only ever appear inside a length-delimited `DATA`
frame.

## Implementation map

| Piece | File | Tests |
| --- | --- | --- |
| Pico codec | `src/pico/frame.py` | `src/pico/test_frame.py` |
| Pi codec | `src/pi/frame.js` | `src/pi/frame.test.js` |
| Cross-check | both | `src/pi/interop.test.js` encodes in JS, decodes in Python |
| Server | `src/pi/PtyServer.js` | |
| Firmware | `src/pico/main.py` | desktop simulation |
