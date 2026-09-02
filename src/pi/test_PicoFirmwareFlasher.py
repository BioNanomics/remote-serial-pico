"""Run with:  python3 -m unittest discover -s src/pi -p 'test_*.py'

No hardware: every external effect (udevadm, udisksctl, the block device)
is mocked. The point is to pin down the decisions the script makes, above
all the one in requirement 4 -- a device that vanishes mid-write is a
SUCCESSFUL flash, not a failed one.
"""
import builtins
import errno
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import PicoFirmwareFlasher as F  # noqa: E402


class VanishingFile:
    """Accepts writes until `fail_after` bytes, then behaves like a block
    device whose board just rebooted underneath it."""

    def __init__(self, fail_after):
        self.written = 0
        self.fail_after = fail_after

    def write(self, chunk):
        if self.written >= self.fail_after:
            raise OSError(errno.EIO, 'Input/output error')
        self.written += len(chunk)

    def flush(self):
        raise OSError(errno.EIO, 'Input/output error')

    def fileno(self):
        return 1

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class FlasherTestCase(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.firmware_dir = self.tmp.name
        self.log_path = os.path.join(self.firmware_dir, 'deployer.log')
        self._patches = [
            mock.patch.object(F, 'FIRMWARE_DIR', self.firmware_dir),
            mock.patch.object(F, 'LOG_PATH', self.log_path),
            mock.patch.object(F.time, 'sleep', lambda *_: None),   # no real backoff waits
            mock.patch.object(builtins, 'print', lambda *_, **__: None),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self.tmp.cleanup()

    # --- helpers -----------------------------------------------------------

    def enable(self):
        open(os.path.join(self.firmware_dir, F.KILL_SWITCH_NAME), 'w').close()

    def cache_firmware(self, name='RPI_PICO_W.uf2', size=300000):
        path = os.path.join(self.firmware_dir, name)
        with open(path, 'wb') as fh:
            fh.write(b'U' * size)
        return path

    def log(self):
        if not os.path.exists(self.log_path):
            return ''
        with open(self.log_path) as fh:
            return fh.read()

    def run_main(self, *argv, env=None):
        with mock.patch.object(sys, 'argv', ['PicoFirmwareFlasher.py', *argv]), \
             mock.patch.dict(os.environ, env or {}, clear=False):
            return F.main()


# --- argument and environment handling --------------------------------------

class TestInputs(FlasherTestCase):

    def test_no_device_exits_2(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(self.run_main(), 2)
        self.assertIn('No device given', self.log())

    def test_device_from_udev_env_when_no_argument(self):
        with mock.patch.object(sys, 'argv', ['x']), \
             mock.patch.dict(os.environ, {'DEVNAME': '/dev/sdz1'}):
            self.assertEqual(F.resolve_device(), '/dev/sdz1')

    def test_argument_beats_udev_env(self):
        with mock.patch.object(sys, 'argv', ['x', '/dev/sda1']), \
             mock.patch.dict(os.environ, {'DEVNAME': '/dev/sdz1'}):
            self.assertEqual(F.resolve_device(), '/dev/sda1')

    def test_product_id_argument_beats_env_and_udev(self):
        with mock.patch.object(sys, 'argv', ['x', '/dev/sda1', '000F']), \
             mock.patch.dict(os.environ, {'ID_MODEL_ID': '0003'}):
            self.assertEqual(F.resolve_product_id('/dev/sda1', {'ID_MODEL_ID': '0003'}), '000f')


# --- guards -----------------------------------------------------------------

class TestGuards(FlasherTestCase):

    def test_kill_switch_absent_skips_and_exits_0(self):
        self.assertEqual(self.run_main('/dev/sda1', '0003'), 0)
        self.assertIn('Auto-flash disabled', self.log())
        self.assertIn(F.KILL_SWITCH_NAME, self.log())

    def test_unknown_product_ignored(self):
        self.enable()
        with mock.patch.object(F, 'udev_properties', return_value={}):
            self.assertEqual(self.run_main('/dev/sda1', '0005'), 0)
        self.assertIn('not a known BOOTSEL id', self.log())

    def test_non_raspberry_pi_vendor_ignored(self):
        self.enable()
        with mock.patch.object(F, 'udev_properties', return_value={'ID_VENDOR_ID': '0781'}):
            self.assertEqual(self.run_main('/dev/sda1', '0003'), 0)
        self.assertIn('not Raspberry Pi', self.log())

    def test_missing_firmware_image_fails_without_downloading(self):
        self.enable()
        with mock.patch.object(F, 'udev_properties', return_value={}):
            self.assertEqual(self.run_main('/dev/sda1', '0003'), 1)
        self.assertIn('never downloads', self.log())

    def test_wrong_label_is_refused(self):
        # A root script writing to removable media must not touch a USB stick.
        self.enable()
        self.cache_firmware()
        with mock.patch.object(F, 'wait_for_filesystem', return_value=('MY_USB_STICK', {})), \
             mock.patch.object(F, 'mount') as mount:
            self.assertFalse(F.flash('/dev/sda1', '0003'))
            mount.assert_not_called()
        self.assertIn('Refusing to touch', self.log())

    def test_wireless_ambiguity_is_logged_for_both_families(self):
        # Fleet composition is unknown, so a mis-flash must at least be visible.
        self.enable()
        self.cache_firmware('RPI_PICO_W.uf2')
        self.cache_firmware('RPI_PICO2_W.uf2')
        for product, label in (('0003', 'RPI-RP2'), ('000f', 'RP2350')):
            with mock.patch.object(F, 'wait_for_filesystem', return_value=(label, {})), \
                 mock.patch.object(F, 'mount', return_value='/mnt/x'), \
                 mock.patch.object(F, 'unmount'), \
                 mock.patch.object(F, 'copy_firmware', return_value=True):
                F.flash('/dev/sda1', product)
        log = self.log()
        self.assertIn('2e8a:0003 in BOOTSEL', log)
        self.assertIn('2e8a:000f in BOOTSEL', log)
        self.assertIn('network.WLAN()', log)

    def test_rp2350_selects_pico2_image_and_label(self):
        self.enable()
        self.cache_firmware('RPI_PICO2_W.uf2')
        with mock.patch.object(F, 'wait_for_filesystem', return_value=('RP2350', {})), \
             mock.patch.object(F, 'mount', return_value='/mnt/x'), \
             mock.patch.object(F, 'unmount'), \
             mock.patch.object(F, 'copy_firmware', return_value=True) as copy:
            self.assertTrue(F.flash('/dev/sda1', '000f'))
            copy.assert_called_once()
            self.assertTrue(copy.call_args[0][0].endswith('RPI_PICO2_W.uf2'))


# --- requirement 4: the reboot mid-write ------------------------------------

class TestDeviceVanishes(FlasherTestCase):

    def _copy_with(self, fail_after):
        uf2 = self.cache_firmware()
        real_open = builtins.open

        def fake_open(path, mode='r', *a, **k):
            if 'w' in mode and str(path).endswith('.uf2'):
                return VanishingFile(fail_after)
            return real_open(path, mode, *a, **k)

        with mock.patch.object(builtins, 'open', fake_open):
            return F.copy_firmware(uf2, self.firmware_dir)

    def test_vanish_after_bytes_landed_is_success(self):
        self.assertTrue(self._copy_with(fail_after=128 * 1024))
        self.assertIn('treating as SUCCESS', self.log())
        self.assertIn('EIO', self.log())

    def test_vanish_before_any_bytes_is_failure(self):
        self.assertFalse(self._copy_with(fail_after=0))
        self.assertIn('Copy failed after 0/', self.log())
        self.assertNotIn('SUCCESS', self.log())

    def test_unrelated_oserror_is_failure_even_after_bytes(self):
        # ENOSPC is a real problem, not a reboot, so it must not be excused.
        uf2 = self.cache_firmware()
        real_open = builtins.open

        class FullDisk(VanishingFile):
            def write(self, chunk):
                if self.written >= self.fail_after:
                    raise OSError(errno.ENOSPC, 'No space left on device')
                self.written += len(chunk)

        def fake_open(path, mode='r', *a, **k):
            if 'w' in mode and str(path).endswith('.uf2'):
                return FullDisk(64 * 1024)
            return real_open(path, mode, *a, **k)

        with mock.patch.object(builtins, 'open', fake_open):
            self.assertFalse(F.copy_firmware(uf2, self.firmware_dir))
        self.assertIn('Copy failed', self.log())

    def test_uninterrupted_copy_is_also_success(self):
        uf2 = self.cache_firmware(size=1000)
        dest_dir = os.path.join(self.firmware_dir, 'mnt')
        os.mkdir(dest_dir)
        with mock.patch.object(F, 'run', return_value=(0, '')):
            self.assertTrue(F.copy_firmware(uf2, dest_dir))
        self.assertIn('without interruption', self.log())
        self.assertEqual(os.path.getsize(os.path.join(dest_dir, 'RPI_PICO_W.uf2')), 1000)


# --- requirement 5: the filesystem is not ready when udev fires ---------------

class TestFilesystemReadiness(FlasherTestCase):

    def test_waits_through_unlabelled_polls_then_succeeds(self):
        answers = [{}, {}, {'ID_FS_LABEL': 'RPI-RP2'}]
        with mock.patch.object(F, 'udev_properties', side_effect=answers), \
             mock.patch.object(os.path, 'exists', return_value=True):
            label, _ = F.wait_for_filesystem('/dev/sda1')
        self.assertEqual(label, 'RPI-RP2')
        self.assertIn('after 3 attempt(s)', self.log())

    def test_gives_up_after_max_attempts(self):
        with mock.patch.object(F, 'udev_properties', return_value={}), \
             mock.patch.object(os.path, 'exists', return_value=True):
            label, _ = F.wait_for_filesystem('/dev/sda1')
        self.assertIsNone(label)
        self.assertIn('Gave up', self.log())

    def test_stops_early_if_device_disappears_while_waiting(self):
        with mock.patch.object(F, 'udev_properties', return_value={}), \
             mock.patch.object(os.path, 'exists', return_value=False):
            label, _ = F.wait_for_filesystem('/dev/sda1')
        self.assertIsNone(label)
        self.assertIn('disappeared while waiting', self.log())

    def test_mount_retries_then_succeeds(self):
        answers = [(1, 'Error mounting: not ready'), (0, 'Mounted /dev/sda1 at /run/media/root/RPI-RP2.')]
        with mock.patch.object(F, 'run', side_effect=answers), \
             mock.patch.object(os.path, 'exists', return_value=True):
            self.assertEqual(F.mount('/dev/sda1'), '/run/media/root/RPI-RP2')
        self.assertIn('Mount attempt 1/', self.log())


# --- udisksctl output parsing -----------------------------------------------

class TestMountPointParsing(unittest.TestCase):

    def test_standard_output_with_trailing_period(self):
        self.assertEqual(F.parse_mount_point('Mounted /dev/sda1 at /run/media/root/RPI-RP2.'),
                         '/run/media/root/RPI-RP2')

    def test_already_mounted_error_form(self):
        out = "Error mounting /dev/sda1: GDBus.Error:org.freedesktop.UDisks2.Error.AlreadyMounted: Device /dev/sda1 is already mounted at `/media/pi/RPI-RP2'."
        self.assertEqual(F.parse_mount_point(out), '/media/pi/RPI-RP2')

    def test_no_mount_point_returns_none(self):
        self.assertIsNone(F.parse_mount_point('Error mounting: device not found'))


if __name__ == '__main__':
    unittest.main()
