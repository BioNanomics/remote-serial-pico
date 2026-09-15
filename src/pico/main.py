import network
import socket
import select
import time
import json
from machine import UART, Pin, WDT
from net_util import safe_decode, send_all, split_pongs, Backoff, HeartbeatMonitor

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

# Connect to Wi-Fi. wdt.feed() here too: on a very slow join, the loop below
# would otherwise not run for long enough to feed the watchdog in time.
wlan = network.WLAN(network.STA_IF)
wlan.active(True)
print(f"[WiFi] Connecting to SSID: {WIFI_SSID}")
wlan.connect(WIFI_SSID, WIFI_PASSWORD)
wifi_attempts = 0
while not wlan.isconnected():
    wdt.feed()
    blink_led()
    wifi_attempts += 1
    print(f"[WiFi] Waiting for connection... attempt {wifi_attempts}")
print(f"[WiFi] Connected! IP: {wlan.ifconfig()[0]}")
led.off()

# Establish TCP connection to server. Backoff (1s, 2s, 4s ... capped at 30s)
# instead of a fixed 5s retry, so a Pi that is down for a while does not get
# hammered by every Pico in the building at once.
tcp_backoff = Backoff(base=1, cap=30)

def create_tcp_connection():
    attempt = 1
    while True:
        wdt.feed()
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

# Send hello identification message
def send_hello_packet(sock):
    msg = f'pico_{PICO_ID}'
    print(f"[TCP] Sending hello: {msg}")
    tcp_send(sock, msg.encode())

HEARTBEAT_INTERVAL = 10   # seconds between PINGs
HEARTBEAT_TIMEOUT = 5     # seconds to wait for one PONG (was 2, too tight for this wifi)
HEARTBEAT_MAX_MISSES = 3  # consecutive misses before we call the connection dead

while True:
    s = create_tcp_connection()
    poller = select.poll()
    poller.register(s, select.POLLIN)
    heartbeat = HeartbeatMonitor(HEARTBEAT_INTERVAL, HEARTBEAT_TIMEOUT,
                                 HEARTBEAT_MAX_MISSES, now=time.time())

    # Everything from the hello onwards is inside the try: any failure closes
    # the socket and reconnects, and nothing can escape the outer loop.
    try:
        send_hello_packet(s)

        while True:
            wdt.feed()

            # UART -> server. safe_decode never raises on a malformed byte --
            # it swaps it for U+FFFD and keeps the rest of the line -- so one
            # noisy byte from the serial device can no longer end the loop
            # (issue #19: "invalid UTF-8 doesn't disconnect").
            rxed = ''
            if uart1.any():
                try:
                    rxed = safe_decode(uart1.read()).rstrip()
                except Exception as e:
                    print(f"[UART] Read error: {e}")
            if rxed:
                print(f"[UART] Received: '{rxed}'")
                tcp_send(s, rxed.encode())
                print(f"[TCP] Sent to server: '{rxed}'")
                blink_led()

            # Server -> UART. poll() sleeps until the socket has something or
            # POLL_TIMEOUT_MS passes, whichever is first. This replaces the old
            # setblocking(False)/recv/setblocking(True)/sleep(0.05) dance.
            for _, event in poller.poll(POLL_TIMEOUT_MS):
                if event & (select.POLLHUP | select.POLLERR):
                    raise OSError('socket reported hangup/error')
                if event & select.POLLIN:
                    data = s.recv(64)
                    if not data:
                        raise OSError('server closed the connection')
                    pongs, cmd = split_pongs(safe_decode(data))
                    if pongs:
                        heartbeat.pong()
                        print("[TCP] Heartbeat response: PONG")
                    if cmd:
                        print(f"[TCP] Command received: '{cmd}'")
                        uart1.write(cmd)
                        print(f"[UART] Sent to UART: '{cmd}'")
                        blink_led()

            # Heartbeat. A lost PONG is not a lost connection: this wifi drops
            # packets, and dropping the socket on the first miss made the board
            # reconnect every ~40s all day. Only give up after several in a row.
            now = time.time()
            if heartbeat.ping_due(now):
                tcp_send(s, b'PING')
                heartbeat.sent(now)
                print("[TCP] Sent heartbeat: PING")
            elif heartbeat.pong_overdue(now):
                if heartbeat.missed():
                    raise OSError(f'heartbeat lost: {heartbeat.misses} PONGs missed in a row')
                print(f"[TCP] Heartbeat missed {heartbeat.misses}/{HEARTBEAT_MAX_MISSES}, keeping the connection")

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
        print("[MAIN] Restarting connection loop in 1 second...")
        sleep_fed(1)
