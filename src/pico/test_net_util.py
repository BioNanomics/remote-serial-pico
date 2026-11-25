"""Run with:  python3 -m unittest discover -s src/pico -p 'test_*.py'"""
import hashlib
import hmac
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import frame as F  # noqa: E402
import auth as A  # noqa: E402
import net_util as N  # noqa: E402


class TestSafeDecode(unittest.TestCase):

    def test_plain_ascii(self):
        self.assertEqual(N.safe_decode(b'MECHO_50'), 'MECHO_50')

    def test_empty_bytes(self):
        self.assertEqual(N.safe_decode(b''), '')

    def test_none_is_empty_string_not_a_crash(self):
        # uart1.read() can return None; the old code called .decode() on it
        # unconditionally and crashed.
        self.assertEqual(N.safe_decode(None), '')

    def test_malformed_byte_does_not_raise_and_keeps_the_rest(self):
        # a single bad byte used to lose (or crash on) the whole chunk
        result = N.safe_decode(b'AA\xffBB')
        self.assertEqual(result, 'AA�BB')
        self.assertIn('AA', result)
        self.assertIn('BB', result)

    def test_truncated_multibyte_sequence(self):
        # a UTF-8 continuation byte with no lead byte
        result = N.safe_decode(b'ok\x80end')
        self.assertIn('ok', result)
        self.assertIn('end', result)


class TestBackoff(unittest.TestCase):

    def test_starts_at_base(self):
        self.assertEqual(N.Backoff(base=3, cap=30).next(), 3)

    def test_doubles_by_default_until_capped(self):
        b = N.Backoff(base=1, cap=10)
        self.assertEqual([b.next() for _ in range(5)], [1, 2, 4, 8, 10])

    def test_stays_at_cap_forever(self):
        b = N.Backoff(base=1, cap=5)
        for _ in range(20):
            b.next()
        self.assertEqual(b.next(), 5)

    def test_reset_goes_back_to_base(self):
        b = N.Backoff(base=2, cap=20)
        b.next(); b.next(); b.next()
        b.reset()
        self.assertEqual(b.next(), 2)

    def test_custom_factor(self):
        b = N.Backoff(base=1, cap=100, factor=3)
        self.assertEqual([b.next() for _ in range(4)], [1, 3, 9, 27])

    def test_rejects_nonsense_config(self):
        with self.assertRaises(ValueError):
            N.Backoff(base=0)
        with self.assertRaises(ValueError):
            N.Backoff(base=1, cap=0)
        with self.assertRaises(ValueError):
            N.Backoff(base=1, factor=1)


class FakeSocket:
    """A socket whose send() accepts at most `chunk` bytes per call, the way a
    real one is allowed to."""

    def __init__(self, chunk):
        self.chunk = chunk
        self.calls = []

    def send(self, data):
        taken = bytes(data[:self.chunk])
        self.calls.append(taken)
        return len(taken)


class TestSendAll(unittest.TestCase):

    def test_everything_goes_in_one_call_when_the_socket_takes_it_all(self):
        sock = FakeSocket(chunk=100)
        self.assertEqual(N.send_all(sock, b'#255.102.255.A=UP'), 17)
        self.assertEqual(sock.calls, [b'#255.102.255.A=UP'])

    def test_a_partial_send_is_followed_up_until_every_byte_is_out(self):
        # the whole point: send() returning less than len(data) used to
        # silently truncate the command
        sock = FakeSocket(chunk=5)
        N.send_all(sock, b'#255.102.255.A=UP')
        self.assertEqual(b''.join(sock.calls), b'#255.102.255.A=UP')
        self.assertEqual(len(sock.calls), 4)

    def test_empty_payload_sends_nothing(self):
        sock = FakeSocket(chunk=5)
        self.assertEqual(N.send_all(sock, b''), 0)
        self.assertEqual(sock.calls, [])

    def test_no_progress_raises_instead_of_spinning_forever(self):
        sock = FakeSocket(chunk=0)
        with self.assertRaises(OSError):
            N.send_all(sock, b'PING')


