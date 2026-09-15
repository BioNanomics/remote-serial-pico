"""Run with:  python3 -m unittest discover -s src/pi -p 'test_*.py'"""
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import PicoScriptDeployer as D  # noqa: E402


def fake_run(table):
    """A stand-in for run(): maps a command tuple to its output (None = missing/failing)."""
    def run(cmd):
        return table.get(tuple(cmd))
    return run


class TestNmcli(unittest.TestCase):

    def test_reads_active_wifi_connection_whatever_it_is_called(self):
        run = fake_run({
            ('nmcli', '-t', '-f', 'NAME,TYPE', 'connection', 'show', '--active'):
                'Wired connection 1:802-3-ethernet\ncloud-init mieweb-corp:802-11-wireless',
            ('nmcli', '-g', '802-11-wireless.ssid', 'connection', 'show', 'cloud-init mieweb-corp'): 'mieweb-corp',
            ('nmcli', '-s', '-g', '802-11-wireless-security.psk', 'connection', 'show', 'cloud-init mieweb-corp'): 'secret',
        })
        self.assertEqual(D.wifi_credentials_from_nmcli(run), ('mieweb-corp', 'secret'))

    def test_no_nmcli_means_none(self):
        self.assertEqual(D.wifi_credentials_from_nmcli(fake_run({})), (None, None))

    def test_unescapes_colons_in_names(self):
        run = fake_run({
            ('nmcli', '-t', '-f', 'NAME,TYPE', 'connection', 'show', '--active'): 'office\\:5G:802-11-wireless',
            ('nmcli', '-g', '802-11-wireless.ssid', 'connection', 'show', 'office:5G'): 'office\\:5G',
            ('nmcli', '-s', '-g', '802-11-wireless-security.psk', 'connection', 'show', 'office:5G'): 'p',
        })
        self.assertEqual(D.wifi_credentials_from_nmcli(run), ('office:5G', 'p'))


class TestKeyfileFallback(unittest.TestCase):

    def test_finds_psk_by_ssid_line_not_filename(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, 'preconfigured.nmconnection'), 'w') as fh:
                fh.write('[wifi]\nssid=mieweb-corp\n[wifi-security]\npsk=abc\n')
            run = fake_run({('iwgetid', '-r'): 'mieweb-corp'})
            self.assertEqual(D.wifi_credentials_from_files(run, keyfile_dir=d), ('mieweb-corp', 'abc'))

    def test_ignores_keyfile_for_a_different_network(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, 'home.nmconnection'), 'w') as fh:
                fh.write('[wifi]\nssid=home\n[wifi-security]\npsk=zzz\n')
            run = fake_run({('iwgetid', '-r'): 'mieweb-corp'})
            self.assertEqual(D.wifi_credentials_from_files(run, keyfile_dir=d), ('mieweb-corp', None))


class TestWaitForNetwork(unittest.TestCase):

    def test_returns_as_soon_as_everything_is_known(self):
        calls = []
        table = {
            ('nmcli', '-t', '-f', 'NAME,TYPE', 'connection', 'show', '--active'): 'x:802-11-wireless',
            ('nmcli', '-g', '802-11-wireless.ssid', 'connection', 'show', 'x'): 'ssid',
            ('nmcli', '-s', '-g', '802-11-wireless-security.psk', 'connection', 'show', 'x'): 'psk',
        }
        with mock.patch.object(D, 'get_ip_address', lambda: '10.0.0.5'):
            out = D.wait_for_network(fake_run(table), timeout=30, sleep=calls.append)
        self.assertEqual(out, ('ssid', 'psk', 'nmcli', '10.0.0.5'))
        self.assertEqual(calls, [], 'must not sleep when nothing is missing')

    def test_waits_for_the_network_then_succeeds(self):
        ips = iter([None, None, '10.0.0.5'])
        table = {
            ('nmcli', '-t', '-f', 'NAME,TYPE', 'connection', 'show', '--active'): 'x:802-11-wireless',
            ('nmcli', '-g', '802-11-wireless.ssid', 'connection', 'show', 'x'): 'ssid',
            ('nmcli', '-s', '-g', '802-11-wireless-security.psk', 'connection', 'show', 'x'): 'psk',
        }
        slept = []
        with mock.patch.object(D, 'get_ip_address', lambda: next(ips)):
            out = D.wait_for_network(fake_run(table), timeout=30, sleep=slept.append)
        self.assertEqual(out[3], '10.0.0.5')
        self.assertEqual(slept, [2, 2])

    def test_gives_up_after_timeout(self):
        clock = iter([0, 0, 100])
        with mock.patch.object(D.time, 'monotonic', lambda: next(clock)), \
             mock.patch.object(D, 'get_ip_address', lambda: None):
            out = D.wait_for_network(fake_run({}), timeout=30, sleep=lambda s: None)
        self.assertEqual(out, (None, None, 'keyfile', None))


