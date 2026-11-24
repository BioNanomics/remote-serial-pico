# Pico Wire Protocol v1

This is the contract between `src/pico/main.py` (MicroPython, on the board) and
`src/pi/PtyServer.js` (Node, on the Pi). Two codebases, two languages, two
machines: if they disagree on one byte, blinds stop moving. Every change to
this file is a physical visit to every Pico in the building, so the frame
layout below is frozen. Only payload contents of not-yet-implemented opcodes
may still be filled in.

Every byte between a Pico and `PtyServer` travels inside a frame. There is no
unframed mode: the first byte a Pico ever sends is `0x7E`. There is no
unauthenticated mode either: a board gets nothing until it has proved it holds
its device key, and from then on every frame carries an authentication tag
(see "Authentication").

**Status.** The frame layout has not changed since it was first written down.
Authentication was specified (this revision) before any board was flashed with
v1, in response to the review on issue #19 (finding S6), so `VER` is still 1.
Nothing here has run on a physical board yet; until it has, treat "frozen" as
"frozen pending the bench test".

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
| `0x20` | `AUTH_CHALLENGE` | Pi → Pico | bytes: 32-byte server nonce | D |
| `0x21` | `AUTH_RESPONSE` | Pico → Pi | bytes: 32-byte Pico nonce + 32-byte HMAC-SHA256 proof | D |
| `0x30` | `CONTROL_REQUEST` | Pi → Pico | JSON `{"cmd": str, "args": {...}}` | E |
| `0x31` | `CONTROL_RESPONSE` | Pico → Pi | JSON `{"ok": bool, "result": {...}}` | E |
| `0x40` | `UPDATE_OFFER` | Pi → Pico | JSON `{"len": int, "sha256": hex}` | F |
| `0x41` | `UPDATE_CHUNK` | Pi → Pico | bytes: 4-byte BE offset + data | F |
| `0x42` | `UPDATE_RESULT` | Pico → Pi | JSON `{"ok": bool, "msg": str}` | F |
| `0x50`–`0x5F` | reserved | | encryption negotiation, do not assign | G |

Codes not in this table are invalid. A receiver that sees one replies `ERROR`
code 2 and ignores the frame.

The payloads in this table are what a frame carries *before* its
authentication tag. Once the handshake is done, 16 more bytes follow every
payload (see "Authentication"), and `LEN` counts them.

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
* `hash` the first 16 hex characters of SHA-256 over the **whole deployed
  firmware**: `firmware.json`, then each file it lists, in order, each
  contributing its name, a zero byte, its contents and a zero byte. `main.py`
  imports the other files, so a hash of `main.py` alone could not see a change
  in them. The Pi computes the same value over its own copy of `src/pico`.

`REGISTER` is a claim, not proof: the Pi does nothing with it except look up
the device key for `id` and send a challenge. No pty is allocated and nothing
is written to `PicoSerialMap` until the board has authenticated.

Once it has, `PtyServer` logs all three values. That satisfies the issue's
robustness acceptance criterion "every board reports a firmware version".

**Firmware mismatch.** If `hash` is not the hash of the firmware this Pi would
deploy, the board is refused (`REGISTER_ACK` with `ok` false, reason
`firmware mismatch`) and stays refused until it is plugged into the Pi again,
which redeploys it. `FirmwareMismatch: warn` in `config.yaml` serves it and
logs a warning instead. The check happens after authentication, so only a
genuine board can be told anything about firmware. Phase F will replace the
refusal with an update.

A protocol version mismatch is always refused: see "Version mismatch" under
"Framing rules".

### REGISTER_ACK

The Pi's reply, sent before any `DATA`. Payload:

```json
{"ok": true, "name": "office-north", "time": 1757980000}
```

* `ok` false means the registration was refused. `name` is then absent and
  `reason` holds a short string: `malformed registration`, `unknown device`
  (no key on record for that id), `authentication failed`, or
  `firmware mismatch`. The Pi closes the connection afterwards, and the Pico
  waits 30 s before trying again.
