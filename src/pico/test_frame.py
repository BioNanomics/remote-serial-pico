"""Run with:  python3 -m unittest discover -s src/pico -p 'test_*.py'"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import frame as F  # noqa: E402


def corrupt(b, index, xor=0xFF):
    """Return b with one byte flipped."""
    out = bytearray(b)
    out[index] ^= xor
    return bytes(out)


class TestCrc16(unittest.TestCase):

    def test_standard_check_value(self):
        # The published check value for CRC-16/CCITT-FALSE over "123456789".
        # If this fails, frame.js and frame.py cannot possibly agree.
        self.assertEqual(F.crc16(b'123456789'), 0x29B1)

    def test_empty_input_is_the_init_value(self):
        self.assertEqual(F.crc16(b''), 0xFFFF)

    def test_one_bit_changes_the_crc(self):
        self.assertNotEqual(F.crc16(b'#255.102.255.A=UP'), F.crc16(b'#255.102.255.A=UQ'))


class TestEncode(unittest.TestCase):

    def test_ping_is_exactly_nine_bytes_laid_out_per_spec(self):
        ping = F.encode(F.OP_PING, 0x0102)
        self.assertEqual(len(ping), 9)
        self.assertEqual(ping[0], 0x7E)          # MAGIC
        self.assertEqual(ping[1], 1)             # VER
        self.assertEqual(ping[2], F.OP_PING)     # OPCODE
        self.assertEqual(ping[3:5], b'\x01\x02')  # SEQ big-endian
        self.assertEqual(ping[5:7], b'\x00\x00')  # LEN
        self.assertEqual(ping[7:9], F.crc16(ping[1:7]).to_bytes(2, 'big'))

    def test_crc_excludes_magic_and_covers_header_and_payload(self):
        fr = F.encode(F.OP_DATA, 7, b'hello')
        self.assertEqual(fr[-2:], F.crc16(fr[1:-2]).to_bytes(2, 'big'))

    def test_payload_may_contain_magic_and_the_word_ping(self):
        # the two things v0 could not carry; framing makes them ordinary bytes
        payload = b'\x7ePING\x7e\x7e'
        frames, rest, errors = F.decode(F.encode(F.OP_DATA, 1, payload))
        self.assertEqual(frames[0].payload, payload)
        self.assertEqual((rest, errors), (b'', []))

    def test_max_payload_accepted_and_one_more_rejected(self):
        F.encode(F.OP_DATA, 0, b'x' * F.MAX_PAYLOAD)
        with self.assertRaises(ValueError):
            F.encode(F.OP_DATA, 0, b'x' * (F.MAX_PAYLOAD + 1))

    def test_rejects_out_of_range_opcode_and_seq(self):
        with self.assertRaises(ValueError):
            F.encode(0x100, 0)
        with self.assertRaises(ValueError):
            F.encode(F.OP_PING, F.MAX_SEQ + 1)


class TestDecode(unittest.TestCase):

    def test_round_trip(self):
        fr = F.encode(F.OP_REGISTER, 0xBEEF, b'{"id":"e6614103e71d2c2f"}')
        frames, rest, errors = F.decode(fr)
        self.assertEqual(frames, [F.Frame(1, F.OP_REGISTER, 0xBEEF, b'{"id":"e6614103e71d2c2f"}')])
        self.assertEqual((rest, errors), (b'', []))

    def test_two_frames_coalesced_in_one_read(self):
        buf = F.encode(F.OP_PONG, 1) + F.encode(F.OP_DATA, 2, b'MECHO_50')
        frames, rest, errors = F.decode(buf)
        self.assertEqual([f.opcode for f in frames], [F.OP_PONG, F.OP_DATA])
        self.assertEqual((rest, errors), (b'', []))

    def test_frame_split_across_reads_is_held_back_then_completed(self):
        fr = F.encode(F.OP_DATA, 3, b'#255.102.255.A=UP')
        for cut in (1, 3, F.HEADER_LEN - 1, F.HEADER_LEN, F.HEADER_LEN + 4, len(fr) - 1):
            frames, rest, errors = F.decode(fr[:cut])
            self.assertEqual((frames, errors), ([], []), cut)
            self.assertEqual(rest, fr[:cut], cut)
            frames, rest, errors = F.decode(rest + fr[cut:])
            self.assertEqual(frames[0].payload, b'#255.102.255.A=UP', cut)
            self.assertEqual((rest, errors), (b'', []), cut)

    def test_garbage_before_a_frame_is_skipped_and_counted(self):
        buf = b'\x00\x01noise' + F.encode(F.OP_PING, 9)
        frames, rest, errors = F.decode(buf)
        self.assertEqual(frames[0].opcode, F.OP_PING)
        self.assertEqual(errors, [('desync', 7)])
        self.assertEqual(rest, b'')

    def test_garbage_with_no_magic_at_all_is_dropped(self):
        frames, rest, errors = F.decode(b'just noise')
        self.assertEqual((frames, rest), ([], b''))
        self.assertEqual(errors, [('desync', 10)])

    def test_crc_mismatch_resyncs_and_does_not_yield_the_frame(self):
        good = F.encode(F.OP_DATA, 5, b'abc')
        bad = corrupt(good, F.HEADER_LEN)   # flip a payload byte
        frames, rest, errors = F.decode(bad + F.encode(F.OP_PING, 6))
        self.assertEqual([f.opcode for f in frames], [F.OP_PING])
        self.assertEqual(errors[0][0], 'crc')

    def test_corrupted_length_never_makes_the_decoder_wait_forever(self):
        # LEN bytes flipped to a huge value: must be treated as noise, not
        # as "frame still arriving" (which would stall the connection).
        good = F.encode(F.OP_DATA, 5, b'abc')
        bad = corrupt(good, 5, 0xFF)        # high LEN byte -> 0xFF03 > MAX
        frames, rest, errors = F.decode(bad + F.encode(F.OP_PING, 6))
        self.assertEqual([f.opcode for f in frames], [F.OP_PING])
        self.assertEqual(errors[0], ('length', 0xFF03))

    def test_unsupported_version_is_consumed_whole_and_reported(self):
        good = F.encode(F.OP_DATA, 1, b'abc')
        v2 = bytearray(good); v2[1] = 2
        # recompute the CRC so it is a well-formed v2 frame
        crc = F.crc16(v2[1:-2]); v2[-2] = crc >> 8; v2[-1] = crc & 0xFF
        frames, rest, errors = F.decode(bytes(v2) + F.encode(F.OP_PING, 2))
        self.assertEqual([f.opcode for f in frames], [F.OP_PING])
        self.assertEqual(errors, [('version', 2)])
        self.assertEqual(rest, b'')

    def test_magic_inside_a_payload_does_not_confuse_the_scanner(self):
        # a DATA payload full of 0x7E followed by a PING; both must decode
        buf = F.encode(F.OP_DATA, 1, b'\x7e' * 20) + F.encode(F.OP_PING, 2)
        frames, rest, errors = F.decode(buf)
        self.assertEqual([f.opcode for f in frames], [F.OP_DATA, F.OP_PING])
        self.assertEqual(errors, [])


class TestDecoder(unittest.TestCase):

    def test_reassembles_across_feeds_and_counts_resyncs(self):
        d = F.Decoder()
        fr = F.encode(F.OP_DATA, 1, b'MECHO_50')
        self.assertEqual(d.feed(b'zz' + fr[:4]), [])
        self.assertEqual(d.pending, 4)
        got = d.feed(fr[4:])
        self.assertEqual(got[0].payload, b'MECHO_50')
        self.assertEqual(d.pending, 0)
        self.assertEqual(d.resyncs, 1)
        self.assertEqual(d.version_errors, 0)

    def test_byte_at_a_time_delivery(self):
        d = F.Decoder()
        fr = F.encode(F.OP_REGISTER_ACK, 4, b'{"ok":true}')
        got = []
        for i in range(len(fr)):
            got += d.feed(fr[i:i + 1])
        self.assertEqual(got, [F.Frame(1, F.OP_REGISTER_ACK, 4, b'{"ok":true}')])

    def test_version_error_counted_separately(self):
        d = F.Decoder()
        v2 = bytearray(F.encode(F.OP_PING, 0)); v2[1] = 2
        crc = F.crc16(v2[1:-2]); v2[-2] = crc >> 8; v2[-1] = crc & 0xFF
        self.assertEqual(d.feed(bytes(v2)), [])
        self.assertEqual((d.version_errors, d.resyncs), (1, 0))


class TestJsonPayloads(unittest.TestCase):

    def test_register_round_trip(self):
        reg = {'id': 'e6614103e71d2c2f', 'fw': '1.4.0', 'hash': '3b0c44298fc1c149'}
        frames, _, _ = F.decode(F.encode_json(F.OP_REGISTER, 0, reg))
        self.assertEqual(F.decode_json(frames[0].payload), reg)

    def test_decode_json_never_raises(self):
        for bad in (b'', b'not json', b'[1,2]', b'"str"', b'\xff\xfe'):
            self.assertIsNone(F.decode_json(bad), bad)


class TestSequencer(unittest.TestCase):

    def test_starts_at_zero_and_increments(self):
        s = F.Sequencer()
        self.assertEqual([s.next() for _ in range(3)], [0, 1, 2])

    def test_wraps_at_max_seq(self):
        s = F.Sequencer()
        s._seq = F.MAX_SEQ
        self.assertEqual(s.next(), F.MAX_SEQ)
        self.assertEqual(s.next(), 0)


class TestOpcodesMatchSpec(unittest.TestCase):

    def test_values_are_exactly_the_spec_table(self):
        self.assertEqual({
            F.OP_REGISTER: 0x01, F.OP_REGISTER_ACK: 0x02, F.OP_PING: 0x03,
            F.OP_PONG: 0x04, F.OP_ERROR: 0x05, F.OP_DATA: 0x10,
            F.OP_AUTH_CHALLENGE: 0x20, F.OP_AUTH_RESPONSE: 0x21,
            F.OP_CONTROL_REQUEST: 0x30, F.OP_CONTROL_RESPONSE: 0x31,
            F.OP_UPDATE_OFFER: 0x40, F.OP_UPDATE_CHUNK: 0x41, F.OP_UPDATE_RESULT: 0x42,
        }, {op: op for op in F.KNOWN_OPCODES})

    def test_nothing_assigned_in_the_reserved_crypto_range(self):
        self.assertFalse(any(0x50 <= op <= 0x5F for op in F.KNOWN_OPCODES))


if __name__ == '__main__':
    unittest.main()