class TestConfigAndTransfer(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.log = os.path.join(self.tmp.name, 'deployer.log')
        self.cfg = os.path.join(self.tmp.name, 'config.json')
        self.patches = [mock.patch.object(D, 'LOG_PATH', self.log),
                        mock.patch.object(D, 'get_ip_address', lambda: '10.3.18.86')]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def _log(self):
        return open(self.log).read() if os.path.exists(self.log) else ''

    def test_config_gets_wifi_ip_and_serial(self):
        run = fake_run({
            ('nmcli', '-t', '-f', 'NAME,TYPE', 'connection', 'show', '--active'): 'x:802-11-wireless',
            ('nmcli', '-g', '802-11-wireless.ssid', 'connection', 'show', 'x'): 'mieweb-corp',
            ('nmcli', '-s', '-g', '802-11-wireless-security.psk', 'connection', 'show', 'x'): 'secret',
        })
        self.assertTrue(D.update_config_json('e661abcd', path=self.cfg, run=run, timeout=0))
        c = json.load(open(self.cfg))
        self.assertEqual((c['WIFI_SSID'], c['WIFI_PASSWORD'], c['IP_ADDRESS'], c['PORT'], c['PICO_ID']),
                         ('mieweb-corp', 'secret', '10.3.18.86', 50000, 'e661abcd'))
        self.assertIn('via nmcli', self._log())

    def test_unknown_credentials_keep_existing_values_and_warn(self):
        with open(self.cfg, 'w') as fh:
            json.dump({'WIFI_SSID': 'hand-edited', 'WIFI_PASSWORD': 'kept', 'IP_ADDRESS': 'x', 'PORT': 1, 'PICO_ID': '1'}, fh)
        self.assertFalse(D.update_config_json('e661abcd', path=self.cfg, run=fake_run({}), timeout=0))
        c = json.load(open(self.cfg))
        self.assertEqual((c['WIFI_SSID'], c['WIFI_PASSWORD']), ('hand-edited', 'kept'))
        self.assertIn('WARNING', self._log())

    def test_transfer_reports_failure_honestly(self):
        with mock.patch.object(D.subprocess, 'check_call', side_effect=D.subprocess.CalledProcessError(1, 'rshell')):
            self.assertFalse(D.transfer_script_to_pico('/dev/ttyACM0'))
        self.assertIn('NOT deployed', self._log())
        self.assertNotIn('deployed :)', self._log())

    def test_reset_sends_ctrl_d_to_the_board(self):
        writes = []
        with mock.patch.object(D.os, 'open', lambda *a, **k: 7), \
             mock.patch.object(D.os, 'write', lambda fd, b: writes.append((fd, b))), \
             mock.patch.object(D.os, 'close', lambda fd: None), \
             mock.patch.object(D.tty, 'setraw', lambda fd: None):
            self.assertTrue(D.reset_pico('/dev/ttyACM0'))
        self.assertEqual(writes, [(7, b'\r\x04')])
        self.assertIn('Pico reset', self._log())

    def test_reset_failure_is_logged_not_raised(self):
        with mock.patch.object(D.os, 'open', side_effect=OSError(2, 'gone')):
            self.assertFalse(D.reset_pico('/dev/ttyACM0'))
        self.assertIn('could not open', self._log())

    def test_transfer_reports_success(self):
        with mock.patch.object(D.subprocess, 'check_call', return_value=0):
            self.assertTrue(D.transfer_script_to_pico('/dev/ttyACM0'))
        self.assertIn('deployed :)', self._log())


if __name__ == '__main__':
    unittest.main()