class TestHeartbeatMonitor(unittest.TestCase):

    def monitor(self):
        return N.HeartbeatMonitor(interval=10, timeout=5, max_misses=3, now=100)

    def test_first_ping_waits_a_full_interval_after_connecting(self):
        # sending PING immediately could land in the same TCP segment as
        # the registration hello, which the server parses first
        h = self.monitor()
        self.assertFalse(h.ping_due(100))
        self.assertFalse(h.ping_due(109))
        self.assertTrue(h.ping_due(110))

    def test_nothing_is_overdue_while_no_ping_is_outstanding(self):
        h = self.monitor()
        self.assertFalse(h.pong_overdue(200))

    def test_pong_in_time_is_not_a_miss(self):
        h = self.monitor()
        h.sent(110)
        self.assertFalse(h.pong_overdue(112))
        h.pong()
        self.assertFalse(h.pong_overdue(120))
        self.assertEqual(h.misses, 0)

    def test_overdue_fires_exactly_once_per_ping(self):
        h = self.monitor()
        h.sent(110)
        self.assertFalse(h.pong_overdue(114))
        self.assertTrue(h.pong_overdue(115))
        self.assertFalse(h.pong_overdue(116))   # already reported
        self.assertFalse(h.pong_overdue(119))

    def test_next_ping_is_due_on_schedule_even_after_a_miss(self):
        h = self.monitor()
        h.sent(110)
        h.pong_overdue(115)
        self.assertFalse(h.ping_due(119))
        self.assertTrue(h.ping_due(120))

    def test_one_missed_pong_does_not_drop_the_connection(self):
        # the whole point: a single lost packet used to cause a reconnect
        h = self.monitor()
        self.assertFalse(h.missed())
        self.assertEqual(h.misses, 1)

    def test_drops_only_after_max_consecutive_misses(self):
        h = self.monitor()
        self.assertEqual([h.missed() for _ in range(3)], [False, False, True])

    def test_a_good_pong_forgets_earlier_misses(self):
        h = self.monitor()
        h.missed(); h.missed()
        h.pong()
        self.assertEqual(h.misses, 0)
        # back to a full budget, so an isolated miss later is still tolerated
        self.assertFalse(h.missed())

    def test_full_lifecycle_of_a_flaky_link(self):
        # PINGs at 110, 120, 130: first two PONGs lost, third arrives.
        h = self.monitor()
        h.sent(110); self.assertTrue(h.pong_overdue(115)); self.assertFalse(h.missed())
        h.sent(120); self.assertTrue(h.pong_overdue(125)); self.assertFalse(h.missed())
        h.sent(130); h.pong()
        self.assertFalse(h.pong_overdue(135))
        self.assertEqual(h.misses, 0)

    def test_max_misses_of_one_drops_immediately(self):
        self.assertTrue(N.HeartbeatMonitor(max_misses=1).missed())

    def test_rejects_nonsense_config(self):
        with self.assertRaises(ValueError):
            N.HeartbeatMonitor(max_misses=0)
        with self.assertRaises(ValueError):
            N.HeartbeatMonitor(interval=5, timeout=5)   # timeout must be shorter
        with self.assertRaises(ValueError):
            N.HeartbeatMonitor(interval=0, timeout=0)


class TestFileHashPrefix(unittest.TestCase):

    def test_matches_hashlib_on_a_real_file(self):
        import hashlib
        import tempfile
        with tempfile.NamedTemporaryFile('wb', delete=False) as fh:
            fh.write(b'print("hello")\n' * 100)   # longer than one read chunk
            path = fh.name
        try:
            expected = hashlib.sha256(open(path, 'rb').read()).hexdigest()[:16]
            self.assertEqual(N.file_hash_prefix(path), expected)
            self.assertEqual(len(N.file_hash_prefix(path)), 16)
        finally:
            os.unlink(path)

    def test_missing_file_is_unknown_not_a_crash(self):
        # a board must still register even if it cannot hash itself
        self.assertEqual(N.file_hash_prefix('/no/such/main.py'), 'unknown')


def decode_all(chunks):
    """Decode a list of outgoing frames back into Frame objects."""
    frames = []
    for c in chunks:
        got, rest, errors = F.decode(c)
        assert not rest and not errors, (rest, errors)
        frames.extend(got)
    return frames


