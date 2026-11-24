#!/usr/bin/python3
"""Deploy the firmware (src/pico, every file firmware.json names) and config.json to a Pico that has just appeared as a serial
device. Run by 99-pico.rules with:

    --config <config.yaml> DEVNAME ID_VENDOR_ID ID_MODEL_ID ID_SERIAL_SHORT

The board's config.json is built fresh for each board: the Pi's own WiFi name
and password, the address and port PtyServer listens on (both from
config.yaml, so the port can never disagree with the server's), the board's
USB serial number, and a new random 256-bit device key. Nobody edits a file.

The device key is what the board later uses to prove who it is (docs/
protocol.md, "Authentication"). USB provisioning is the only moment a secret
can be handed over safely, so it is generated here, written to the board, and
recorded in PicoSecrets for PtyServer. It is random, never derived from the
serial id or the WiFi password, different for every board, and never logged.
Plugging a board in again replaces its key, which is how a key is rotated.

This runs as root, so it reads only root-owned inputs and writes the
per-board config.json, which holds the WiFi password, into a private
temporary directory that is removed afterwards. It never writes into the
source tree (issue #19 review, S3 and S4).

The Pi may be a plain WiFi client (the original setup) or it may host its own
access point for the Picos while it talks to the rest of the world over
Ethernet. Both cases are handled: credentials come from NetworkManager if it
knows them and from hostapd.conf if it does not, and the address handed to the
Pico is the one on the WiFi interface, which is the only one a Pico can reach.
"""
import datetime
import fcntl
import json
import os
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import termios
import time
import tty

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rsp_config  # noqa: E402

# Everything below is derived, not written down a second time: the firmware
# sits next to this script in the installed tree, and rshell sits next to the
# interpreter the udev rule started us with (the venv's).
PICO_SRC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'pico')
PICO_MANIFEST = 'firmware.json'     # names the firmware files; the board and PtyServer read it too
PICO_CONFIG_TEMPLATE = os.path.join(PICO_SRC_DIR, 'config.example.json')
RSHELL = os.path.join(os.path.dirname(sys.executable), 'rshell')
NM_KEYFILE_DIR = '/etc/NetworkManager/system-connections'
HOSTAPD_CONF = '/etc/hostapd/hostapd.conf'
WIFI_INTERFACE = 'wlan0'   # the interface the Picos are on, client or AP
# Replaced by DeployerLog from config.yaml in main(); this is only where
# messages go when the script is run by hand without a config.
LOG_PATH = os.path.join(tempfile.gettempdir(), 'deployer.log')


def log_message(message):
    with open(LOG_PATH, 'a') as log_file:
        log_file.write(f'{datetime.datetime.now()} {message}\n')


def run(cmd):
    """Run a command; return its stdout stripped, or None if it is missing or fails."""
    try:
        return subprocess.check_output(cmd, stderr=subprocess.DEVNULL).decode().strip()
    except (OSError, subprocess.CalledProcessError):
        return None


# --- WiFi credentials --------------------------------------------------------
#
# Three ways, tried in order:
#   1. nmcli, which NetworkManager ships on every Pi OS since Bookworm. It works
#      whatever the connection file is called, which matters on images made by
#      Raspberry Pi Imager or cloud-init, where the file is not named after the
#      SSID and `iwgetid` is not installed.
#   2. The old way: `iwgetid -r` for the SSID, then a keyfile that either is
#      named after the SSID or contains a matching `ssid=` line.
#   3. hostapd.conf, for a Pi that hosts the Picos' WiFi itself. NetworkManager
#      is told to leave that interface alone, so nmcli and iwgetid both see
#      nothing there; the SSID and passphrase live only in hostapd's own file.

def _nm_unescape(value):
    return value.replace('\\:', ':').replace('\\\\', '\\')


def wifi_credentials_from_nmcli(run=run):
    active = run(['nmcli', '-t', '-f', 'NAME,TYPE', 'connection', 'show', '--active'])
    if active is None:
        return None, None
    name = None
    for line in active.splitlines():
        parts = line.rsplit(':', 1)
        if len(parts) == 2 and parts[1] == '802-11-wireless':
            name = _nm_unescape(parts[0])
            break
    if not name:
        return None, None
    ssid = run(['nmcli', '-g', '802-11-wireless.ssid', 'connection', 'show', name])
    psk = run(['nmcli', '-s', '-g', '802-11-wireless-security.psk', 'connection', 'show', name])
    return (_nm_unescape(ssid) if ssid else None), (psk or None)


