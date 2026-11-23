"""Run with:  python3 -m unittest discover -s src/pico -p 'test_*.py'"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import frame as F  # noqa: E402
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


def ack(seq=0, **fields):
    body = {'ok': True, 'name': 'office-north', 'time': 1757980000}
    body.update(fields)
    return F.encode_json(F.OP_REGISTER_ACK, seq, body)


class TestPicoLink(unittest.TestCase):

    ID = 'e6614103e71d2c2f'

    def link(self, registered=False):
        link = N.PicoLink(self.ID, '1.0.0', '3b0c44298fc1c149')
        if registered:
            link.receive(ack())
        return link

    def test_register_frame_carries_id_fw_and_hash(self):
        f = decode_all([self.link().register_frame()])[0]
        self.assertEqual(f.opcode, F.OP_REGISTER)
        self.assertEqual(f.seq, 0)
        self.assertEqual(F.decode_json(f.payload),
                         {'id': self.ID, 'fw': '1.0.0', 'hash': '3b0c44298fc1c149'})

    def test_outgoing_sequence_numbers_count_up_across_frame_types(self):
        link = self.link(registered=True)
        frames = decode_all([link.register_frame(), link.ping_frame()] + link.data_frames(b'x'))
        self.assertEqual([f.seq for f in frames], [0, 1, 2])

    def test_ack_ok_registers_and_records_name_and_time(self):
        link = self.link()
        self.assertFalse(link.registered)
        events = link.receive(ack())
        self.assertEqual(events, [('registered', 'office-north')])
        self.assertTrue(link.registered)
        self.assertEqual((link.name, link.server_time), ('office-north', 1757980000))

    def test_ack_refused_reports_the_reason_and_does_not_register(self):
        link = self.link()
        events = link.receive(ack(ok=False, reason='unknown board'))
        self.assertEqual(events, [('refused', 'unknown board')])
        self.assertFalse(link.registered)

    def test_ack_that_is_not_json_gets_an_error_reply(self):
        link = self.link()
        events = link.receive(F.encode(F.OP_REGISTER_ACK, 0, b'garbage'))
        self.assertEqual(events[0][0], 'send')
        err = decode_all([events[0][1]])[0]
        self.assertEqual(err.opcode, F.OP_ERROR)
        self.assertEqual(F.decode_json(err.payload)['code'], F.ERR_BAD_PAYLOAD)
        self.assertFalse(link.registered)

    def test_no_data_frames_before_registration(self):
        # the spec: a Pico MUST NOT send DATA until REGISTER_ACK ok=true
        self.assertEqual(self.link().data_frames(b'#255.102.255.A=UP\r'), [])

    def test_data_frames_carry_uart_bytes_verbatim_including_magic_and_ping(self):
        payload = b'PING \x7e \xff #255.102.255.A=UP\r'
        frames = decode_all(self.link(registered=True).data_frames(payload))
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0].opcode, F.OP_DATA)
        self.assertEqual(frames[0].payload, payload)

    def test_large_uart_burst_is_split_at_max_payload(self):
        frames = decode_all(self.link(registered=True).data_frames(b'a' * (F.MAX_PAYLOAD * 2 + 5)))
        self.assertEqual([len(f.payload) for f in frames], [F.MAX_PAYLOAD, F.MAX_PAYLOAD, 5])

    def test_empty_read_produces_no_frame(self):
        self.assertEqual(self.link(registered=True).data_frames(b''), [])

    def test_incoming_data_goes_to_the_uart_only_once_registered(self):
        link = self.link()
        early = link.receive(F.encode(F.OP_DATA, 0, b'#255.102.255.A=UP\r'))
        self.assertEqual(early[0][0], 'send')
        self.assertEqual(F.decode_json(decode_all([early[0][1]])[0].payload)['code'], F.ERR_NOT_REGISTERED)
        link.receive(ack(1))
        late = link.receive(F.encode(F.OP_DATA, 2, b'#255.102.255.A=UP\r'))
        self.assertEqual(late, [('data', b'#255.102.255.A=UP\r')])

    def test_pong_is_reported_not_relayed(self):
        # under v0 a PONG string could reach the UART; now it is an opcode
        self.assertEqual(self.link(registered=True).receive(F.encode(F.OP_PONG, 0)), [('pong', None)])

    def test_server_ping_is_answered_with_pong(self):
        events = self.link(registered=True).receive(F.encode(F.OP_PING, 0))
        self.assertEqual(events[0][0], 'send')
        self.assertEqual(decode_all([events[0][1]])[0].opcode, F.OP_PONG)

    def test_server_error_is_surfaced(self):
        events = self.link().receive(F.encode_json(F.OP_ERROR, 0, {'code': 4, 'msg': 'register first'}))
        self.assertEqual(events, [('error', (4, 'register first'))])

    def test_later_phase_opcodes_are_ignored_without_an_error(self):
        link = self.link(registered=True)
        for op in (F.OP_AUTH_CHALLENGE, F.OP_CONTROL_REQUEST, F.OP_UPDATE_OFFER):
            self.assertEqual(link.receive(F.encode(op, 0, b'\x00')), [('ignored', op)], hex(op))

    def test_unknown_opcode_gets_error_2(self):
        events = self.link(registered=True).receive(F.encode(0x77, 0))
        err = decode_all([events[0][1]])[0]
        self.assertEqual(err.opcode, F.OP_ERROR)
        self.assertEqual(F.decode_json(err.payload)['code'], F.ERR_UNKNOWN_OPCODE)

    def test_unsupported_version_sends_error_1_and_closes(self):
        wrong = bytearray(F.encode(F.OP_PONG, 0))
        wrong[1] = 2
        crc = F.crc16(wrong[1:7])
        wrong[7], wrong[8] = crc >> 8, crc & 0xFF
        events = self.link(registered=True).receive(bytes(wrong))
        self.assertEqual([k for k, _ in events], ['send', 'close'])
        self.assertEqual(F.decode_json(decode_all([events[0][1]])[0].payload)['code'], F.ERR_VERSION)

    def test_frames_split_across_reads_and_glued_together_both_decode(self):
        link = self.link(registered=True)
        two = F.encode(F.OP_PONG, 0) + F.encode(F.OP_DATA, 1, b'#255.19.255.QY=FE\r')
        events = link.receive(two[:5]) + link.receive(two[5:])
        self.assertEqual(events, [('pong', None), ('data', b'#255.19.255.QY=FE\r')])

    def test_noise_before_a_frame_is_counted_as_a_resync_and_skipped(self):
        link = self.link(registered=True)
        events = link.receive(b'\x00\x01\x02' + F.encode(F.OP_PONG, 0))
        self.assertEqual(events, [('pong', None)])
        self.assertEqual(link.resyncs, 1)


if __name__ == '__main__':
    unittest.main()