KEY = bytes(range(32))
SERVER_NONCE = b'S' * 32
PICO_NONCE = b'P' * 32


class FakePi:
    """The Pi's half of the handshake, built from auth.py's own functions, so
    these tests drive PicoLink with exactly the bytes a real server sends."""

    def __init__(self, pico_id, key=KEY):
        self.pico_id = pico_id
        self.key = key
        self.seq = 0
        to_pi, to_pico = A.session_keys(key, SERVER_NONCE, PICO_NONCE, pico_id)
        self.tx = A.Tagger(to_pico)
        self.rx = A.Tagger(to_pi)

    def raw(self, opcode, payload=b''):
        self.seq += 1
        return F.encode(opcode, self.seq - 1, payload)

    def challenge(self):
        return self.raw(F.OP_AUTH_CHALLENGE, SERVER_NONCE)

    def sealed(self, opcode, body=b''):
        return self.raw(opcode, self.tx.seal(opcode, body))

    def ack(self, **fields):
        body = {'ok': True, 'name': 'office-north', 'time': 1757980000}
        body.update(fields)
        return self.sealed(F.OP_REGISTER_ACK, json.dumps(body).encode())

    def opened(self, frame_bytes):
        """Decode one frame from the Pico and check its tag. Returns (opcode, body)."""
        f = decode_all([frame_bytes])[0]
        body = self.rx.open(f.opcode, f.payload)
        assert body is not None, 'frame from the Pico failed authentication'
        return f.opcode, body