def _psk_from_keyfile(path, want_ssid=None):
    ssid_ok = want_ssid is None
    psk = None
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if line.startswith('ssid=') and want_ssid is not None:
                    ssid_ok = line[5:] == want_ssid
                elif line.startswith('psk='):
                    psk = line[4:]
    except OSError:
        return None
    return psk if ssid_ok else None


def wifi_credentials_from_files(run=run, keyfile_dir=NM_KEYFILE_DIR):
    ssid = run(['iwgetid', '-r']) or None
    candidates = []
    if ssid:
        candidates.append(os.path.join(keyfile_dir, f'{ssid}.nmconnection'))
    candidates.append(os.path.join(keyfile_dir, 'preconfigured.nmconnection'))
    try:
        candidates += [os.path.join(keyfile_dir, n) for n in sorted(os.listdir(keyfile_dir)) if n.endswith('.nmconnection')]
    except OSError:
        pass
    for path in candidates:
        psk = _psk_from_keyfile(path, want_ssid=ssid)
        if psk:
            return ssid, psk
    return ssid, None


def wifi_credentials_from_hostapd(path=HOSTAPD_CONF):
    """SSID and passphrase of the access point this Pi runs, if it runs one."""
    ssid = psk = None
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                key, sep, value = line.partition('=')
                if not sep:
                    continue
                key = key.strip()
                value = value.strip()
                if key == 'ssid':
                    ssid = value
                elif key == 'wpa_passphrase':
                    psk = value
    except OSError:
        return None, None
    return ssid or None, psk or None


def get_wifi_credentials(run=run, hostapd_conf=HOSTAPD_CONF):
    ssid, psk = wifi_credentials_from_nmcli(run)
    if ssid and psk:
        return ssid, psk, 'nmcli'
    f_ssid, f_psk = wifi_credentials_from_files(run)
    if (ssid or f_ssid) and (psk or f_psk):
        return (ssid or f_ssid), (psk or f_psk), 'keyfile'
    h_ssid, h_psk = wifi_credentials_from_hostapd(hostapd_conf)
    if h_ssid and h_psk:
        return h_ssid, h_psk, 'hostapd'
    return (ssid or f_ssid or h_ssid), (psk or f_psk or h_psk), 'keyfile'


# --- the rest ----------------------------------------------------------------

def ip_address_of(interface, run=run):
    """The IPv4 address on one interface, or None if it has none."""
    out = run(['ip', '-4', '-o', 'addr', 'show', 'dev', interface])
    if not out:
        return None
    for line in out.splitlines():
        parts = line.split()
        if 'inet' in parts:
            addr = parts[parts.index('inet') + 1]
            return addr.split('/')[0]
    return None


def ip_address_with_default_route():
    """Whichever interface routes to the internet. Needs no traffic to leave."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def get_ip_address(run=run, interface=WIFI_INTERFACE):
    """The address the Pico should connect to.

    Prefer the WiFi interface's own address. The old rule, "whichever
    interface routes to the internet", picked the Ethernet address on a Pi
    that is wired for its own uplink and hosts a WiFi access point for the
    Picos: the AP interface has no default route, so it never won. A Pico on
    that access point cannot reach the wired address at all. The route trick
    stays as the fallback for a Pi with no address on WIFI_INTERFACE.
    """
    return ip_address_of(interface, run) or ip_address_with_default_route()


def _is_ipv4(text):
    parts = str(text).split('.')
    return len(parts) == 4 and all(p.isdigit() and 0 <= int(p) <= 255 for p in parts)


def address_for_picos(bind, run=run):
    """The address to hand a Pico, given BindAddress from config.yaml.

    PtyServer listens on BindAddress, so the Pico must be told exactly that:
    an IPv4 address is used as it is, an interface name is resolved to that
    interface's address (None while it has none yet, so the caller keeps
    waiting). With no BindAddress, or 0.0.0.0, the server listens everywhere
    and the old discovery in get_ip_address() picks the address.
    """
    bind = str(bind or '').strip()
    if not bind or bind == '0.0.0.0':
        return get_ip_address()
    if _is_ipv4(bind):
        return bind
    return ip_address_of(bind, run)


def load_config_template(path=None):
    """The committed placeholder config a board's config.json starts from."""
    try:
        with open(path or PICO_CONFIG_TEMPLATE) as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {
            'WIFI_SSID': 'your_wifi_ssid',
            'WIFI_PASSWORD': 'your_wifi_password',
            'IP_ADDRESS': 'your_pi_ip_address',
            'PICO_ID': '1'
        }


