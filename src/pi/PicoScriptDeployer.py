#!/usr/bin/python3
"""Deploy main.py and config.json to a Pico that has just appeared as a serial
device. Run by 99-pico.rules with: DEVNAME ID_VENDOR_ID ID_MODEL_ID ID_SERIAL_SHORT.

Before writing config.json it fills in the Pi's own WiFi name and password and
its IP address, so the Pico can reach PtyServer without anyone editing a file.

The Pi may be a plain WiFi client (the original setup) or it may host its own
access point for the Picos while it talks to the rest of the world over
Ethernet. Both cases are handled: credentials come from NetworkManager if it
knows them and from hostapd.conf if it does not, and the address handed to the
Pico is the one on the WiFi interface, which is the only one a Pico can reach.
"""
import datetime
import json
import os
import socket
import subprocess
import sys
import termios
import time
import tty

PICO_MAIN_PATH = '/home/project/remote-serial-pico/src/pico/main.py'
PICO_CONFIG_PATH = '/home/project/remote-serial-pico/src/pico/config.json'
RSHELL = '/home/project/myenv/bin/rshell'
NM_KEYFILE_DIR = '/etc/NetworkManager/system-connections'
HOSTAPD_CONF = '/etc/hostapd/hostapd.conf'
WIFI_INTERFACE = 'wlan0'   # the interface the Picos are on, client or AP
LOG_PATH = '/tmp/deployer.log'

TCP_PORT = 50000


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


def load_or_initialize_config(path=PICO_CONFIG_PATH):
    default_config = {
        'WIFI_SSID': 'your_wifi_ssid',
        'WIFI_PASSWORD': 'your_wifi_password',
        'IP_ADDRESS': 'your_ip_address',
        'PORT': TCP_PORT,
        'PICO_ID': '1'
    }
    if os.path.exists(path):
        try:
            with open(path) as fh:
                return json.load(fh)
        except json.JSONDecodeError:
            return default_config
    return default_config


def wait_for_network(run=run, timeout=30, sleep=time.sleep):
    """At boot, udev fires for a Pico that was already plugged in before WiFi
    is up, and the deployer used to write placeholders for everything. Give the
    network a little time; give up after `timeout` seconds and warn."""
    end = time.monotonic() + timeout
    while True:
        ssid, psk, source = get_wifi_credentials(run)
        ip_address = get_ip_address()
        if (ssid and psk and ip_address) or time.monotonic() >= end:
            return ssid, psk, source, ip_address
        sleep(2)


def update_config_json(pico_serial_id, path=PICO_CONFIG_PATH, run=run, timeout=30):
    """Fill config.json with this Pi's WiFi and IP. Values that cannot be
    discovered are left as they were, so a hand-edited file keeps working."""
    ssid, psk, source, ip_address = wait_for_network(run, timeout)
    config_data = load_or_initialize_config(path)

    if ssid:
        config_data['WIFI_SSID'] = ssid
    if psk:
        config_data['WIFI_PASSWORD'] = psk
    if ip_address:
        config_data['IP_ADDRESS'] = ip_address
    config_data['PORT'] = TCP_PORT
    config_data['PICO_ID'] = str(pico_serial_id)

    with open(path, 'w') as fh:
        json.dump(config_data, fh, indent=4)

    log_message(f'config.json: ssid={ssid or "UNKNOWN"} psk={"set" if psk else "UNKNOWN"} '
                f'(via {source}) ip={ip_address or "UNKNOWN"} pico_id={pico_serial_id}')
    if not (ssid and psk):
        log_message('WARNING: WiFi credentials not found on this Pi; the Pico will not be able to join WiFi')
    if not ip_address:
        log_message('WARNING: no network route yet; config.json has no usable IP_ADDRESS')
    return bool(ssid and psk and ip_address)


def transfer_script_to_pico(port):
    """Copy main.py and config.json onto the Pico. True only if rshell succeeded."""
    try:
        subprocess.check_call([RSHELL, '-p', port, 'cp', PICO_MAIN_PATH, PICO_CONFIG_PATH, '/pyboard/'],
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


def main():
    if len(sys.argv) < 5:
        log_message(f'usage: {sys.argv[0]} DEVNAME ID_VENDOR_ID ID_MODEL_ID ID_SERIAL_SHORT (got {sys.argv[1:]})')
        return 2
    devname = sys.argv[1]
    pico_serial_id = sys.argv[4]

    log_message(f'Pico detected - Port: {devname}, ID: {pico_serial_id}')
    update_config_json(pico_serial_id)
    if not transfer_script_to_pico(devname):
        return 1
    reset_pico(devname)
    return 0


if __name__ == '__main__':
    sys.exit(main())
