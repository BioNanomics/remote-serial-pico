"""Run with:  python3 -m unittest discover -s src/pico -p 'test_*.py'"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import control as C  # noqa: E402


class FakeBoard:
    def __init__(self):
        self.calls = []

    def status(self):
        return {'fw': '1.2.0', 'uptime_s': 42}

    def apply_uart(self, settings):
        self.calls.append(('apply', dict(settings)))

    def save_uart(self, settings):
        self.calls.append(('save', dict(settings)))

    def identify(self, seconds):
        self.calls.append(('identify', seconds))

    def reset_soon(self):
        self.calls.append(('reset',))


class TestUartSettings(unittest.TestCase):

    def test_defaults_are_19200_8n1(self):
        self.assertEqual(C.uart_settings(None), {'baud': 19200, 'bits': 8, 'parity': None, 'stop': 1})
        self.assertEqual(C.describe_uart(C.uart_settings(None)), '19200 8N1')

    def test_only_what_is_given_changes(self):
        base = C.uart_settings({'baud': 9600, 'parity': 'E'})
        self.assertEqual(C.describe_uart(base), '9600 8E1')
        self.assertEqual(C.describe_uart(C.uart_settings({'stop': 2}, base)), '9600 8E2')

    def test_parity_spellings(self):
        for given, want in (('N', None), ('n', None), (None, None), ('E', 0), ('even', 0), ('O', 1), ('odd', 1), (0, 0), (1, 1)):
            self.assertEqual(C.uart_settings({'parity': given})['parity'], want, repr(given))

    def test_nonsense_is_refused_with_a_message_for_the_operator(self):
        for bad in ({'baud': 5}, {'baud': 10 ** 7}, {'baud': '9600'}, {'baud': 9600.5}, {'baud': True},
                    {'bits': 9}, {'stop': 3}, {'parity': 'X'}, {'parity': 2}, {'parity': True}):
            with self.assertRaises(ValueError, msg=repr(bad)):
                C.uart_settings(bad)

    def test_saved_settings_from_config_json_round_trip(self):
        saved = C.uart_settings({'baud': 4800, 'bits': 7, 'parity': 'O', 'stop': 2})
        self.assertEqual(C.uart_settings(None, saved), saved)


class TestControlHandler(unittest.TestCase):

    def setUp(self):
        self.board = FakeBoard()
        self.h = C.ControlHandler(self.board)

    def test_status_adds_the_serial_settings_in_force(self):
        ok, result = self.h.handle('status', None)
        self.assertTrue(ok)
        self.assertEqual(result, {'fw': '1.2.0', 'uptime_s': 42, 'uart': '19200 8N1'})

    def test_reboot_answers_first_and_asks_for_a_reset_afterwards(self):
        self.assertEqual(self.h.handle('reboot', {}), (True, {'rebooting': True}))
        self.assertEqual(self.board.calls, [('reset',)])

    def test_identify_defaults_to_ten_seconds_and_is_bounded(self):
        self.assertEqual(self.h.handle('identify', {}), (True, {'blinking_for': 10}))
        self.assertEqual(self.h.handle('identify', {'seconds': 30})[0], True)
        self.assertEqual(self.board.calls, [('identify', 10), ('identify', 30)])
        for bad in (0, 301, -1, '5', True):
            ok, msg = self.h.handle('identify', {'seconds': bad})
            self.assertFalse(ok, repr(bad))
        self.assertEqual(len(self.board.calls), 2)

    def test_uart_set_is_session_only_unless_save_is_asked_for(self):
        ok, result = self.h.handle('uart_set', {'baud': 9600})
        self.assertEqual((ok, result), (True, {'uart': '9600 8N1', 'saved': False}))
        self.assertEqual([c[0] for c in self.board.calls], ['apply'],
                         'nothing is written to flash: a power cycle brings back the old settings')
        ok, result = self.h.handle('uart_set', {'baud': 4800, 'parity': 'E', 'save': True})
        self.assertEqual(result, {'uart': '4800 8E1', 'saved': True})
        self.assertEqual([c[0] for c in self.board.calls], ['apply', 'apply', 'save'])
        self.assertEqual(self.board.calls[-1][1], {'baud': 4800, 'bits': 8, 'parity': 0, 'stop': 1})

    def test_a_bad_uart_setting_changes_nothing(self):
        ok, msg = self.h.handle('uart_set', {'baud': 1})
        self.assertFalse(ok)
        self.assertIn('baud', msg)
        self.assertEqual(self.board.calls, [])
        self.assertEqual(self.h.handle('status', {})[1]['uart'], '19200 8N1')

    def test_unknown_or_sneaky_command_names_reach_nothing(self):
        for cmd in ('nope', '', '__class__', 'board', 'handle', 'cmd_reboot', 'uart', None, 5, 'reboot; reset'):
            ok, msg = self.h.handle(cmd, {})
            self.assertFalse(ok, repr(cmd))
        self.assertEqual(self.board.calls, [])

    def test_a_command_that_blows_up_is_reported_not_raised(self):
        self.board.apply_uart = lambda settings: 1 / 0
        ok, msg = self.h.handle('uart_set', {'baud': 9600})
        self.assertFalse(ok)
        self.assertIn('command failed', msg)

    def test_args_must_be_an_object(self):
        self.assertEqual(self.h.handle('identify', [5])[0], False)


if __name__ == '__main__':
    unittest.main()
