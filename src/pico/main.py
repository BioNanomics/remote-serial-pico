import network
import socket
import select
import time
import json
import machine
from machine import UART, Pin, WDT
from net_util import (safe_decode, send_all, file_hash_prefix, Backoff,
                      HeartbeatMonitor, PicoLink, RegistrationRefused)

# Reported to the Pi in REGISTER (docs/protocol.md), together with a hash of
# this very file, so `remote-serial-pico status` and the logs can say which
# firmware each board runs without anyone walking over to it. Bump on every
# change that ships to a board.
FIRMWARE_VERSION = '1.0.0'
MAIN_HASH = file_hash_prefix('main.py')

# Load network configuration
def read_config():
    with open('config.json', 'r') as f:
        return json.load(f)

config = read_config()
WIFI_SSID     = config['WIFI_SSID']
WIFI_PASSWORD = config['WIFI_PASSWORD']
IP_ADDRESS    = config['IP_ADDRESS']
TCP_PORT      = config['PORT']
PICO_ID       = config['PICO_ID']

# Initialize UART and onboard LED
uart1 = UART(1, 19200)
uart1.init(19200, bits=8, parity=None, stop=1, tx=4, rx=5)
led = Pin("LED", Pin.OUT)

# Hardware watchdog: if the main loop ever stops calling wdt.feed() -- a true
# hang that no try/except can catch, e.g. blocked forever inside a driver call
# -- the RP2040 resets itself instead of staying dark until someone notices.
# 8388 ms is the RP2040 watchdog's own maximum; there is no larger timeout to
# ask for. Every place this program can wait is bounded to well under that:
# socket calls by SOCKET_TIMEOUT, the relay loop by POLL_TIMEOUT_MS, and
# longer sleeps go through sleep_fed() so they keep feeding it.
WATCHDOG_TIMEOUT_MS = 8388
wdt = WDT(timeout=WATCHDOG_TIMEOUT_MS)

# No socket call may block longer than this, so a stalled network turns into
# an OSError and a reconnect rather than a watchdog reboot.
SOCKET_TIMEOUT = 5

# How long one pass of the relay loop waits for TCP data before checking the
# UART again. UART -> server latency is at most this; server -> UART latency
# is near zero because poll() wakes the instant data arrives.
POLL_TIMEOUT_MS = 50

def sleep_fed(seconds):
    """time.sleep() that keeps the watchdog fed.

    A plain sleep longer than the watchdog window reboots the board. The
    reconnect backoff sleeps up to 30 s, so it must go through here.
    """
    while seconds > 0:
        wdt.feed()
        step = min(seconds, 1)
        time.sleep(step)
        seconds -= step
    wdt.feed()

def blink_led():
    led.off()
    time.sleep(0.1)
    led.on()
    time.sleep(0.1)

# WiFi. The original firmware called wlan.connect() once, unguarded. On the
# very first boot after a flash the CYW43 radio is not ready yet and that call
# throws OSError EPERM every time (seen on two boards, 2026-09-11), leaving
# the board frozen at the REPL. A soft reset does not clear the radio; only a
# hardware reset does. So: retry with backoff, and if the radio still will not
# join after WIFI_RESET_AFTER attempts, reset the hardware ourselves.
WIFI_JOIN_TIMEOUT = 20    # seconds to wait for one join attempt to complete
WIFI_RESET_AFTER = 5      # failed joins in a row before a hardware reset

wlan = network.WLAN(network.STA_IF)
wifi_backoff = Backoff(base=1, cap=30)