class TestFirmwareHash(unittest.TestCase):

    SRC = os.path.dirname(os.path.abspath(__file__))

    def test_covers_every_firmware_file_not_just_main_py(self):
        # The old hash was of main.py alone, so a change to net_util.py,
        # frame.py or auth.py was invisible to the Pi.
        base = N.firmware_hash(self.SRC)
        self.assertRegex(base, r'^[0-9a-f]{16}$')
        with open(os.path.join(self.SRC, 'firmware.json')) as fh:
            names = ['firmware.json'] + json.load(fh)['files']
        # Every module the board runs must be listed, or a change to it would
        # be invisible. Checked against the directory, so a new file cannot be
        # forgotten.
        on_disk = sorted(n for n in os.listdir(self.SRC) if n.endswith('.py') and not n.startswith('test_'))
        self.assertEqual(sorted(names[1:]), on_disk)
        for changed in names:
            with tempfile.TemporaryDirectory() as d:
                for name in names:
                    with open(os.path.join(self.SRC, name), 'rb') as src, open(os.path.join(d, name), 'wb') as dst:
                        dst.write(src.read())
                self.assertEqual(N.firmware_hash(d), base)
                with open(os.path.join(d, changed), 'ab') as fh:
                    fh.write(b'\n')
                self.assertNotEqual(N.firmware_hash(d), base, changed)

    def test_matches_the_documented_construction(self):
        h = hashlib.sha256()
        with open(os.path.join(self.SRC, 'firmware.json')) as fh:
            names = ['firmware.json'] + json.load(fh)['files']
        for name in names:
            with open(os.path.join(self.SRC, name), 'rb') as fh:
                h.update(name.encode() + b'\x00' + fh.read() + b'\x00')
        self.assertEqual(N.firmware_hash(self.SRC), h.hexdigest()[:16])

    def test_a_missing_file_is_unknown_not_a_crash(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(N.firmware_hash(d), 'unknown')


class TestPicoLink(unittest.TestCase):

    ID = 'e6614103e71d2c2f'

    def link(self, registered=False, key=KEY):
        link = N.PicoLink(self.ID, '1.1.0', '3b0c44298fc1c149', key, rand=lambda n: PICO_NONCE[:n])
        self.pi = FakePi(self.ID)
        self.sent = [link.register_frame()]
        if registered:
            self.sent += [v for k, v in link.receive(self.pi.challenge()) if k == 'send']
            link.receive(self.pi.ack())
            assert link.registered
        return link

    # --- registration and authentication -------------------------------------

    def test_register_frame_carries_id_fw_and_hash_and_no_key(self):
        link = self.link()
        f = decode_all(self.sent)[0]
        self.assertEqual(f.opcode, F.OP_REGISTER)
        self.assertEqual(f.seq, 0)
        self.assertEqual(F.decode_json(f.payload),
                         {'id': self.ID, 'fw': '1.1.0', 'hash': '3b0c44298fc1c149'})
        self.assertNotIn(KEY, self.sent[0])
        self.assertFalse(link.registered)

    def test_challenge_is_answered_with_a_fresh_nonce_and_the_proof_from_the_spec(self):
        link = self.link()
        events = link.receive(self.pi.challenge())
        self.assertEqual([k for k, _ in events], ['send'])
        f = decode_all([events[0][1]])[0]
        self.assertEqual(f.opcode, F.OP_AUTH_RESPONSE)
        self.assertEqual(len(f.payload), 64)
        self.assertEqual(f.payload[:32], PICO_NONCE)
        expected = hmac.new(KEY, b'rsp1 pico proof\x00' + SERVER_NONCE + PICO_NONCE + self.ID.encode(),
                            hashlib.sha256).digest()
        self.assertEqual(f.payload[32:], expected)
        self.assertFalse(link.registered, 'answering a challenge is not being registered')

    def test_the_key_itself_never_goes_on_the_wire(self):
        link = self.link(registered=True)
        wire = b''.join(self.sent + link.data_frames(b'x') + [link.ping_frame()])
        self.assertNotIn(KEY, wire)
        self.assertNotIn(KEY.hex().encode(), wire)

    def test_a_tagged_ack_registers_and_records_name_and_time(self):
        link = self.link()
        link.receive(self.pi.challenge())
        events = link.receive(self.pi.ack())
        self.assertEqual(events, [('registered', 'office-north')])
        self.assertTrue(link.registered)
        self.assertEqual((link.name, link.server_time), ('office-north', 1757980000))

    def test_an_ack_from_a_server_without_the_key_never_registers(self):
        # Mutual authentication: something that only answers REGISTER with
        # "ok" has not shown it holds this board's key.
        for forged in (
            F.encode_json(F.OP_REGISTER_ACK, 1, {'ok': True, 'name': 'evil', 'time': 1}),
            F.encode(F.OP_REGISTER_ACK, 1, b'{"ok":true,"name":"evil"}' + b'\x00' * 16),
        ):
            link = self.link()
            link.receive(self.pi.challenge())
            events = link.receive(forged)
            self.assertEqual([k for k, _ in events], ['close'])
            self.assertFalse(link.registered)
        link = self.link()
        link.receive(self.pi.challenge())
        self.assertEqual(link.receive(F.encode_json(F.OP_REGISTER_ACK, 1, {'ok': True, 'name': 'evil', 'time': 1})),
                         [('close', 'server did not prove it holds the device key')])

    def test_an_ack_before_any_challenge_never_registers(self):
        link = self.link()
        events = link.receive(F.encode_json(F.OP_REGISTER_ACK, 0, {'ok': True, 'name': 'evil', 'time': 1}))
        self.assertEqual(events[0][0], 'close')
        self.assertFalse(link.registered)

    def test_an_ack_tagged_with_another_boards_key_never_registers(self):
        link = self.link()
        link.receive(self.pi.challenge())
        other = FakePi(self.ID, key=bytes(32))
        events = link.receive(other.ack())
        self.assertEqual(events[0][0], 'close')
        self.assertFalse(link.registered)

    def test_a_refusal_is_reported_with_or_without_a_tag(self):
        link = self.link()
        self.assertEqual(link.receive(F.encode_json(F.OP_REGISTER_ACK, 0, {'ok': False, 'reason': 'unknown device'})),
                         [('refused', 'unknown device')])
        link = self.link()
        link.receive(self.pi.challenge())
        self.assertEqual(link.receive(self.pi.ack(ok=False, reason='firmware mismatch')),
                         [('refused', 'firmware mismatch')])
        self.assertFalse(link.registered)

    def test_a_board_with_no_key_reports_that_it_needs_provisioning(self):
        link = self.link(key=None)
        events = link.receive(self.pi.challenge())
        self.assertEqual(events[0][0], 'refused')
        self.assertIn('no device key', events[0][1])
        self.assertFalse(any(k == 'send' for k, _ in events))

    def test_malformed_or_repeated_challenges_end_the_connection(self):
        link = self.link()
        self.assertEqual(link.receive(F.encode(F.OP_AUTH_CHALLENGE, 0, b'short'))[0][0], 'close')
        link = self.link()
        link.receive(self.pi.challenge())
        self.assertEqual(link.receive(self.pi.challenge())[0][0], 'close')

    def test_ack_that_is_not_json_ends_the_connection(self):
        link = self.link()
        link.receive(self.pi.challenge())
        events = link.receive(self.pi.sealed(F.OP_REGISTER_ACK, b'garbage'))
        self.assertEqual(events, [('close', 'REGISTER_ACK is not JSON')])
        self.assertFalse(link.registered)

    def test_nothing_reaches_the_uart_before_registration(self):
        link = self.link()
        for early in (F.encode(F.OP_DATA, 0, b'#255.102.255.A=UP\r'), F.encode(F.OP_PING, 1), F.encode(F.OP_PONG, 2)):
            events = link.receive(early)
            self.assertFalse(any(k in ('data', 'send', 'pong') for k, _ in events), events)
        link.receive(self.pi.challenge())
        events = link.receive(self.pi.sealed(F.OP_DATA, b'#255.102.255.A=UP\r'))
        self.assertFalse(any(k == 'data' for k, _ in events), 'DATA before REGISTER_ACK must not reach the UART')

    # --- every frame after the handshake is authenticated -----------------------

    def test_outgoing_frames_are_tagged_and_count_up(self):
        link = self.link(registered=True)
        out = [link.ping_frame()] + link.data_frames(b'#255.19.255.QY=FE\r')
        self.assertEqual([f.seq for f in decode_all(self.sent + out)], [0, 1, 2, 3])
        self.assertEqual(self.pi.opened(out[0]), (F.OP_PING, b''))
        self.assertEqual(self.pi.opened(out[1]), (F.OP_DATA, b'#255.19.255.QY=FE\r'))

    def test_no_data_frames_before_registration(self):
        # the spec: a Pico MUST NOT send DATA until REGISTER_ACK ok=true
        self.assertEqual(self.link().data_frames(b'#255.102.255.A=UP\r'), [])

    def test_data_frames_carry_uart_bytes_verbatim_including_magic_and_ping(self):
        payload = b'PING \x7e \xff #255.102.255.A=UP\r'
        link = self.link(registered=True)
        frames = link.data_frames(payload)
        self.assertEqual(len(frames), 1)
        self.assertEqual(self.pi.opened(frames[0]), (F.OP_DATA, payload))

    def test_large_uart_burst_is_split_so_each_frame_still_fits_with_its_tag(self):
        link = self.link(registered=True)
        step = F.MAX_PAYLOAD - A.TAG_LEN
        frames = link.data_frames(b'a' * (step * 2 + 5))
        self.assertEqual([len(f.payload) for f in decode_all(frames)], [F.MAX_PAYLOAD, F.MAX_PAYLOAD, 5 + A.TAG_LEN])
        self.assertEqual(b''.join(self.pi.opened(f)[1] for f in frames), b'a' * (step * 2 + 5))

    def test_empty_read_produces_no_frame(self):
        self.assertEqual(self.link(registered=True).data_frames(b''), [])

    def test_authenticated_data_goes_to_the_uart(self):
        link = self.link(registered=True)
        self.assertEqual(link.receive(self.pi.sealed(F.OP_DATA, b'#255.102.255.A=UP\r')),
                         [('data', b'#255.102.255.A=UP\r')])

    def test_a_forged_frame_never_reaches_the_uart_and_ends_the_connection(self):
        link = self.link(registered=True)
        for forged in (
            F.encode(F.OP_DATA, 9, b'#255.102.255.A=UP\r'),                     # no tag at all
            F.encode(F.OP_DATA, 9, b'#255.102.255.A=UP\r' + b'\x00' * 16),       # made-up tag
        ):
            link = self.link(registered=True)
            self.assertEqual(link.receive(forged), [('close', 'frame failed authentication')])

    def test_an_altered_frame_is_rejected(self):
        link = self.link(registered=True)
        good = bytearray(self.pi.sealed(F.OP_DATA, b'#255.102.255.A=UP\r'))
        body_at = F.HEADER_LEN + 12
        good[body_at] ^= 0x01                           # UP -> something else
        crc = F.crc16(good[1:len(good) - 2])            # an attacker can fix the CRC
        good[-2], good[-1] = crc >> 8, crc & 0xFF
        self.assertEqual(link.receive(bytes(good)), [('close', 'frame failed authentication')])

    def test_a_replayed_frame_is_rejected(self):
        link = self.link(registered=True)
        frame_bytes = self.pi.sealed(F.OP_DATA, b'#255.102.255.A=UP\r')
        self.assertEqual(link.receive(frame_bytes), [('data', b'#255.102.255.A=UP\r')])
        self.assertEqual(link.receive(frame_bytes), [('close', 'frame failed authentication')],
                         'the same bytes a second time must not move the blind again')

    def test_a_dropped_or_reordered_frame_is_rejected(self):
        link = self.link(registered=True)
        first = self.pi.sealed(F.OP_DATA, b'one')
        second = self.pi.sealed(F.OP_DATA, b'two')
        self.assertEqual(link.receive(second), [('close', 'frame failed authentication')])
        del first

    def test_a_frame_recorded_from_an_earlier_session_is_rejected(self):
        link = self.link(registered=True)
        old = self.pi.sealed(F.OP_DATA, b'#255.102.255.A=UP\r')
        # New connection: the board picks a new nonce, so the keys differ.
        fresh = N.PicoLink(self.ID, '1.1.0', 'h', KEY, rand=lambda n: b'Q' * n)
        fresh.register_frame()
        fresh.receive(F.encode(F.OP_AUTH_CHALLENGE, 0, SERVER_NONCE))
        to_pi, to_pico = A.session_keys(KEY, SERVER_NONCE, b'Q' * 32, self.ID)
        ack = json.dumps({'ok': True, 'name': 'n', 'time': 1}).encode()
        fresh.receive(F.encode(F.OP_REGISTER_ACK, 1, A.Tagger(to_pico).seal(F.OP_REGISTER_ACK, ack)))
        self.assertTrue(fresh.registered)
        self.assertEqual(fresh.receive(old), [('close', 'frame failed authentication')])
        del link

    def test_pong_is_reported_not_relayed(self):
        link = self.link(registered=True)
        self.assertEqual(link.receive(self.pi.sealed(F.OP_PONG)), [('pong', None)])

    def test_server_ping_is_answered_with_a_tagged_pong(self):
        link = self.link(registered=True)
        events = link.receive(self.pi.sealed(F.OP_PING))
        self.assertEqual(events[0][0], 'send')
        self.assertEqual(self.pi.opened(events[0][1]), (F.OP_PONG, b''))

    def test_server_error_is_surfaced(self):
        link = self.link()
        events = link.receive(F.encode_json(F.OP_ERROR, 0, {'code': 4, 'msg': 'authenticate first'}))
        self.assertEqual(events, [('error', (4, 'authenticate first'))])

    def test_later_phase_opcodes_are_ignored_without_an_error(self):
        link = self.link(registered=True)
        for op in (F.OP_UPDATE_OFFER,):
            self.assertEqual(link.receive(self.pi.sealed(op, b'\x00')), [('ignored', op)], hex(op))

    # --- control channel (Phase E) ---------------------------------------------

    def control(self, body):
        return self.pi.sealed(F.OP_CONTROL_REQUEST, json.dumps(body).encode())

    def test_an_authenticated_control_request_is_handed_to_main_not_to_the_uart(self):
        link = self.link(registered=True)
        events = link.receive(self.control({'id': 7, 'cmd': 'uart_set', 'args': {'baud': 9600}}))
        self.assertEqual(events, [('control', (7, 'uart_set', {'baud': 9600}))])
        self.assertFalse(any(k == 'data' for k, _ in events), 'a control command must never look like device data')

    def test_control_response_carries_the_id_and_either_a_result_or_an_error(self):
        link = self.link(registered=True)
        op, body = self.pi.opened(link.control_response(7, True, {'uart': '9600 8N1'}))
        self.assertEqual(op, F.OP_CONTROL_RESPONSE)
        self.assertEqual(json.loads(body), {'id': 7, 'ok': True, 'result': {'uart': '9600 8N1'}})
        op, body = self.pi.opened(link.control_response(8, False, 'baud must be between 300 and 921600'))
        self.assertEqual(json.loads(body), {'id': 8, 'ok': False, 'error': 'baud must be between 300 and 921600'})

    def test_every_control_command_must_be_authenticated(self):
        # An unauthenticated `reboot` would be a one-packet building-wide outage.
        reboot = json.dumps({'id': 1, 'cmd': 'reboot', 'args': {}}).encode()
        link = self.link(registered=True)
        self.assertEqual(link.receive(F.encode(F.OP_CONTROL_REQUEST, 9, reboot)), [('close', 'frame failed authentication')])
        link = self.link(registered=True)
        self.assertEqual(link.receive(F.encode(F.OP_CONTROL_REQUEST, 9, reboot + b'\x00' * 16)),
                         [('close', 'frame failed authentication')])
        # Before registration there is no session at all to carry one.
        link = self.link()
        self.assertFalse(any(k == 'control' for k, _ in link.receive(F.encode(F.OP_CONTROL_REQUEST, 0, reboot))))
        link.receive(self.pi.challenge())
        self.assertFalse(any(k == 'control' for k, _ in link.receive(self.control({'id': 1, 'cmd': 'reboot'}))),
                         'not even a correctly tagged command is run before REGISTER_ACK')

    def test_a_replayed_control_command_is_rejected(self):
        link = self.link(registered=True)
        frame_bytes = self.control({'id': 1, 'cmd': 'reboot'})
        self.assertEqual(link.receive(frame_bytes)[0][0], 'control')
        self.assertEqual(link.receive(frame_bytes), [('close', 'frame failed authentication')])

    def test_a_malformed_control_request_gets_an_error_reply_and_runs_nothing(self):
        for body in (b'not json', b'[]', b'{"id": 3}', b'{"id": 3, "cmd": 5}'):
            link = self.link(registered=True)
            events = link.receive(self.pi.sealed(F.OP_CONTROL_REQUEST, body))
            self.assertEqual([k for k, _ in events], ['send'], body)
            op, reply = self.pi.opened(events[0][1])
            self.assertEqual(op, F.OP_CONTROL_RESPONSE)
            self.assertFalse(json.loads(reply)['ok'])

    def test_unknown_opcode_gets_error_2(self):
        link = self.link(registered=True)
        events = link.receive(self.pi.sealed(0x77))
        op, body = self.pi.opened(events[0][1])
        self.assertEqual(op, F.OP_ERROR)
        self.assertEqual(F.decode_json(body)['code'], F.ERR_UNKNOWN_OPCODE)

    def test_unsupported_version_sends_error_1_and_closes(self):
        wrong = bytearray(F.encode(F.OP_PONG, 0))
        wrong[1] = 2
        crc = F.crc16(wrong[1:7])
        wrong[7], wrong[8] = crc >> 8, crc & 0xFF
        events = self.link().receive(bytes(wrong))
        self.assertEqual([k for k, _ in events], ['send', 'close'])
        self.assertEqual(F.decode_json(decode_all([events[0][1]])[0].payload)['code'], F.ERR_VERSION)

    def test_frames_split_across_reads_and_glued_together_both_decode(self):
        link = self.link(registered=True)
        two = self.pi.sealed(F.OP_PONG) + self.pi.sealed(F.OP_DATA, b'#255.19.255.QY=FE\r')
        events = link.receive(two[:5]) + link.receive(two[5:])
        self.assertEqual(events, [('pong', None), ('data', b'#255.19.255.QY=FE\r')])

    def test_noise_before_a_frame_is_counted_as_a_resync_and_skipped(self):
        link = self.link(registered=True)
        events = link.receive(b'\x00\x01\x02' + self.pi.sealed(F.OP_PONG))
        self.assertEqual(events, [('pong', None)])
        self.assertEqual(link.resyncs, 1)


if __name__ == '__main__':
    unittest.main()
