#!/usr/bin/python3
"""Flash MicroPython onto a blank Pico that has enumerated in BOOTSEL mode.

Phase A of issue #19. Complements PicoScriptDeployer.py, which handles the
*next* stage: 99-pico.rules only matches 2e8a:0005, the serial interface a
board presents once MicroPython is already running, so a factory-fresh board
is invisible to it. This script covers the step before that.

    blank board  --(this script)-->  MicroPython  --(PicoScriptDeployer)-->  main.py

Standalone use, before udev is involved:

    sudo python3 src/pi/PicoFirmwareFlasher.py /dev/sda1

Everything is logged to /tmp/deployer.log in the same format
PicoScriptDeployer.py uses.
"""
import datetime
import errno
import os
import subprocess
import sys
import time

# Defaults match the paths already hardcoded throughout this project.
FIRMWARE_DIR = os.environ.get('PICO_FIRMWARE_DIR', '/home/project/firmware')
LOG_PATH = os.environ.get('PICO_DEPLOYER_LOG', '/tmp/deployer.log')

# Kill switch: this file must exist or the script does nothing. Deliberately
# opt-in -- this runs as root and writes to removable media.
KILL_SWITCH_NAME = 'autoflash-enabled'

# BOOTSEL USB product IDs -> (UF2 filename, expected FAT label).
# The vendor ID is 2e8a (Raspberry Pi) in both cases.
BOOTSEL_TARGETS = {
    '0003': ('RPI_PICO_W.uf2', 'RPI-RP2'),   # RP2040: Pico / Pico H / Pico W
    '000f': ('RPI_PICO2_W.uf2', 'RP2350'),   # RP2350: Pico 2 / Pico 2 W
}

# In BOOTSEL the ROM bootloader enumerates, not the board, so a plain Pico and
# a Pico W present the same product id. This script cannot tell them apart and
# always flashes the wireless image. A non-wireless board will boot MicroPython
# fine and then die in main.py at network.WLAN(), so say so in the log.
WIRELESS_AMBIGUITY = {
    '0003': 'Pico, Pico H and Pico W all report 2e8a:0003 in BOOTSEL',
    '000f': 'Pico 2 and Pico 2 W both report 2e8a:000f in BOOTSEL',
}

# The FAT filesystem is not ready the instant the udev add event fires.
FS_READY_ATTEMPTS = 10
FS_READY_DELAY = 0.5      # seconds, doubled each attempt up to FS_READY_MAX
FS_READY_MAX = 4.0

MOUNT_ATTEMPTS = 5
MOUNT_DELAY = 0.5

COPY_CHUNK = 64 * 1024

# The Pico resets the moment it has the whole UF2, so the block device is torn
# out from under us mid-write. These errnos mean "it rebooted", not "it broke".
DEVICE_GONE_ERRNOS = {
    errno.EIO, errno.ENODEV, errno.ENOENT, errno.ENXIO,
    errno.ESHUTDOWN, errno.EPIPE, errno.EBADF,
}


def log_message(message):
    """Append one line to the deployer log.

    PicoScriptDeployer.py's log_message() adds no timestamp and leaves it to
    callers; one of its call sites forgets. Timestamping here means every line
    this script writes has one.
    """
    line = f'{datetime.datetime.now()} {message}'
    try:
        with open(LOG_PATH, 'a') as log_file:
            log_file.write(f'{line}\n')
    except OSError:
        pass  # never let logging failure abort a flash
    print(line)


def run(cmd, timeout=30):
    """Run a command, returning (returncode, stdout+stderr)."""
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              timeout=timeout)
        return proc.returncode, proc.stdout.decode(errors='replace').strip()
    except subprocess.TimeoutExpired:
        return -1, f'timed out after {timeout}s'
    except FileNotFoundError:
        return -1, f'{cmd[0]} not found'