* `name` the human name from `PicoSerialMap`, or the serial id if unmapped.
* `time` Pi's Unix time in seconds, so a Pico with no RTC can timestamp logs.

Until the Pico has received `REGISTER_ACK` with `ok` true it MUST NOT send
`DATA` or `PING`, and the Pi answers anything but the handshake opcodes with
`ERROR` code 4. `AUTH_CHALLENGE` and `AUTH_RESPONSE` always come between
`REGISTER` and a successful `REGISTER_ACK`.

A `REGISTER_ACK` with `ok` true is only valid with a correct authentication
tag. A Pico that receives one without it MUST close the connection and MUST
NOT treat itself as registered.

## Authentication

Every board has its own 256-bit **device key**. `PicoScriptDeployer.py`
generates it from the kernel's random source when the board is plugged into
the Pi's USB port, writes it into the board's `config.json` as `KEY`, and
records it in `PicoSecrets` (mode `0600`, owned by the service user). USB
provisioning is the trusted path and the only moment a secret can be handed
over safely. The key is never derived from the serial id (which is in USB
descriptors, logs and symlink names) or from the WiFi password, it is
different for every board so one opened board is not the building, and it is
never logged. Plugging a board in again replaces its key, which is how a key
is rotated.

The key is plaintext on the board's filesystem. Anyone who can plug the board
into a computer and open a REPL can read it. Physical access is out of scope;
the aim is that a network attacker cannot impersonate a board or the Pi, and
that one stolen board exposes one key.

### Handshake

```
Pico                                             Pi
  REGISTER {id, fw, hash}             ----->
                                      <-----     AUTH_CHALLENGE  Ns (32 random bytes)
  AUTH_RESPONSE  Np || proof          ----->
                                                 verifies proof; derives session keys
                                      <-----     REGISTER_ACK {ok, name, time} + tag
  verifies the tag; registered
  every later frame, both ways, carries a tag
```

With `K` the device key, `id` the 16-character serial id as ASCII, `Ns` the
Pi's nonce, `Np` the Pico's nonce (32 random bytes, fresh for every
connection), and `HMAC` meaning HMAC-SHA256:

```
proof      = HMAC(K, "rsp1 pico proof"    || 0x00 || Ns || Np || id)
K_pico->pi = HMAC(K, "rsp1 key pico->pi"  || 0x00 || Ns || Np || id)
K_pi->pico = HMAC(K, "rsp1 key pi->pico"  || 0x00 || Ns || Np || id)
```

* The Pi compares `proof` in constant time. A wrong proof, a response of the
  wrong length, or an id with no key on record is refused and logged. `Ns` is
  fresh, so a recorded `AUTH_RESPONSE` is useless on any later connection.
* The handshake is **mutual**. The Pi never sends a proof of its own; instead
  its `REGISTER_ACK` is the first frame tagged with `K_pi->pico`, which only
  a holder of `K` can compute for this `Np`. A server that does not hold the
  key cannot produce an ack the Pico will accept, so it cannot register a
  board, send it `DATA`, or (Phase F) offer it firmware.
* The two session keys exist for one connection only and differ per
  direction, so a frame cannot be reflected back at its sender or replayed
  into a later connection.
* The Pi closes a connection that has not completed the handshake within
  10 s.

`REGISTER`, `AUTH_CHALLENGE`, `AUTH_RESPONSE`, a refusing `REGISTER_ACK` sent
before the Pi has verified the proof, and any `ERROR` sent before the
handshake completes are the only frames ever sent without a tag.

### Frame tags

After the handshake every frame's payload is followed by a 16-byte tag, and
`LEN` covers both:

```
tag = first 16 bytes of HMAC(K_direction, counter || OPCODE || payload)
```

