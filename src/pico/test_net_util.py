"""Run with:  python3 -m unittest discover -s src/pico -p 'test_*.py'"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
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


class TestSplitPongs(unittest.TestCase):

    def test_a_lone_pong_is_a_pong_and_no_data(self):
        self.assertEqual(N.split_pongs('PONG\n'), (1, ''))

    def test_bare_pong_without_newline_still_counts(self):
        for text in ('PONG', 'pong', ' PONG ', '\r\nPoNg\r\n'):
            self.assertEqual(N.split_pongs(text), (1, ''), text)

    def test_device_data_is_not_a_pong(self):
        for text in ('MECHO_50', '#255.19.255.QY=FE\r', 'PONGED', 'A PONG'):
            self.assertEqual(N.split_pongs(text), (0, text), text)

    def test_empty_chunk(self):
        self.assertEqual(N.split_pongs(''), (0, ''))

    def test_pong_glued_to_a_command_keeps_the_command_intact(self):
        # TCP is a stream: the server's PONG and a command from Node-RED can
        # land in one recv(). The PONG must not reach the UART; the command,
        # terminator included, must.
        self.assertEqual(N.split_pongs('PONG\n#255.102.255.A=UP\r'),
                         (1, '#255.102.255.A=UP\r'))
        self.assertEqual(N.split_pongs('#255.102.255.A=UP\rPONG\n'),
                         (1, '#255.102.255.A=UP\r'))

    def test_two_pongs_in_one_chunk(self):
        self.assertEqual(N.split_pongs('PONG\nPONG\n'), (2, ''))


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


if __name__ == '__main__':
    unittest.main()