def connect_wifi():
    """Join WiFi, however long it takes. Returns only once connected."""
    failures = 0
    while True:
        wdt.feed()
        try:
            wlan.active(True)
            print(f"[WiFi] Connecting to SSID: {WIFI_SSID}")
            wlan.connect(WIFI_SSID, WIFI_PASSWORD)
            deadline = time.time() + WIFI_JOIN_TIMEOUT
            while not wlan.isconnected():
                status = wlan.status()
                if status < 0:
                    # STAT_CONNECT_FAIL / STAT_NO_AP_FOUND / STAT_WRONG_PASSWORD
                    raise OSError(f"join failed, status {status}")
                if time.time() > deadline:
                    raise OSError("join timed out")
                wdt.feed()
                blink_led()
            print(f"[WiFi] Connected! IP: {wlan.ifconfig()[0]}")
            led.off()
            wifi_backoff.reset()
            return
        except Exception as e:
            failures += 1
            print(f"[WiFi] Join attempt {failures} failed: {e}")
            if failures >= WIFI_RESET_AFTER:
                print("[WiFi] Radio will not join; hardware reset")
                time.sleep(0.5)   # let the message leave the UART
                machine.reset()
            # Power the radio down between attempts: cheapest thing that
            # might clear a wedged chip short of a full reset.
            try: wlan.active(False)
            except Exception: pass
            delay = wifi_backoff.next()
            print(f"[WiFi] Retrying in {delay} second(s)...")
            sleep_fed(delay)

connect_wifi()

# Establish TCP connection to server. Backoff (1s, 2s, 4s ... capped at 30s)
# instead of a fixed 5s retry, so a Pi that is down for a while does not get
# hammered by every Pico in the building at once.
tcp_backoff = Backoff(base=1, cap=30)

def create_tcp_connection():
    attempt = 1
    while True:
        wdt.feed()
        if not wlan.isconnected():
            # WiFi dropped out from under us (AP rebooted, moved out of
            # range). No point retrying TCP until it is back.
            print("[WiFi] Link lost, rejoining before TCP")
            connect_wifi()
        try:
            print(f"[TCP] Connecting to {IP_ADDRESS}:{TCP_PORT} (attempt {attempt})")
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(SOCKET_TIMEOUT)
            sock.connect((IP_ADDRESS, TCP_PORT))
            led.on()
            print("[TCP] Connected successfully")
            tcp_backoff.reset()
            return sock
        except Exception as e:
            print(f"[TCP] Connection failed: {e}")
            try: sock.close()
            except: pass
            delay = tcp_backoff.next()
            print(f"[TCP] Retrying in {delay} second(s)...")
            sleep_fed(delay)
            attempt += 1

def tcp_send(sock, data):
    """Send all of data. Fed first, so a full SOCKET_TIMEOUT stall in here can
    never combine with another wait in the same pass to outlast the watchdog."""
    wdt.feed()
    send_all(sock, data)

def handle_server_event(sock, heartbeat, kind, value):
    """Act on one event from PicoLink.receive(). Only 'data' touches the UART."""
    if kind == 'data':
        uart1.write(value)
        print(f"[UART] Sent to UART: {safe_decode(value)!r}")
        blink_led()
    elif kind == 'pong':
        heartbeat.pong()
        print("[TCP] Heartbeat response: PONG")
    elif kind == 'send':
        tcp_send(sock, value)
    elif kind == 'registered':
        print(f"[TCP] Registered as '{value}' (fw {FIRMWARE_VERSION}, hash {MAIN_HASH})")
    elif kind == 'refused':
        raise RegistrationRefused(f'registration refused: {value}')
    elif kind == 'error':
        print(f"[TCP] Server reports error {value[0]}: {value[1]}")
    elif kind == 'ignored':
        print(f"[TCP] Ignoring opcode 0x{value:02x}, not implemented in this firmware")
    elif kind == 'close':
        raise OSError(value)

HEARTBEAT_INTERVAL = 10   # seconds between PINGs
HEARTBEAT_TIMEOUT = 5     # seconds to wait for one PONG (was 2, too tight for this wifi)
HEARTBEAT_MAX_MISSES = 3  # consecutive misses before we call the connection dead
REGISTER_TIMEOUT = 10     # seconds to wait for REGISTER_ACK before reconnecting
REFUSED_DELAY = 30        # extra seconds to wait after the Pi refused us; it will not change its mind in 1 s
RECV_SIZE = 256           # bytes per recv(); frames up to 1033 bytes arrive across several reads

