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


class TestHostapdFallback(unittest.TestCase):

    def _conf(self, d, text):
        path = os.path.join(d, 'hostapd.conf')
        with open(path, 'w') as fh:
            fh.write(text)
        return path

    def test_reads_ssid_and_passphrase_ignoring_comments_and_blanks(self):
        with tempfile.TemporaryDirectory() as d:
            path = self._conf(d, '# the Picos\' own network\ninterface=wlan0\n\nssid=PicoNet\n'
                                 'wpa=2\nwpa_passphrase=pico-secret\n#ssid=commented-out\n')
            self.assertEqual(D.wifi_credentials_from_hostapd(path), ('PicoNet', 'pico-secret'))

    def test_missing_file_means_none(self):
        self.assertEqual(D.wifi_credentials_from_hostapd('/nonexistent/hostapd.conf'), (None, None))

    def test_open_network_has_no_passphrase(self):
        with tempfile.TemporaryDirectory() as d:
            path = self._conf(d, 'ssid=OpenNet\n')
            self.assertEqual(D.wifi_credentials_from_hostapd(path), ('OpenNet', None))

    def test_hostapd_is_used_only_when_nmcli_and_keyfiles_know_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            path = self._conf(d, 'ssid=PicoNet\nwpa_passphrase=pico-secret\n')
            with mock.patch.object(D, 'NM_KEYFILE_DIR', d):
                # AP-mode interface: nmcli lists no wireless connection, iwgetid sees nothing
                self.assertEqual(D.get_wifi_credentials(fake_run({}), hostapd_conf=path),
                                 ('PicoNet', 'pico-secret', 'hostapd'))
                # but a real client connection still wins
                run = fake_run({
                    ('nmcli', '-t', '-f', 'NAME,TYPE', 'connection', 'show', '--active'): 'x:802-11-wireless',
                    ('nmcli', '-g', '802-11-wireless.ssid', 'connection', 'show', 'x'): 'mieweb-corp',
                    ('nmcli', '-s', '-g', '802-11-wireless-security.psk', 'connection', 'show', 'x'): 'secret',
                })
                self.assertEqual(D.get_wifi_credentials(run, hostapd_conf=path), ('mieweb-corp', 'secret', 'nmcli'))


class TestIpAddress(unittest.TestCase):

    IP_WLAN0 = ('ip', '-4', '-o', 'addr', 'show', 'dev', 'wlan0')

    def test_prefers_the_wifi_interface_over_the_default_route(self):
        run = fake_run({self.IP_WLAN0: '3: wlan0    inet 10.42.0.1/24 brd 10.42.0.255 scope global noprefixroute wlan0\\       valid_lft forever preferred_lft forever'})
        with mock.patch.object(D, 'ip_address_with_default_route', lambda: '10.3.177.167'):
            self.assertEqual(D.get_ip_address(run), '10.42.0.1')

    def test_falls_back_to_the_default_route_when_wifi_has_no_address(self):
        for output in (None, '', '3: wlan0    <BROADCAST,MULTICAST> mtu 1500'):
            run = fake_run({self.IP_WLAN0: output})
            with mock.patch.object(D, 'ip_address_with_default_route', lambda: '10.3.177.167'):
                self.assertEqual(D.get_ip_address(run), '10.3.177.167', repr(output))

    def test_none_when_nothing_has_an_address_yet(self):
        with mock.patch.object(D, 'ip_address_with_default_route', lambda: None):
            self.assertIsNone(D.get_ip_address(fake_run({})))