def wait_for_network(run=run, timeout=30, sleep=time.sleep, get_ip=None):
    """At boot, udev fires for a Pico that was already plugged in before WiFi
    is up, and the deployer used to write placeholders for everything. Give the
    network a little time; give up after `timeout` seconds and warn."""
    end = time.monotonic() + timeout
    while True:
        ssid, psk, source = get_wifi_credentials(run)
        ip_address = (get_ip or get_ip_address)()
        if (ssid and psk and ip_address) or time.monotonic() >= end:
            return ssid, psk, source, ip_address
        sleep(2)


def firmware_files(src_dir=None):
    """Every file that makes up the firmware, manifest first. One list, in
    firmware.json, shared with the board (which hashes them) and PtyServer
    (which compares that hash)."""
    src_dir = src_dir or PICO_SRC_DIR
    with open(os.path.join(src_dir, PICO_MANIFEST)) as fh:
        return [PICO_MANIFEST] + list(json.load(fh)['files'])


def generate_device_key():
    """256 random bits from the kernel, as 64 hex characters."""
    return secrets.token_hex(32)


def record_device_key(secrets_path, pico_serial_id, key_hex):
    """Record `serial id: key` in the PicoSecrets file, replacing any earlier
    key for that board and keeping everyone else's.

    The file lives in a directory the service user owns, and this runs as
    root, so nothing here follows a path that user could have swapped: the
    directory is opened once and everything else happens relative to it,
    never through a symlink. The new file is written beside the old one,
    mode 0600, given to the directory's owner (the service user), and renamed
    into place, so PtyServer never reads half a file. A lock on the directory
    keeps two boards plugged in together from losing each other's key.
    """
    directory, name = os.path.split(secrets_path)
    nofollow = getattr(os, 'O_NOFOLLOW', 0)
    dfd = os.open(directory, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | nofollow)
    try:
        fcntl.flock(dfd, fcntl.LOCK_EX)
        owner = os.fstat(dfd)
        lines = []
        try:
            fd = os.open(name, os.O_RDONLY | nofollow, dir_fd=dfd)
        except FileNotFoundError:
            fd = None
        if fd is not None:
            with os.fdopen(fd) as fh:
                if not stat.S_ISREG(os.fstat(fh.fileno()).st_mode):
                    raise OSError(f'{secrets_path} is not a regular file')
                lines = fh.read().splitlines()

        wanted = pico_serial_id.lower()
        kept = [ln for ln in lines if ln.split(':', 1)[0].strip().strip('\'"').lower() != wanted]
        kept.append(f"{wanted}: '{key_hex}'")

        tmp = f'.{name}.{os.getpid()}.tmp'
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | nofollow, 0o600, dir_fd=dfd)
        try:
            with os.fdopen(fd, 'w') as fh:
                fh.write('\n'.join(kept) + '\n')
                fh.flush()
                os.fchmod(fh.fileno(), 0o600)
                if os.geteuid() == 0:
                    os.fchown(fh.fileno(), owner.st_uid, owner.st_gid)
                os.fsync(fh.fileno())
            os.rename(tmp, name, src_dir_fd=dfd, dst_dir_fd=dfd)
        except BaseException:
            try:
                os.unlink(tmp, dir_fd=dfd)
            except OSError:
                pass
            raise
    finally:
        os.close(dfd)