while True:
    s = create_tcp_connection()
    poller = select.poll()
    poller.register(s, select.POLLIN)
    link = PicoLink(PICO_ID, FIRMWARE_VERSION, MAIN_HASH)
    heartbeat = HeartbeatMonitor(HEARTBEAT_INTERVAL, HEARTBEAT_TIMEOUT,
                                 HEARTBEAT_MAX_MISSES, now=time.time())
    extra_delay = 0

    # Everything from REGISTER onwards is inside the try: any failure closes
    # the socket and reconnects, and nothing can escape the outer loop.
    try:
        print(f"[TCP] Sending REGISTER for {PICO_ID}")
        tcp_send(s, link.register_frame())
        register_deadline = time.time() + REGISTER_TIMEOUT

        while True:
            wdt.feed()

            # UART -> server, as opaque DATA frames: the pty on the Pi gets
            # exactly the bytes the device sent, terminators and all. Nothing
            # is decoded on the way, so a malformed byte cannot raise here
            # (issue #19: "invalid UTF-8 doesn't disconnect"); safe_decode is
            # only used for the log line. Until REGISTER_ACK arrives the bytes
            # wait in the UART's own buffer, because DATA before the ack is
            # against the spec.
            if link.registered and uart1.any():
                try:
                    raw = uart1.read()
                except Exception as e:
                    print(f"[UART] Read error: {e}")
                    raw = None
                if raw:
                    print(f"[UART] Received: {safe_decode(raw)!r}")
                    for chunk in link.data_frames(raw):
                        tcp_send(s, chunk)
                    print(f"[TCP] Sent {len(raw)} byte(s) to server")
                    blink_led()

            # Server -> us. poll() sleeps until the socket has something or
            # POLL_TIMEOUT_MS passes, whichever is first. The decoder inside
            # PicoLink keeps partial frames between reads.
            for _, event in poller.poll(POLL_TIMEOUT_MS):
                if event & (select.POLLHUP | select.POLLERR):
                    raise OSError('socket reported hangup/error')
                if event & select.POLLIN:
                    data = s.recv(RECV_SIZE)
                    if not data:
                        raise OSError('server closed the connection')
                    for kind, value in link.receive(data):
                        handle_server_event(s, heartbeat, kind, value)

            now = time.time()
            if not link.registered and now > register_deadline:
                raise OSError(f'no REGISTER_ACK within {REGISTER_TIMEOUT} s')

            # Heartbeat. A lost PONG is not a lost connection: this wifi drops
            # packets, and dropping the socket on the first miss made the board
            # reconnect every ~40s all day. Only give up after several in a row.
            if heartbeat.ping_due(now):
                tcp_send(s, link.ping_frame())
                heartbeat.sent(now)
                print("[TCP] Sent heartbeat: PING")
            elif heartbeat.pong_overdue(now):
                if heartbeat.missed():
                    raise OSError(f'heartbeat lost: {heartbeat.misses} PONGs missed in a row')
                print(f"[TCP] Heartbeat missed {heartbeat.misses}/{HEARTBEAT_MAX_MISSES}, keeping the connection")

    except RegistrationRefused as e:
        print(f"[MAIN] {e}")
        print(f"[MAIN] Waiting {REFUSED_DELAY} s before trying again")
        extra_delay = REFUSED_DELAY
    except Exception as e:
        print(f"[MAIN] Lost connection: {e}")
        print("[MAIN] Reconnecting...")
    finally:
        try: poller.unregister(s)
        except: pass
        try: s.close()
        except: pass
        led.off()
        print("[TCP] Socket closed.")
        print(f"[MAIN] Restarting connection loop in {1 + extra_delay} second(s)...")
        sleep_fed(1 + extra_delay)
