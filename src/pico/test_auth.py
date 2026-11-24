"""Run with:  python3 -m unittest discover -s src/pico -p 'test_*.py'"""
import hashlib
import hmac
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import auth as A  # noqa: E402

KEY = bytes(range(32))
NS = b'S' * 32
NP = b'P' * 32
ID = 'e6614103e71d2c2f'


class TestHmac(unittest.TestCase):

    def test_matches_the_standard_library_for_short_block_sized_and_long_keys(self):
        for key_len in (0, 1, 32, 63, 64, 65, 200):
            for msg_len in (0, 1, 55, 56, 64, 300):
                key, msg = os.urandom(key_len), os.urandom(msg_len)
                self.assertEqual(A.hmac_sha256(key, msg), hmac.new(key, msg, hashlib.sha256).digest(),
                                 (key_len, msg_len))

    def test_rfc_4231_test_case_2(self):
        self.assertEqual(A.hmac_sha256(b'Jefe', b'what do ya want for nothing?').hex(),
                         '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')

    def test_equal_compares_whole_strings(self):
        self.assertTrue(A.equal(b'abc', b'abc'))
        self.assertFalse(A.equal(b'abc', b'abd'))
        self.assertFalse(A.equal(b'abc', b'ab'))
        self.assertTrue(A.equal(b'', b''))


class TestHandshakeValues(unittest.TestCase):

    def test_proof_depends_on_the_key_both_nonces_and_the_serial_id(self):
        base = A.pico_proof(KEY, NS, NP, ID)
        self.assertEqual(len(base), 32)
        self.assertNotEqual(base, A.pico_proof(bytes(32), NS, NP, ID))
        self.assertNotEqual(base, A.pico_proof(KEY, b'T' * 32, NP, ID), 'a new challenge needs a new answer')
        self.assertNotEqual(base, A.pico_proof(KEY, NS, b'Q' * 32, ID))
        self.assertNotEqual(base, A.pico_proof(KEY, NS, NP, 'ffffffffffffffff'))

    def test_session_keys_differ_per_direction_per_session_and_from_the_proof(self):
        to_pi, to_pico = A.session_keys(KEY, NS, NP, ID)
        self.assertNotEqual(to_pi, to_pico, 'a frame cannot be reflected back at its sender')
        self.assertNotIn(A.pico_proof(KEY, NS, NP, ID), (to_pi, to_pico))
        self.assertNotEqual(A.session_keys(KEY, NS, b'Q' * 32, ID), (to_pi, to_pico))
        self.assertNotEqual(A.session_keys(KEY, b'T' * 32, NP, ID), (to_pi, to_pico))


class TestTagger(unittest.TestCase):

    def pair(self):
        return A.Tagger(KEY), A.Tagger(KEY)

    def test_round_trip_and_tag_length(self):
        tx, rx = self.pair()
        sealed = tx.seal(0x10, b'#255.102.255.A=UP\r')
        self.assertEqual(len(sealed), len(b'#255.102.255.A=UP\r') + A.TAG_LEN)
        self.assertEqual(rx.open(0x10, sealed), b'#255.102.255.A=UP\r')
        self.assertEqual(rx.open(0x03, tx.seal(0x03, b'')), b'')

    def test_replay_reorder_and_drop_all_fail(self):
        tx, rx = self.pair()
        one, two = tx.seal(0x10, b'one'), tx.seal(0x10, b'two')
        self.assertIsNone(rx.open(0x10, two), 'out of order')
        self.assertEqual(rx.open(0x10, one), b'one')
        self.assertIsNone(rx.open(0x10, one), 'replayed')
        self.assertEqual(rx.open(0x10, two), b'two', 'a failed check must not advance the counter')

    def test_the_opcode_is_covered(self):
        tx, rx = self.pair()
        self.assertIsNone(rx.open(0x30, tx.seal(0x10, b'reboot')), 'DATA cannot be replayed as a control command')

    def test_any_changed_byte_fails(self):
        tx, _ = self.pair()
        sealed = bytearray(tx.seal(0x10, b'#255.102.255.A=UP\r'))
        for i in range(len(sealed)):
            bad = bytearray(sealed)
            bad[i] ^= 0x01
            self.assertIsNone(A.Tagger(KEY).open(0x10, bytes(bad)), i)

    def test_too_short_to_hold_a_tag(self):
        self.assertIsNone(A.Tagger(KEY).open(0x10, b'short'))

    def test_counter_is_64_bit(self):
        tx, rx = self.pair()
        tx.counter = rx.counter = 2 ** 40
        self.assertEqual(rx.open(0x10, tx.seal(0x10, b'x')), b'x')
        self.assertEqual(rx.counter, 2 ** 40 + 1)


class TestUnhex(unittest.TestCase):

    def test_hex_and_not_hex(self):
        self.assertEqual(A.unhex('00ff10'), b'\x00\xff\x10')
        self.assertEqual(A.unhex(''), b'')
        for bad in ('abc', 'zz', None, 5):
            self.assertIsNone(A.unhex(bad), repr(bad))


if __name__ == '__main__':
    unittest.main()