`counter` is a 64-bit big-endian integer, one per direction, starting at 0
with the first tagged frame of the connection (the Pi's `REGISTER_ACK`, the
Pico's first frame after `AUTH_RESPONSE`) and incremented by one per tagged
frame. It is **never transmitted**: both ends count. TCP delivers in order, so
a receiver accepts exactly the next counter value and nothing else.

A receiver that gets a frame whose tag does not verify (altered, injected,
replayed, dropped or reordered, or too short to hold a tag) MUST discard it
without acting on it and close the connection. It does not send an `ERROR`.
The Pico then reconnects and authenticates again from scratch.

Because of the tag, the largest `DATA` payload a sender produces is
`MAX_PAYLOAD - 16` = 1008 bytes; longer data is split across frames.

CRC-16 detects line noise. It was never meant to stop tampering, and anyone
who alters a frame can recompute it. The tag is what makes a frame trustworthy.

This covers every opcode, including the ones not implemented yet:
`CONTROL_REQUEST` (Phase E) and `UPDATE_OFFER` / `UPDATE_CHUNK` (Phase F) are
only acted on if their tag verifies, so a control command or a firmware image
is accepted only from the holder of this board's key. That is what meets the
issue's "authentication before OTA" rule. Encryption (Phase G) is a separate
matter: tags give integrity and authenticity, not confidentiality.

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
A receiver MUST accept any `SEQ` value and MAY log a gap. `SEQ` is 16 bits
and travels in the clear, so it is a diagnostic and, in Phase F, an ordering
aid for `UPDATE_CHUNK`s. It is **not** what rejects replays: that is the
64-bit counter inside the frame tag, which does not wrap within the life of a
connection and cannot be chosen by a sender who does not hold the key.

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
  <- AUTH_CHALLENGE                answer with AUTH_RESPONSE, derive session keys
  <- REGISTER_ACK ok=true + tag    refused, or ok=true without a valid tag:
                                   log reason, close, back off
  loop (every frame tagged; a bad tag closes the connection):
     UART bytes available     -> send DATA
     DATA received            -> write payload to UART
     every 10 s               -> send PING, expect PONG
     CONTROL_REQUEST received -> act, send CONTROL_RESPONSE   (Phase E)
     UPDATE_* received        -> stage, verify, reply         (Phase F)
     anything else            -> ERROR code 2, keep going
```

## No legacy mode

The v0 protocol (bare `pico_<id>`) is not accepted. A connection that does
not open with a v1 `REGISTER` and complete the handshake gets no pty, no entry
in `PicoSerialMap` and no reply, and is closed after 10 s. An earlier revision
of the server carried a `LegacySession` and an `AcceptLegacyPicos` switch to
serve v0 boards during a changeover; it was removed because any
unauthenticated path defeats authentication for every board, and the issue
this work belongs to says so in as many words ("there is no legacy mode to
support; do not build one").

The consequence for an existing installation: installing this server stops
serving boards that run older firmware, and boards that have no device key.
Each one comes back when it is plugged into the Pi's USB port once, which
deploys the current firmware and gives it a key.

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
| Pico authentication | `src/pico/auth.py` | `src/pico/test_auth.py` |
| Pi authentication | `src/pi/auth.js` | `src/pi/session.test.js` |
| Cross-check | both | `src/pi/interop.test.js`: frames encoded in JS and decoded in Python; proof, session keys, frame tags and firmware hash computed on both sides and compared, under CPython and MicroPython |
| Key provisioning | `src/pi/PicoScriptDeployer.py` | `src/pi/test_PicoScriptDeployer.py` |
| Key store, firmware hash | `src/pi/runtime.js` | `src/pi/runtime.test.js` |
| Server | `src/pi/PtyServer.js` | `src/pi/session.test.js` (the protocol logic lives in `session.js`) |
| Firmware protocol logic | `src/pico/net_util.py` (`PicoLink`) | `src/pico/test_net_util.py` |
| Firmware | `src/pico/main.py` | `src/pi/firmware.sim.test.js` runs the real `main.py` on a desktop, via `tools/pico_sim/`, against a `PicoSession` |

The desktop simulation swaps in stand-ins for MicroPython's `machine` and
`network` modules only; sockets, `select.poll`, framing, authentication,
registration, relay and reconnect all run unmodified. What it cannot prove is MicroPython's own
socket and poll behaviour on a Pico W: that needs a board.