class TestAddressForPicos(unittest.TestCase):
    """BindAddress from config.yaml decides what a Pico is told to connect to."""

    def test_an_ipv4_address_is_used_as_written(self):
        self.assertEqual(D.address_for_picos('10.42.0.1', fake_run({})), '10.42.0.1')

    def test_an_interface_name_is_resolved_and_is_none_until_it_has_an_address(self):
        key = ('ip', '-4', '-o', 'addr', 'show', 'dev', 'eth0')
        run = fake_run({key: '2: eth0    inet 192.168.4.7/24 brd 192.168.4.255 scope global eth0'})
        self.assertEqual(D.address_for_picos('eth0', run), '192.168.4.7')
        with mock.patch.object(D, 'ip_address_with_default_route', lambda: '10.9.9.9'):
            self.assertIsNone(D.address_for_picos('eth0', fake_run({})), 'must not fall back to an address the server is not on')

    def test_all_interfaces_or_missing_falls_back_to_discovery(self):
        with mock.patch.object(D, 'get_ip_address', lambda: '10.3.18.86'):
            self.assertEqual(D.address_for_picos('0.0.0.0'), '10.3.18.86')
            self.assertEqual(D.address_for_picos(None), '10.3.18.86')


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
        self.assertTrue(D.update_config_json('e661abcd', self.cfg, 50000, run=run, timeout=0))
        c = json.load(open(self.cfg))
        self.assertEqual((c['WIFI_SSID'], c['WIFI_PASSWORD'], c['IP_ADDRESS'], c['PORT'], c['PICO_ID']),
                         ('mieweb-corp', 'secret', '10.3.18.86', 50000, 'e661abcd'))
        self.assertIn('via nmcli', self._log())
        self.assertNotIn('secret', self._log(), 'the WiFi password must never reach the log')

    def test_port_comes_from_the_caller_not_a_constant(self):
        # Issue #10: the deployer wrote 50000 whatever config.yaml said.
        self.assertFalse(D.update_config_json('e661abcd', self.cfg, 6000, run=fake_run({}), timeout=0))
        self.assertEqual(json.load(open(self.cfg))['PORT'], 6000)
        self.assertFalse(hasattr(D, 'TCP_PORT'), 'no port constant may live in the deployer')

    def test_config_file_is_private_and_never_follows_a_symlink(self):
        # S3: root used to open() a path the service user could turn into a symlink.
        target = os.path.join(self.tmp.name, 'victim')
        with open(target, 'w') as fh:
            fh.write('untouched')
        os.symlink(target, self.cfg)
        with self.assertRaises(OSError):
            D.update_config_json('e661abcd', self.cfg, 50000, run=fake_run({}), timeout=0)
        self.assertEqual(open(target).read(), 'untouched')
        os.unlink(self.cfg)
        D.update_config_json('e661abcd', self.cfg, 50000, run=fake_run({}), timeout=0)
        self.assertEqual(os.stat(self.cfg).st_mode & 0o777, 0o600)

    def test_unknown_credentials_leave_placeholders_and_warn(self):
        self.assertFalse(D.update_config_json('e661abcd', self.cfg, 50000, run=fake_run({}), timeout=0))
        c = json.load(open(self.cfg))
        self.assertEqual((c['WIFI_SSID'], c['WIFI_PASSWORD']), ('your_wifi_ssid', 'your_wifi_password'))
        self.assertEqual(c['PICO_ID'], 'e661abcd')
        self.assertIn('WARNING', self._log())

    def test_main_refuses_to_guess_a_port_without_config(self):
        with mock.patch.object(D.subprocess, 'check_call') as cc:
            self.assertEqual(D.main(['/dev/ttyACM0', '2e8a', '0005', 'e661abcd']), 1)
        cc.assert_not_called()
        self.assertIn('No TCP_PORT', self._log())

    def test_main_reads_port_bind_and_log_from_config_and_leaves_nothing_behind(self):
        log = os.path.join(self.tmp.name, 'from-config.log')
        conf = os.path.join(self.tmp.name, 'config.yaml')
        with open(conf, 'w') as fh:
            fh.write(f"TCP_PORT: 6001\nBindAddress: '10.42.0.1'\nDeployerLog: '{log}'\n"
                     f"PicoSecrets: '{os.path.join(self.tmp.name, 'pico_secrets.yaml')}'\n")
        seen = {}

        def fake_cp(cmd, **kw):
            board = cmd[-2]
            seen['cmd'] = cmd
            seen['config'] = json.load(open(board))
            seen['marker'] = json.load(open(cmd[-3]))
            seen['dir'] = os.path.dirname(board)
            seen['mode'] = os.stat(seen['dir']).st_mode & 0o777
            return 0
        old_log = D.LOG_PATH
        try:
            with mock.patch.object(D.subprocess, 'check_call', fake_cp), \
                 mock.patch.object(D, 'reset_pico', lambda port: True), \
                 mock.patch.object(D, 'wait_for_network',
                                   lambda run, timeout, get_ip=None: ('PicoNet', 'pw', 'hostapd', get_ip())):
                self.assertEqual(D.main(['--config', conf, '/dev/ttyACM0', '2e8a', '0005', 'e661abcd']), 0)
        finally:
            D.LOG_PATH = old_log
        self.assertEqual((seen['config']['PORT'], seen['config']['IP_ADDRESS'], seen['config']['PICO_ID']),
                         (6001, '10.42.0.1', 'e661abcd'))
        self.assertEqual(seen['mode'], 0o700)
        self.assertFalse(os.path.exists(seen['dir']), 'the directory holding the WiFi password must be removed')
        self.assertEqual([os.path.basename(x) for x in seen['cmd'][4:-1]],
                         D.firmware_files() + D.usb_only_files() + ['update.json', 'config.json'])
        self.assertIn('boot.py', D.usb_only_files(), 'the recovery path is deployed over USB')
        self.assertEqual(seen['marker'], {'files': [], 'boots': 0},
                         'a USB deploy clears whatever an earlier over-the-air update left behind')
        self.assertTrue(all(os.path.isfile(x) for x in seen['cmd'][4:-3]), 'firmware files are found next to the script')
        logged = open(log).read()
        self.assertIn('Pico detected', logged)

        # Phase D: the board got a fresh 256-bit key, the same key is on
        # record for the server, and it appears in no log.
        key = seen['config']['KEY']
        self.assertRegex(key, r'^[0-9a-f]{64}$')
        secrets_file = os.path.join(self.tmp.name, 'pico_secrets.yaml')
        self.assertEqual(open(secrets_file).read(), f"e661abcd: '{key}'\n")
        self.assertEqual(os.stat(secrets_file).st_mode & 0o777, 0o600)
        self.assertNotIn(key, logged)
        self.assertIn('device key for e661abcd recorded', logged)

    def _provision(self, conf, serial='e661abcd', cp=None):
        seen = {}

        def fake_cp(cmd, **kw):
            seen['config'] = json.load(open(cmd[-2]))
            return 0
        old_log = D.LOG_PATH
        try:
            with mock.patch.object(D.subprocess, 'check_call', cp or fake_cp), \
                 mock.patch.object(D, 'reset_pico', lambda port: True), \
                 mock.patch.object(D, 'wait_for_network',
                                   lambda run, timeout, get_ip=None: ('PicoNet', 'pw', 'hostapd', '10.42.0.1')):
                code = D.main(['--config', conf, '/dev/ttyACM0', '2e8a', '0005', serial])
        finally:
            D.LOG_PATH = old_log
        return code, seen.get('config')

    def _conf(self):
        conf = os.path.join(self.tmp.name, 'config.yaml')
        self.secrets = os.path.join(self.tmp.name, 'pico_secrets.yaml')
        with open(conf, 'w') as fh:
            fh.write(f"TCP_PORT: 6001\nBindAddress: '10.42.0.1'\nDeployerLog: '{self.log}'\nPicoSecrets: '{self.secrets}'\n")
        return conf

    def test_every_board_gets_its_own_key_and_replugging_rotates_it(self):
        conf = self._conf()
        _, a1 = self._provision(conf, 'e661aaaa')
        _, b1 = self._provision(conf, 'e661bbbb')
        self.assertNotEqual(a1['KEY'], b1['KEY'], 'per-device, not fleet-wide')
        _, a2 = self._provision(conf, 'e661aaaa')
        self.assertNotEqual(a1['KEY'], a2['KEY'], 'plugging a board in again replaces its key')
        self.assertEqual(open(self.secrets).read(), f"e661bbbb: '{b1['KEY']}'\ne661aaaa: '{a2['KEY']}'\n")

    def test_the_key_is_random_not_derived_from_the_serial_id_or_the_wifi_password(self):
        keys = {D.generate_device_key() for _ in range(50)}
        self.assertEqual(len(keys), 50)
        for k in keys:
            self.assertEqual(len(bytes.fromhex(k)), 32)
        conf = self._conf()
        _, board = self._provision(conf, 'e661aaaa')
        self.assertNotIn('e661aaaa', board['KEY'])
        self.assertNotEqual(board['KEY'], board['WIFI_PASSWORD'])

    def test_a_failed_copy_leaves_the_recorded_key_alone(self):
        conf = self._conf()
        _, first = self._provision(conf, 'e661aaaa')
        failing = mock.Mock(side_effect=D.subprocess.CalledProcessError(1, 'rshell'))
        code, _ = self._provision(conf, 'e661aaaa', cp=failing)
        self.assertEqual(code, 1)
        self.assertEqual(open(self.secrets).read(), f"e661aaaa: '{first['KEY']}'\n",
                         'the board still holds the old key, so the Pi must too')

    def test_without_a_key_store_nothing_is_deployed(self):
        conf = os.path.join(self.tmp.name, 'config.yaml')
        with open(conf, 'w') as fh:
            fh.write(f"TCP_PORT: 6001\nDeployerLog: '{self.log}'\n")
        with mock.patch.object(D.subprocess, 'check_call') as cc:
            self.assertEqual(D.main(['--config', conf, '/dev/ttyACM0', '2e8a', '0005', 'e661abcd']), 1)
        cc.assert_not_called()
        self.assertIn('No PicoSecrets', self._log())


    def test_transfer_reports_failure_honestly(self):
        with mock.patch.object(D.subprocess, 'check_call', side_effect=D.subprocess.CalledProcessError(1, 'rshell')):
            self.assertFalse(D.transfer_script_to_pico('/dev/ttyACM0', self.cfg))
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
            self.assertTrue(D.transfer_script_to_pico('/dev/ttyACM0', self.cfg))
        self.assertIn('deployed :)', self._log())


