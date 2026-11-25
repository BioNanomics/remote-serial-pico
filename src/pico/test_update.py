"""Run with:  python3 -m unittest discover -s src/pico -p 'test_*.py'"""
import hashlib
import json
import os
import sys
import tempfile
import unittest

SRC = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SRC)
import net_util as N  # noqa: E402
import update as U  # noqa: E402

OLD = {'firmware.json': b'{"files": ["main.py", "lib.py"]}', 'main.py': b'print("old")\n', 'lib.py': b'x = 1\n'}
NEW = {'firmware.json': b'{"files": ["main.py", "lib.py"]}', 'main.py': b'print("new")\n' * 80, 'lib.py': b'x = 2\n'}


def offer_for(name, data):
    return {'name': name, 'len': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def chunks(data, size=512):
    return [bytes([(o >> 24) & 255, (o >> 16) & 255, (o >> 8) & 255, o & 255]) + data[o:o + size]
            for o in range(0, len(data), size)]


def hash_of(files):
    h = hashlib.sha256()
    for name in ['firmware.json'] + json.loads(files['firmware.json'])['files']:
        h.update(name.encode() + b'\x00' + files[name] + b'\x00')
    return h.hexdigest()[:16]


class BoardDir(unittest.TestCase):
    """A temp directory standing in for the board's filesystem, running OLD."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = os.getcwd()
        os.chdir(self.tmp.name)
        for name, data in OLD.items():
            with open(name, 'wb') as fh:
                fh.write(data)
        with open('config.json', 'w') as fh:
            fh.write('{"KEY": "secret"}')
        with open('boot.py', 'w') as fh:
            fh.write('# recovery\n')

    def tearDown(self):
        os.chdir(self.cwd)
        self.tmp.cleanup()

    def read(self, name):
        with open(name, 'rb') as fh:
            return fh.read()

    def running(self):
        return {name: self.read(name) for name in OLD}

    def send(self, r, files=NEW, order=None):
        for name in order or list(files):
            r.offer(offer_for(name, files[name]))
            for c in chunks(files[name]):
                r.chunk(c)

    def commit(self, r, of=NEW, **over):
        obj = {'commit': True, 'hash': hash_of(of), 'files': list(of)}
        obj.update(over)
        return r.commit(obj, lambda suffix: N.firmware_hash(suffix=suffix))


class TestReceiver(BoardDir):

    def test_a_good_update_is_staged_verified_and_only_then_swapped_in(self):
        r = U.Receiver()
        self.send(r)
        self.assertEqual(self.running(), OLD, 'receiving changes nothing that is running')
        self.assertEqual(self.commit(r), hash_of(NEW))
        self.assertEqual(self.running(), OLD, 'verifying changes nothing either')
        r.apply()
        self.assertEqual(self.running(), NEW)
        for name in OLD:
            self.assertEqual(self.read(name + '.bak'), OLD[name], 'the previous firmware is kept as a fallback')
            self.assertFalse(os.path.exists(name + '.new'))
        self.assertEqual(json.loads(self.read('update.json')), {'files': list(NEW), 'boots': 0})
        self.assertEqual(N.firmware_hash(), hash_of(NEW), 'the board will now report the hash the Pi announced')

    def test_a_truncated_update_is_rejected_and_the_previous_firmware_keeps_running(self):
        r = U.Receiver()
        r.offer(offer_for('firmware.json', NEW['firmware.json']))
        for c in chunks(NEW['firmware.json']):
            r.chunk(c)
        r.offer(offer_for('main.py', NEW['main.py']))
        for c in chunks(NEW['main.py'])[:-1]:        # the last chunk never arrives
            r.chunk(c)
        with self.assertRaises(U.UpdateError) as cm:
            r.offer(offer_for('lib.py', NEW['lib.py']))
        self.assertIn('main.py: truncated', str(cm.exception))
        r.abort()
        self.assertEqual(self.running(), OLD)
        self.assertEqual(sorted(os.listdir()), sorted(list(OLD) + ['config.json', 'boot.py']), 'nothing staged is left behind')

    def test_a_corrupted_file_is_rejected_by_its_sha256(self):
        r = U.Receiver()
        bad = bytearray(NEW['main.py'])
        bad[100] ^= 0x01
        r.offer(offer_for('main.py', NEW['main.py']))          # the Pi announced the good hash
        for c in chunks(bytes(bad)):                           # but these bytes arrived
            r.chunk(c)
        with self.assertRaises(U.UpdateError) as cm:
            r.commit({'commit': True, 'hash': 'x', 'files': ['main.py']}, lambda suffix: 'x')
        self.assertIn('main.py: sha256 does not match', str(cm.exception))
        r.abort()
        self.assertEqual(self.running(), OLD)

    def test_chunks_must_arrive_in_order_and_fit_what_was_announced(self):
        r = U.Receiver()
        r.offer(offer_for('main.py', NEW['main.py']))
        with self.assertRaises(U.UpdateError):
            r.chunk(chunks(NEW['main.py'])[1])                  # offset 512 first
        r = U.Receiver()
        r.offer({'name': 'main.py', 'len': 4, 'sha256': 'a' * 64})
        with self.assertRaises(U.UpdateError):
            r.chunk(b'\x00\x00\x00\x00' + b'12345')            # one byte too many
        with self.assertRaises(U.UpdateError):
            U.Receiver().chunk(b'\x00\x00\x00\x00data')         # no file on offer
        r.abort()

    def test_only_firmware_files_may_be_written_never_boot_py_config_or_a_path(self):
        for name in ('boot.py', 'config.json', 'update.json', '../main.py', '/main.py', 'lib/x.py', 'x.txt', '.x.py',
                     'main.py.new', 'main.py.bak', '', 'a' * 40 + '.py', 5, None, 'ma in.py'):
            r = U.Receiver()
            with self.assertRaises(U.UpdateError, msg=repr(name)):
                r.offer({'name': name, 'len': 3, 'sha256': 'a' * 64})
        self.assertEqual(self.read('boot.py'), b'# recovery\n')
        self.assertEqual(self.read('config.json'), b'{"KEY": "secret"}')

    def test_bad_lengths_and_hashes_are_refused_before_anything_is_written(self):
        for obj in ({'name': 'main.py', 'len': 0, 'sha256': 'a' * 64}, {'name': 'main.py', 'len': U.MAX_FILE + 1, 'sha256': 'a' * 64},
                    {'name': 'main.py', 'len': '3', 'sha256': 'a' * 64}, {'name': 'main.py', 'len': 3, 'sha256': 'short'},
                    {'name': 'main.py', 'len': True, 'sha256': 'a' * 64}):
            with self.assertRaises(U.UpdateError, msg=repr(obj)):
                U.Receiver().offer(obj)
        self.assertFalse(os.path.exists('main.py.new'))

    def test_commit_refuses_a_set_that_is_not_what_was_announced(self):
        r = U.Receiver()
        self.send(r)
        with self.assertRaises(U.UpdateError):
            self.commit(r, files=['firmware.json', 'main.py'])                        # a file went missing from the list
        r.abort()

        r = U.Receiver()
        self.send(r)
        with self.assertRaises(U.UpdateError) as cm:
            self.commit(r, hash='0' * 16)                                            # not the firmware the Pi named
        self.assertIn('firmware hash', str(cm.exception))
        r.abort()

        r = U.Receiver()
        partial = {'firmware.json': NEW['firmware.json'], 'main.py': NEW['main.py']}   # the manifest lists lib.py too
        self.send(r, files=partial)
        with self.assertRaises(U.UpdateError) as cm:
            r.commit({'commit': True, 'hash': 'x', 'files': list(partial)}, lambda suffix: 'x')
        self.assertIn('not the ones the new firmware.json lists', str(cm.exception))
        r.abort()

        r = U.Receiver()
        self.send(r, files={'main.py': NEW['main.py']})
        with self.assertRaises(U.UpdateError):
            r.commit({'commit': True, 'hash': 'x', 'files': ['main.py']}, lambda suffix: 'x')   # no manifest at all
        r.abort()
        self.assertEqual(self.running(), OLD)

    def test_the_same_file_twice_or_too_many_files_is_refused(self):
        r = U.Receiver()
        self.send(r, files={'lib.py': NEW['lib.py']})
        r.offer(offer_for('main.py', NEW['main.py']))            # closes and verifies lib.py
        with self.assertRaises(U.UpdateError):
            r.offer(offer_for('lib.py', NEW['lib.py']))
        r.abort()

    def test_cleanup_removes_what_an_interrupted_update_left(self):
        r = U.Receiver()
        r.offer(offer_for('main.py', NEW['main.py']))
        r.chunk(chunks(NEW['main.py'])[0])
        del r                                                    # power cut
        self.assertTrue(os.path.exists('main.py.new'))
        self.assertEqual(U.cleanup_staged(), 1)
        self.assertFalse(os.path.exists('main.py.new'))
        self.assertEqual(self.running(), OLD)

    def test_confirm_ends_the_trial_and_drops_the_backups(self):
        self.assertFalse(U.confirm(), 'nothing to confirm on a board that was never updated')
        r = U.Receiver()
        self.send(r)
        self.commit(r)
        r.apply()
        self.assertTrue(U.confirm())
        self.assertFalse(os.path.exists('update.json'))
        self.assertFalse(any(n.endswith('.bak') for n in os.listdir()))
        self.assertEqual(self.running(), NEW)
        self.assertFalse(U.confirm())

    def test_the_empty_marker_a_usb_deploy_leaves_is_removed_quietly(self):
        with open('update.json', 'w') as fh:
            json.dump({'files': [], 'boots': 0}, fh)
        self.assertFalse(U.confirm())
        self.assertFalse(os.path.exists('update.json'))


class TestBootRollback(BoardDir):
    """boot.py is run exactly as the board runs it: as a script, in the
    board's directory, with nothing from the rest of the firmware imported."""

    def boot(self):
        armed = []

        class FakeMachine:
            @staticmethod
            def WDT(timeout=0):
                armed.append(timeout)
        old = sys.modules.get('machine')
        sys.modules['machine'] = FakeMachine
        lines = []
        try:
            with open(os.path.join(SRC, 'boot.py')) as fh:
                exec(compile(fh.read(), 'boot.py', 'exec'), {'__name__': '__main__', 'print': lambda *a: lines.append(' '.join(map(str, a)))})
        finally:
            if old is None:
                del sys.modules['machine']
            else:
                sys.modules['machine'] = old
        return armed, lines

    def update(self):
        r = U.Receiver()
        self.send(r)
        self.commit(r)
        r.apply()

    def test_no_update_in_progress_means_boot_py_does_nothing(self):
        armed, lines = self.boot()
        self.assertEqual((armed, lines), ([], []))
        self.assertEqual(self.running(), OLD)

    def test_new_firmware_is_on_trial_with_a_watchdog_armed_before_main_py_runs(self):
        self.update()
        armed, lines = self.boot()
        self.assertEqual(armed, [8388], 'if the new main.py never gets going, the board must still reset')
        self.assertEqual(json.loads(self.read('update.json'))['boots'], 1)
        self.assertIn('start 1 of 3', lines[0])
        self.assertEqual(self.running(), NEW)

    def test_firmware_that_never_registers_is_replaced_by_the_previous_one(self):
        self.update()
        for start in (1, 2, 3):
            armed, _ = self.boot()                               # new firmware starts and never registers
            self.assertEqual(armed, [8388], start)
            self.assertEqual(self.running(), NEW, start)
        armed, lines = self.boot()                               # fourth start: give up on it
        self.assertEqual(armed, [], 'the old firmware arms its own watchdog; this one is not on trial')
        self.assertEqual(self.running(), OLD, 'every file is back to what ran before the update')
        self.assertFalse(os.path.exists('update.json'))
        self.assertFalse(any(n.endswith('.bak') for n in os.listdir()))
        self.assertTrue(any('Previous firmware restored' in ln for ln in lines))
        self.assertEqual(self.boot(), ([], []), 'and that is the end of it')

    def test_firmware_that_registers_is_kept(self):
        self.update()
        self.boot()
        self.assertTrue(U.confirm())                              # main.py does this on REGISTER_ACK
        for _ in range(5):
            self.assertEqual(self.boot(), ([], []))
        self.assertEqual(self.running(), NEW)

    def test_a_swap_interrupted_half_way_is_undone(self):
        # Power cut inside apply(): marker written, main.py moved aside, new one not in place yet.
        r = U.Receiver()
        self.send(r)
        self.commit(r)
        U._write_json('update.json', {'files': list(NEW), 'boots': 0})
        os.rename('firmware.json', 'firmware.json.bak')
        os.rename('firmware.json.new', 'firmware.json')
        os.rename('main.py', 'main.py.bak')                       # ...and the lights go out
        for _ in range(3):
            self.boot()
        self.boot()
        self.assertEqual(self.running(), OLD)

    def test_boot_py_never_raises_whatever_it_finds(self):
        for junk in (b'', b'not json', b'[]', b'{"files": "main.py"}', b'{"files": [5, null], "boots": 99}',
                     b'{"files": ["nope.py"], "boots": "x"}', b'{"files": [], "boots": 0}'):
            with open('update.json', 'wb') as fh:
                fh.write(junk)
            self.boot()                                           # must not raise
            self.assertEqual(self.running(), OLD, junk)

    def test_boot_py_stands_alone(self):
        with open(os.path.join(SRC, 'boot.py')) as fh:
            source = fh.read()
        for module in ('net_util', 'frame', 'auth', 'control', 'update'):
            self.assertNotIn('import ' + module, source, 'boot.py must survive a broken ' + module)


if __name__ == '__main__':
    unittest.main()