def udev_properties(device):
    """Read udev properties for a device as a dict. Empty if unavailable."""
    code, out = run(['udevadm', 'info', '--query=property', f'--name={device}'])
    if code != 0:
        return {}
    props = {}
    for line in out.splitlines():
        if '=' in line:
            key, _, value = line.partition('=')
            props[key] = value
    return props


def resolve_device():
    """Device path from argv[1], else the udev DEVNAME env var."""
    if len(sys.argv) > 1 and sys.argv[1].strip():
        return sys.argv[1].strip()
    return os.environ.get('DEVNAME', '').strip() or None


def resolve_product_id(device, props):
    """Product ID from argv[2], else udev env, else the device's properties."""
    if len(sys.argv) > 2 and sys.argv[2].strip():
        return sys.argv[2].strip().lower()
    for source in (os.environ, props):
        value = source.get('ID_MODEL_ID', '').strip().lower()
        if value:
            return value
    return None


def wait_for_filesystem(device):
    """Block until udev reports a filesystem label, or give up.

    The add event fires before the FAT filesystem is probed, so acting on it
    immediately finds a device with no mountable filesystem.
    """
    delay = FS_READY_DELAY
    for attempt in range(1, FS_READY_ATTEMPTS + 1):
        props = udev_properties(device)
        label = props.get('ID_FS_LABEL', '')
        if label:
            log_message(f'Filesystem ready on {device} after {attempt} attempt(s), label: {label}')
            return label, props
        if not os.path.exists(device):
            log_message(f'{device} disappeared while waiting for its filesystem')
            return None, props
        time.sleep(delay)
        delay = min(delay * 2, FS_READY_MAX)
    log_message(f'Gave up waiting for a filesystem label on {device} '
                f'after {FS_READY_ATTEMPTS} attempts')
    return None, udev_properties(device)


def parse_mount_point(output):
    """Pull the mount point out of udisksctl's chatter.

    Handles both 'Mounted /dev/sda1 at /run/media/root/RPI-RP2.' and the
    'already mounted at `/run/media/...`' error form.
    """
    marker = ' at '
    if marker not in output:
        return None
    tail = output.rsplit(marker, 1)[1].strip()
    tail = tail.strip('`\'".')
    return tail or None


def mount(device):
    """Mount via udisksctl, retrying while the filesystem settles."""
    delay = MOUNT_DELAY
    for attempt in range(1, MOUNT_ATTEMPTS + 1):
        code, out = run(['udisksctl', 'mount', '-b', device, '--no-user-interaction'])
        mount_point = parse_mount_point(out)
        if code == 0 and mount_point:
            log_message(f'Mounted {device} at {mount_point}')
            return mount_point
        if mount_point and 'already mounted' in out.lower():
            log_message(f'{device} was already mounted at {mount_point}')
            return mount_point
        log_message(f'Mount attempt {attempt}/{MOUNT_ATTEMPTS} for {device} failed: {out}')
        if not os.path.exists(device):
            log_message(f'{device} disappeared before it could be mounted')
            return None
        time.sleep(delay)
        delay = min(delay * 2, FS_READY_MAX)
    return None


def unmount(device):
    """Best effort. After a successful flash the device is already gone."""
    if not os.path.exists(device):
        log_message(f'{device} already gone, nothing to unmount')
        return
    code, out = run(['udisksctl', 'unmount', '-b', device, '--no-user-interaction'])
    if code == 0:
        log_message(f'Unmounted {device}')
    else:
        log_message(f'Unmount of {device} returned {code}: {out}')


