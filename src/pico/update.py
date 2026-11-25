"""Receiving a firmware update over the air (issue #19 Phase F). The contract
is docs/protocol.md, "Firmware update".

The Pi offers an update only at registration, after both sides have
authenticated and before any serial data is relayed, and every frame of it
carries the session's authentication tag. This file stages what arrives,
verifies it, and swaps it in. boot.py (which is never updated over the air)
is what brings the previous firmware back if the new one does not start.

Nothing replaces a running file until every file has been received and its
length and SHA-256 have been checked against what the Pi announced:

    <name>.new    a file being received
    <name>.bak    the file it replaced, kept until the new firmware has
                  registered with the Pi
    update.json   what was swapped and how many boots it has had

Must stay importable on a Pico W: stdlib only, no type hints, no f-strings.
"""
import json
import os

MARKER = 'update.json'
STAGE = '.new'
BACKUP = '.bak'
MANIFEST = 'firmware.json'

MAX_FILE = 128 * 1024       # no firmware file is anywhere near this
MAX_FILES = 16
_NAME_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.'
_NEVER = ('boot.py', 'config.json', MARKER)   # the recovery path, the secrets, our own state


class UpdateError(Exception):
    """The update cannot be accepted. The message goes back to the Pi."""


def _exists(path):
    try:
        os.stat(path)
        return True
    except OSError:
        return False


def _remove(path):
    try:
        os.remove(path)
    except OSError:
        pass


def safe_name(name):
    """Only plain firmware file names: a module in the board's root directory,
    or the manifest. Never a path, never boot.py or config.json."""
    if not isinstance(name, str) or not 1 <= len(name) <= 32:
        return False
    if name in _NEVER or name.startswith('.') or name.endswith(STAGE) or name.endswith(BACKUP):
        return False
    for ch in name:
        if ch not in _NAME_CHARS:
            return False
    return name == MANIFEST or name.endswith('.py')


def _sha256_hex(path, chunk=512):
    import hashlib
    import binascii
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                break
            h.update(block)
    return binascii.hexlify(h.digest()).decode()


def _write_json(path, obj):
    with open(path + '.tmp', 'w') as fh:
        json.dump(obj, fh)
    os.rename(path + '.tmp', path)


class Receiver:
    """Stages one update. offer() / chunk() / commit() raise UpdateError; the
    caller then calls abort() and tells the Pi. Nothing live is touched until
    apply()."""

    def __init__(self):
        self.staged = []        # names fully received and verified, in order
        self._name = None
        self._len = 0
        self._sha = None
        self._got = 0
        self._fh = None

    # --- one file -------------------------------------------------------------

    def offer(self, obj):
        self._finish_file()
        name, length, sha = obj.get('name'), obj.get('len'), obj.get('sha256')
        if not safe_name(name):
            raise UpdateError('refusing file name %r' % (name,))
        if name in self.staged:
            raise UpdateError('%s offered twice' % name)
        if len(self.staged) >= MAX_FILES:
            raise UpdateError('too many files')
        if isinstance(length, bool) or not isinstance(length, int) or not 0 < length <= MAX_FILE:
            raise UpdateError('bad length for %s' % name)
        if not isinstance(sha, str) or len(sha) != 64:
            raise UpdateError('bad sha256 for %s' % name)
        self._name, self._len, self._sha, self._got = name, length, sha.lower(), 0
        self._fh = open(name + STAGE, 'wb')

    def chunk(self, payload):
        if self._fh is None:
            raise UpdateError('chunk with no file on offer')
        if len(payload) < 5:
            raise UpdateError('empty chunk')
        offset = (payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3]
        data = payload[4:]
        if offset != self._got:
            raise UpdateError('%s: chunk at %d, expected %d' % (self._name, offset, self._got))
        if self._got + len(data) > self._len:
            raise UpdateError('%s: more data than announced' % self._name)
        self._fh.write(data)
        self._got += len(data)

    def _finish_file(self):
        """Close the file on offer and check it is exactly what was announced."""
        if self._fh is None:
            return
        self._fh.close()
        self._fh = None
        name = self._name
        self._name = None
        if self._got != self._len:
            _remove(name + STAGE)
            raise UpdateError('%s: truncated, got %d of %d bytes' % (name, self._got, self._len))
        # Hash what is on flash, not what went past: that is what will run.
        if _sha256_hex(name + STAGE) != self._sha:
            _remove(name + STAGE)
            raise UpdateError('%s: sha256 does not match' % name)
        self.staged.append(name)

    # --- the whole update -------------------------------------------------------

    def commit(self, obj, firmware_hash):
        """Check the staged set is complete and is the firmware the Pi named.
        `firmware_hash(suffix)` computes the firmware hash over the staged
        files. Returns that hash. Still nothing live has changed."""
        self._finish_file()
        wanted = obj.get('files')
        if not isinstance(wanted, list) or list(wanted) != self.staged:
            raise UpdateError('staged files do not match the commit')
        if MANIFEST not in self.staged:
            raise UpdateError('update has no %s' % MANIFEST)
        with open(MANIFEST + STAGE) as fh:
            listed = json.load(fh).get('files')
        if not isinstance(listed, list) or sorted([MANIFEST] + list(listed)) != sorted(self.staged):
            raise UpdateError('staged files are not the ones the new %s lists' % MANIFEST)
        got = firmware_hash(STAGE)
        if got != obj.get('hash'):
            raise UpdateError('firmware hash is %s, the Pi announced %s' % (got, obj.get('hash')))
        return got

    def apply(self):
        """Swap the verified files in. The marker is written first, so boot.py
        can undo a swap that a power cut interrupted half way."""
        _write_json(MARKER, {'files': list(self.staged), 'boots': 0})
        for name in self.staged:
            _remove(name + BACKUP)
            if _exists(name):
                os.rename(name, name + BACKUP)
            os.rename(name + STAGE, name)
        self.staged = []

    def abort(self):
        """Throw away everything staged. The running firmware is untouched."""
        if self._fh is not None:
            try:
                self._fh.close()
            except OSError:
                pass
            self._fh = None
        if self._name:
            _remove(self._name + STAGE)
            self._name = None
        for name in self.staged:
            _remove(name + STAGE)
        self.staged = []


def cleanup_staged():
    """Remove half-received files left by an update that never finished."""
    removed = 0
    try:
        names = os.listdir()
    except OSError:
        return 0
    for name in names:
        if name.endswith(STAGE) or name == MARKER + '.tmp':
            _remove(name)
            removed += 1
    return removed


def confirm():
    """The new firmware works: it has registered with the Pi. Drop the marker
    and the backups, which ends boot.py's watch. Returns True if there was an
    update to confirm."""
    try:
        with open(MARKER) as fh:
            marker = json.load(fh)
    except (OSError, ValueError):
        return False
    files = marker.get('files') if isinstance(marker, dict) else None
    _remove(MARKER)
    if not isinstance(files, list) or not files:
        return False
    for name in files:
        if isinstance(name, str):
            _remove(name + BACKUP)
    return True
