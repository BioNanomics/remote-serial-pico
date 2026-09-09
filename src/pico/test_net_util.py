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


if __name__ == '__main__':
    unittest.main()