class TestRecordDeviceKey(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, 'pico_secrets.yaml')

    def tearDown(self):
        self.tmp.cleanup()

    def test_keeps_comments_and_other_boards_and_is_always_0600(self):
        with open(self.path, 'w') as fh:
            fh.write("# header\nE661AAAA: 'old'\ne661bbbb: 'bbbb'\n")
        os.chmod(self.path, 0o644)
        D.record_device_key(self.path, 'e661aaaa', 'new')
        self.assertEqual(open(self.path).read(), "# header\ne661bbbb: 'bbbb'\ne661aaaa: 'new'\n")
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)
        self.assertEqual(os.listdir(self.tmp.name), ['pico_secrets.yaml'], 'no temp file left behind')

    def test_creates_the_file_if_it_is_missing(self):
        D.record_device_key(self.path, 'e661aaaa', 'k')
        self.assertEqual(open(self.path).read(), "e661aaaa: 'k'\n")

    def test_never_reads_or_writes_through_a_symlink(self):
        # Root runs this in a directory the service user owns. A symlink there
        # must not make root read or overwrite another file.
        victim = os.path.join(self.tmp.name, 'victim')
        with open(victim, 'w') as fh:
            fh.write('root:secret-hash\n')
        os.symlink(victim, self.path)
        with self.assertRaises(OSError):
            D.record_device_key(self.path, 'e661aaaa', 'k')
        self.assertEqual(open(victim).read(), 'root:secret-hash\n')
        self.assertTrue(os.path.islink(self.path))

    def test_firmware_files_come_from_the_manifest(self):
        files = D.firmware_files()
        self.assertEqual(files[0], 'firmware.json')
        on_disk = sorted(n for n in os.listdir(D.PICO_SRC_DIR) if n.endswith('.py') and not n.startswith('test_'))
        self.assertEqual(sorted(files[1:] + D.usb_only_files()), on_disk, 'every module the board imports must be deployed')
        self.assertFalse(set(files) & set(D.usb_only_files()), 'boot.py is never part of an over-the-air update')
        for name in D.firmware_files():
            self.assertTrue(os.path.isfile(os.path.join(D.PICO_SRC_DIR, name)), name)


if __name__ == '__main__':
    unittest.main()