def update_config_json(pico_serial_id, path, port, run=run, timeout=30, get_ip=None, template=None, key=None):
    """Write one board's config.json to `path`: this Pi's WiFi and address, the
    server's port, the board's serial number and its device key. Values that
    cannot be discovered stay as the template's placeholders, and that is logged.

    `path` must not exist yet and is created 0600 without following a
    symlink: the file holds the WiFi password and this runs as root."""
    ssid, psk, source, ip_address = wait_for_network(run, timeout, get_ip=get_ip)
    config_data = load_config_template(template)

    if ssid:
        config_data['WIFI_SSID'] = ssid
    if psk:
        config_data['WIFI_PASSWORD'] = psk
    if ip_address:
        config_data['IP_ADDRESS'] = ip_address
    config_data['PORT'] = int(port)
    config_data['PICO_ID'] = str(pico_serial_id)
    if key:
        config_data['KEY'] = key

    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'w') as fh:
        json.dump(config_data, fh, indent=4)

    log_message(f'config.json: ssid={ssid or "UNKNOWN"} psk={"set" if psk else "UNKNOWN"} '
                f'(via {source}) ip={ip_address or "UNKNOWN"} port={int(port)} pico_id={pico_serial_id} '
                f'key={"new" if key else "NONE"}')
    if not (ssid and psk):
        log_message('WARNING: WiFi credentials not found on this Pi; the Pico will not be able to join WiFi')
    if not ip_address:
        log_message('WARNING: no network route yet; config.json has no usable IP_ADDRESS')
    return bool(ssid and psk and ip_address)


def transfer_script_to_pico(port, config_path):
    """Copy the firmware (every file in firmware.json) and config.json onto the
    Pico. True only if rshell succeeded.

    main.py imports the others, so leaving one out is not a partial deploy --
    it is a Pico that fails to boot at all.
    """
    sources = [os.path.join(PICO_SRC_DIR, name) for name in firmware_files()] + [config_path]
    try:
        subprocess.check_call([RSHELL, '-p', port, 'cp'] + sources + ['/pyboard/'],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.CalledProcessError) as err:
        log_message(f'Error during transfer to {port}: {err}')
        log_message('Pico scripts NOT deployed')
        return False
    log_message('Pico scripts deployed :)')
    return True


def reset_pico(port):
    """rshell leaves the board at the REPL with main.py interrupted, so a freshly
    provisioned Pico would sit idle until someone replugged it. A Ctrl-D soft
    reset makes it run the files that were just copied."""
    try:
        fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    except OSError as err:
        log_message(f'could not open {port} to reset the Pico: {err}')
        return False
    try:
        tty.setraw(fd)
        os.write(fd, b'\r\x04')
    except OSError as err:
        log_message(f'could not reset the Pico: {err}')
        return False
    finally:
        os.close(fd)
    log_message('Pico reset; main.py is starting')
    return True


def main(argv=None):
    global LOG_PATH
    config_path, args = rsp_config.split_config_arg(list(sys.argv[1:] if argv is None else argv))
    config = rsp_config.load(config_path)
    if config.get('DeployerLog'):
        LOG_PATH = config['DeployerLog']

    if len(args) < 4:
        log_message(f'usage: {sys.argv[0]} --config CONFIG DEVNAME ID_VENDOR_ID ID_MODEL_ID ID_SERIAL_SHORT (got {args})')
        return 2
    devname = args[0]
    pico_serial_id = args[3]

    log_message(f'Pico detected - Port: {devname}, ID: {pico_serial_id}')
    port = config.get('TCP_PORT')
    if not isinstance(port, int):
        log_message('No TCP_PORT: pass --config <config.yaml> (the udev rule does). '
                    'Refusing to guess a port the server may not be listening on; Pico scripts NOT deployed')
        return 1
    bind = config.get('BindAddress')
    secrets_path = config.get('PicoSecrets')
    if not secrets_path:
        log_message('No PicoSecrets in config.yaml: there is nowhere to record this board\'s device key, '
                    'and the server refuses a board without one; Pico scripts NOT deployed')
        return 1

    # A directory only root can enter, so nobody can swap config.json for a
    # symlink between writing it and rshell reading it.
    workdir = tempfile.mkdtemp(prefix='pico-deploy-')
    try:
        board_config = os.path.join(workdir, 'config.json')
        key = generate_device_key()
        update_config_json(pico_serial_id, board_config, port, get_ip=lambda: address_for_picos(bind), key=key)
        if not transfer_script_to_pico(devname, board_config):
            return 1
        # Only now that the board holds the new key: a failed copy leaves the
        # board and the Pi agreeing on the old one.
        try:
            record_device_key(secrets_path, pico_serial_id, key)
        except OSError as err:
            log_message(f'ERROR: the board has a new device key but it could not be recorded in {secrets_path}: {err}. '
                        'The server will refuse this board; fix the key store and plug the board in again')
            return 1
        log_message(f'device key for {pico_serial_id} recorded in {secrets_path}')
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    reset_pico(devname)
    return 0


if __name__ == '__main__':
    sys.exit(main())