def copy_firmware(uf2_path, mount_point):
    """Copy the UF2 onto the mounted board.

    Returns True if the firmware landed. The Pico reboots as soon as it has the
    whole image, which tears the block device away mid-write -- so an I/O error
    *after bytes have been written* is what success looks like. Treating it as
    a failure is the classic way to make a working flash look broken.
    """
    destination = os.path.join(mount_point, os.path.basename(uf2_path))
    total = os.path.getsize(uf2_path)
    written = 0
    log_message(f'Copying {uf2_path} ({total} bytes) to {destination}')

    try:
        with open(uf2_path, 'rb') as src, open(destination, 'wb') as dst:
            while True:
                chunk = src.read(COPY_CHUNK)
                if not chunk:
                    break
                dst.write(chunk)
                written += len(chunk)
            dst.flush()
            os.fsync(dst.fileno())
    except OSError as err:
        if written > 0 and err.errno in DEVICE_GONE_ERRNOS:
            log_message(f'Device vanished after {written}/{total} bytes '
                        f'(errno {err.errno} {errno.errorcode.get(err.errno, "?")}) '
                        f'- this is the Pico rebooting, treating as SUCCESS')
            return True
        log_message(f'Copy failed after {written}/{total} bytes: {err}')
        return False

    log_message(f'Wrote {written}/{total} bytes without interruption')
    code, out = run(['sync'], timeout=15)
    if code != 0:
        log_message(f'sync returned {code}: {out}')
    return True


def flash(device, product_id):
    uf2_name, expected_label = BOOTSEL_TARGETS[product_id]
    uf2_path = os.path.join(FIRMWARE_DIR, uf2_name)

    if product_id in WIRELESS_AMBIGUITY:
        log_message(f'WARNING: {WIRELESS_AMBIGUITY[product_id]}; cannot confirm this '
                    f'board has WiFi. Flashing {uf2_name} regardless - a non-wireless '
                    f'board will boot but main.py will fail at network.WLAN()')

    if not os.path.isfile(uf2_path):
        log_message(f'Firmware image {uf2_path} not found - cache it first, '
                    f'this script never downloads at runtime')
        return False

    label, _ = wait_for_filesystem(device)
    if label is None:
        return False

    # Safety: this runs as root and writes to removable media. Refuse anything
    # that is not a Pico bootloader volume.
    if label != expected_label:
        log_message(f'Refusing to touch {device}: label is {label!r}, '
                    f'expected {expected_label!r} for product {product_id}')
        return False

    mount_point = mount(device)
    if mount_point is None:
        return False

    try:
        return copy_firmware(uf2_path, mount_point)
    finally:
        unmount(device)


def main():
    device = resolve_device()
    if not device:
        log_message('No device given. Pass one as an argument '
                    '(sudo python3 src/pi/PicoFirmwareFlasher.py /dev/sda1) '
                    'or set DEVNAME, as udev does.')
        return 2

    kill_switch = os.path.join(FIRMWARE_DIR, KILL_SWITCH_NAME)
    if not os.path.exists(kill_switch):
        log_message(f'Auto-flash disabled, skipping {device}. '
                    f'Create {kill_switch} to enable.')
        return 0

    props = udev_properties(device)
    product_id = resolve_product_id(device, props)
    vendor_id = (os.environ.get('ID_VENDOR_ID')
                 or props.get('ID_VENDOR_ID', '')).strip().lower()

    log_message(f'BOOTSEL candidate - Device: {device}, '
                f'Vendor: {vendor_id or "unknown"}, Product: {product_id or "unknown"}')

    if vendor_id and vendor_id != '2e8a':
        log_message(f'Ignoring {device}: vendor {vendor_id} is not Raspberry Pi (2e8a)')
        return 0

    if product_id not in BOOTSEL_TARGETS:
        log_message(f'Ignoring {device}: product {product_id!r} is not a known '
                    f'BOOTSEL id ({", ".join(sorted(BOOTSEL_TARGETS))})')
        return 0

    if flash(device, product_id):
        log_message(f'MicroPython flashed successfully to {device}. '
                    f'The board will re-enumerate as 2e8a:0005 and '
                    f'PicoScriptDeployer.py takes over from there.')
        return 0

    log_message(f'Flash FAILED for {device}')
    return 1


if __name__ == '__main__':
    sys.exit(main())
